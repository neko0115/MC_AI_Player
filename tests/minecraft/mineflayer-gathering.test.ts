import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { Vec3 } from 'vec3'
import type { Bot } from 'mineflayer'
import type { ResourceMutationPermit } from '../../src/safety/policy.js'
import { SafetyPolicy } from '../../src/safety/policy.js'
import { MineflayerGatheringRuntime } from '../../src/minecraft/mineflayer-gathering.js'
import type { ResourceCandidate } from '../../src/minecraft/gathering.js'
import type { WorldStateSnapshot } from '../../src/state/world-state.js'

interface FakeItem {
  name: string
  count: number
  type: number
}

class FakeBot extends EventEmitter {
  entity = { position: new Vec3(0, 64, 0) }
  inventoryItems: FakeItem[] = []
  digCount = 0
  stopDiggingCount = 0
  blockName = 'oak_log'
  searchPositions = [new Vec3(4, 64, 0)]
  canDig = true
  harvestTools: Readonly<Record<string, boolean>> | undefined
  equippedItem: FakeItem | null = null
  readonly controlStates: Array<{ state: string; enabled: boolean }> = []

  inventory = {
    items: () => this.inventoryItems
  }

  findBlocks(options: {
    point?: Vec3
    matching: (block: { name: string }) => boolean
    maxDistance?: number
    count?: number
  }): Vec3[] {
    const block = { name: this.blockName }
    return options.matching(block)
      ? this.searchPositions.slice(0, options.count ?? this.searchPositions.length)
      : []
  }

  blockAt(position: Vec3) {
    return {
      name: this.blockName,
      position: position.clone(),
      ...(this.harvestTools ? { harvestTools: this.harvestTools } : {})
    }
  }

  canDigBlock() {
    return this.canDig
  }

  async dig() {
    this.digCount += 1
    const existing = this.inventoryItems.find(item => item.name === this.blockName)
    if (existing) existing.count += 1
    else this.inventoryItems.push({ name: this.blockName, count: 1, type: 999 })
  }

  async equip(item: FakeItem) {
    this.equippedItem = item
  }

  setControlState(state: string, enabled: boolean) {
    this.controlStates.push({ state, enabled })
  }

  stopDigging() {
    this.stopDiggingCount += 1
  }
}

function readyState(): WorldStateSnapshot {
  return {
    connected: true,
    spawned: true,
    health: 20,
    food: 20,
    dimension: 'overworld',
    position: { x: 0, y: 64, z: 0 },
    nearbyPlayers: [],
    inventory: [],
    recentEvents: []
  }
}

function issuedPermit(blockName = 'oak_log') {
  const result = new SafetyPolicy().issueResourceMutationPermit(
    'gather_resource',
    [blockName],
    { capabilities: ['break_blocks'] },
    readyState()
  )
  assert.equal(result.kind, 'allow')
  if (result.kind !== 'allow') throw new Error('permit not issued')
  return result.permit
}

const oak: ResourceCandidate = {
  blockName: 'oak_log',
  position: { x: 4, y: 64, z: 0 }
}

test('bounded Mineflayer search returns semantic resource candidates', async () => {
  const bot = new FakeBot()
  const runtime = new MineflayerGatheringRuntime(() => bot as unknown as Bot)

  const result = await runtime.findResourceBlocks(
    {
      blockNames: ['oak_log'],
      origin: { x: 0, y: 64, z: 0 },
      radius: 16,
      limit: 4
    },
    new AbortController().signal
  )

  assert.deepEqual(result, [oak])
  assert.deepEqual(runtime.currentPosition(), { x: 0, y: 64, z: 0 })
})

test('forged mutation permit cannot reach bot.dig', async () => {
  const bot = new FakeBot()
  const runtime = new MineflayerGatheringRuntime(() => bot as unknown as Bot)
  const forged = {
    mutateBlocks: true,
    allowedBlockNames: ['oak_log']
  } as ResourceMutationPermit

  const result = await runtime.harvestResourceBlock(
    oak,
    forged,
    new AbortController().signal
  )

  assert.deepEqual(result, { status: 'failed', code: 'mutation_not_permitted' })
  assert.equal(bot.digCount, 0)
})

test('permit scope mismatch cannot reach bot.dig', async () => {
  const bot = new FakeBot()
  const runtime = new MineflayerGatheringRuntime(() => bot as unknown as Bot)

  const result = await runtime.harvestResourceBlock(
    { blockName: 'birch_log', position: oak.position },
    issuedPermit('oak_log'),
    new AbortController().signal
  )

  assert.deepEqual(result, { status: 'failed', code: 'mutation_not_permitted' })
  assert.equal(bot.digCount, 0)
})

test('changed target block fails closed before digging', async () => {
  const bot = new FakeBot()
  bot.blockName = 'stone'
  const runtime = new MineflayerGatheringRuntime(() => bot as unknown as Bot)

  const result = await runtime.harvestResourceBlock(
    oak,
    issuedPermit(),
    new AbortController().signal
  )

  assert.deepEqual(result, { status: 'failed', code: 'resource_changed' })
  assert.equal(bot.digCount, 0)
})

test('issued scoped permit allows one matching resource harvest and confirms collection', async () => {
  const bot = new FakeBot()
  const runtime = new MineflayerGatheringRuntime(() => bot as unknown as Bot)

  const result = await runtime.harvestResourceBlock(
    oak,
    issuedPermit(),
    new AbortController().signal
  )

  assert.deepEqual(result, { status: 'succeeded', code: 'collected' })
  assert.equal(bot.digCount, 1)
  assert.equal(runtime.inventoryCount('oak_log'), 1)
})


test('capability tool preparation equips one tool accepted by the target block', async () => {
  const bot = new FakeBot()
  bot.harvestTools = { '257': true }
  bot.inventoryItems.push(
    { name: 'stick', count: 2, type: 280 },
    { name: 'iron_pickaxe', count: 1, type: 257 }
  )
  const runtime = new MineflayerGatheringRuntime(() => bot as unknown as Bot)

  const result = await runtime.prepareResourceTool(
    oak,
    new AbortController().signal
  )

  assert.deepEqual(result, { status: 'succeeded', code: 'correct_tool_equipped' })
  assert.equal(bot.equippedItem?.name, 'iron_pickaxe')
})

test('sneak harvest always releases the sneak control state after digging', async () => {
  const bot = new FakeBot()
  const runtime = new MineflayerGatheringRuntime(() => bot as unknown as Bot)

  const result = await runtime.harvestResourceBlock(
    oak,
    issuedPermit(),
    new AbortController().signal,
    { sneak: true }
  )

  assert.deepEqual(result, { status: 'succeeded', code: 'collected' })
  assert.deepEqual(bot.controlStates, [
    { state: 'sneak', enabled: true },
    { state: 'sneak', enabled: false }
  ])
})

test('aborted harvest never digs and an abort during dig invokes stopDigging', async () => {
  const bot = new FakeBot()
  const runtime = new MineflayerGatheringRuntime(() => bot as unknown as Bot)
  const preAborted = new AbortController()
  preAborted.abort('operator_stop')

  const early = await runtime.harvestResourceBlock(oak, issuedPermit(), preAborted.signal)
  assert.deepEqual(early, { status: 'cancelled', code: 'operator_stop' })
  assert.equal(bot.digCount, 0)

  let releaseDig!: () => void
  bot.dig = async () => {
    bot.digCount += 1
    await new Promise<void>(resolve => {
      releaseDig = resolve
    })
  }
  const controller = new AbortController()
  const pending = runtime.harvestResourceBlock(oak, issuedPermit(), controller.signal)
  await Promise.resolve()
  controller.abort('emergency_stop')
  releaseDig()

  const result = await pending
  assert.deepEqual(result, { status: 'cancelled', code: 'emergency_stop' })
  assert.equal(bot.stopDiggingCount, 1)
})
