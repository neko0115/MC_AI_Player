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
  movements: unknown = null

  setMovements(movements: unknown) {
    this.movements = movements
  }

  async goto() {}

  stop() {}
}

class LeafSafetyBot extends EventEmitter {
  readonly game = { dimension: 'overworld' }
  readonly entity = { position: { x: 0, y: 64, z: 0 } }
  readonly inventory = new FakeInventory()
  readonly username = 'Moxue_Test'
  readonly players = {}
  readonly pathfinder = new FakePathfinder()
  readonly registry = {
    blocksByName: {
      stone: { id: 1, name: 'stone' },
      oak_leaves: { id: 10, name: 'oak_leaves' },
      spruce_leaves: { id: 11, name: 'spruce_leaves' },
      birch_leaves: { id: 12, name: 'birch_leaves' }
    }
  }
  health = 20
  food = 20

  clearControlStates() {}
  quit() {
    this.emit('end', 'operator-disconnect')
  }
}

test('hardened navigation avoids leaf blocks instead of routing onto tree canopies', async () => {
  const bot = new LeafSafetyBot()
  const factory: MineflayerBotFactory = () => bot as unknown as Bot
  const movementView = {
    canDig: true,
    scafoldingBlocks: [1],
    allow1by1towers: true,
    blocksToAvoid: new Set<number>()
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
      loadPathfinder: () => {},
      createMovements: () => movementView as unknown as Movements
    }
  )

  await adapter.connect()
  bot.emit('login')
  bot.emit('spawn')

  const result = await adapter.goTo(
    { x: 8, y: 64, z: 0 },
    { range: 1, canDig: false },
    new AbortController().signal
  )

  assert.deepEqual(result, { status: 'succeeded', code: 'reached' })
  assert.equal(movementView.blocksToAvoid.has(10), true)
  assert.equal(movementView.blocksToAvoid.has(11), true)
  assert.equal(movementView.blocksToAvoid.has(12), true)
  assert.equal(movementView.blocksToAvoid.has(1), false)
})
