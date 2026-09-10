import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { Bot } from 'mineflayer'
import type { Movements } from 'mineflayer-pathfinder'
import { MineflayerAdapter, type MineflayerBotFactory } from '../../src/minecraft/mineflayer-adapter.js'

class FakeInventory extends EventEmitter {
  items() {
    return []
  }
}

class FakePathfinder {
  thinkTimeout = 5000
  tickTimeout = 40
  searchRadius = -1
  goal: unknown = null
  movements: unknown = null
  stopCount = 0
  lastDynamic = false
  private rejectGoto: ((error: Error) => void) | null = null
  gotoMode: 'resolve' | 'pending' = 'resolve'

  setMovements(movements: unknown) {
    this.movements = movements
  }

  async goto(goal: unknown): Promise<void> {
    this.goal = goal
    if (this.gotoMode === 'resolve') return
    return new Promise<void>((_resolve, reject) => {
      this.rejectGoto = reject
    })
  }

  setGoal(goal: unknown, dynamic = false) {
    this.goal = goal
    this.lastDynamic = dynamic
  }

  stop() {
    this.stopCount += 1
    this.goal = null
    const reject = this.rejectGoto
    this.rejectGoto = null
    if (reject) {
      const error = new Error('stopped')
      error.name = 'PathStopped'
      reject(error)
    }
  }
}

class NavigationFakeBot extends EventEmitter {
  readonly game = { dimension: 'overworld' }
  readonly entity = {
    position: { x: 0, y: 64, z: 0 },
    velocity: { x: 0, y: 0, z: 0 }
  }
  readonly inventory = new FakeInventory()
  readonly players: Record<string, { entity?: unknown }> = {
    Boss: {
      entity: {
        type: 'player',
        username: 'Boss',
        position: { x: 5, y: 64, z: 5 }
      }
    }
  }
  readonly username = 'Moxue_Test'
  readonly pathfinder = new FakePathfinder()
  health = 20
  food = 20
  clearControlStatesCount = 0

  clearControlStates() {
    this.clearControlStatesCount += 1
  }

  quit() {
    this.emit('end', 'operator-disconnect')
  }
}

function createNavigationHarness() {
  const bot = new NavigationFakeBot()
  const factory: MineflayerBotFactory = () => bot as unknown as Bot
  let loadCount = 0
  let movementsCount = 0
  const movementView = {
    canDig: true,
    scafoldingBlocks: [1, 2],
    allow1by1towers: true
  }
  const adapter = new MineflayerAdapter(
    {
      host: 'localhost',
      port: 25565,
      username: 'Moxue_Test',
      auth: 'offline',
      logLevel: 'info'
    },
    {
      createBot: factory,
      reconnect: { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0 },
      loadPathfinder: () => {
        loadCount += 1
      },
      createMovements: () => {
        movementsCount += 1
        return movementView as unknown as Movements
      }
    }
  )

  return {
    adapter,
    bot,
    movementView,
    loadCount: () => loadCount,
    movementsCount: () => movementsCount
  }
}

async function spawnHarness(harness: ReturnType<typeof createNavigationHarness>) {
  await harness.adapter.connect()
  harness.bot.emit('login')
  harness.bot.emit('spawn')
}

test('goTo lazily initializes a hardened pathfinder with bounded budgets', async () => {
  const harness = createNavigationHarness()
  await spawnHarness(harness)

  const result = await harness.adapter.goTo(
    { x: 10, y: 65, z: -3 },
    { range: 2, canDig: false },
    new AbortController().signal
  )

  assert.deepEqual(result, { status: 'succeeded', code: 'reached' })
  assert.equal(harness.loadCount(), 1)
  assert.equal(harness.movementsCount(), 1)
  assert.equal(harness.bot.pathfinder.thinkTimeout, 3000)
  assert.equal(harness.bot.pathfinder.tickTimeout, 25)
  assert.equal(harness.bot.pathfinder.searchRadius, 96)
  assert.equal(harness.movementView.canDig, false)
  assert.deepEqual(harness.movementView.scafoldingBlocks, [])
  assert.equal(harness.movementView.allow1by1towers, false)
  assert.equal(harness.bot.pathfinder.movements, harness.movementView)
  assert.equal((harness.bot.pathfinder.goal as { constructor?: { name?: string } })?.constructor?.name, 'GoalNear')
})

test('aborting goTo stops pathfinder and returns structured cancellation', async () => {
  const harness = createNavigationHarness()
  await spawnHarness(harness)
  harness.bot.pathfinder.gotoMode = 'pending'
  const controller = new AbortController()

  const running = harness.adapter.goTo(
    { x: 20, y: 64, z: 20 },
    { range: 1, canDig: false },
    controller.signal
  )
  controller.abort('player_preempted')

  assert.deepEqual(await running, {
    status: 'cancelled',
    code: 'player_preempted'
  })
  assert.equal(harness.bot.pathfinder.stopCount, 1)
  assert.equal(harness.bot.pathfinder.goal, null)
})

test('pathfinder stuck becomes a structured failure and emits a stuck event', async () => {
  const harness = createNavigationHarness()
  await spawnHarness(harness)
  harness.bot.pathfinder.gotoMode = 'pending'
  const seen: string[] = []
  harness.adapter.onEvent(event => seen.push(event.type))

  const running = harness.adapter.goTo(
    { x: 20, y: 64, z: 20 },
    { range: 1, canDig: false },
    new AbortController().signal
  )
  harness.bot.emit('path_reset', 'stuck')

  assert.deepEqual(await running, { status: 'failed', code: 'stuck' })
  assert.equal(harness.bot.pathfinder.stopCount, 1)
  assert.ok(seen.includes('stuck'))
})

test('followPlayer uses a dynamic GoalFollow until cancellation', async () => {
  const harness = createNavigationHarness()
  await spawnHarness(harness)
  const controller = new AbortController()

  const running = harness.adapter.followPlayer('Boss', 3, controller.signal)
  assert.equal(harness.bot.pathfinder.lastDynamic, true)
  assert.equal((harness.bot.pathfinder.goal as { constructor?: { name?: string } })?.constructor?.name, 'GoalFollow')

  controller.abort('follow_preempted')
  assert.deepEqual(await running, {
    status: 'cancelled',
    code: 'follow_preempted'
  })
  assert.equal(harness.bot.pathfinder.goal, null)
})

test('followPlayer fails closed when the target has no positioned entity', async () => {
  const harness = createNavigationHarness()
  await spawnHarness(harness)

  assert.deepEqual(
    await harness.adapter.followPlayer('MissingPlayer', 3, new AbortController().signal),
    { status: 'failed', code: 'player_not_found' }
  )
  assert.equal(harness.loadCount(), 0)
})
