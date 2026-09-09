import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { Bot } from 'mineflayer'
import { loadMinecraftConfig } from '../../src/config.js'
import {
  MineflayerAdapter,
  ReconnectPolicy,
  type MineflayerBotFactory
} from '../../src/minecraft/mineflayer-adapter.js'

class FakeInventory extends EventEmitter {
  items() {
    return [{ name: 'oak_log', count: 3, slot: 9 }]
  }
}

class FakeBot extends EventEmitter {
  readonly game = { dimension: 'overworld' }
  readonly entity = { position: { x: 0, y: 64, z: 0 } }
  readonly inventory = new FakeInventory()
  readonly players = {}
  health = 20
  food = 20
  clearControlStatesCount = 0
  quitCount = 0

  clearControlStates() {
    this.clearControlStatesCount += 1
  }

  quit() {
    this.quitCount += 1
    this.emit('end', 'operator-disconnect')
  }
}

class DeferredInventoryBot extends EventEmitter {
  readonly game = { dimension: 'overworld' }
  readonly entity = { position: { x: 0, y: 64, z: 0 } }
  readonly players = {}
  inventory: FakeInventory | undefined
  health = 20
  food = 20

  clearControlStates() {}

  quit() {
    this.emit('end', 'operator-disconnect')
  }
}

test('config accepts explicit offline test connection settings', () => {
  const config = loadMinecraftConfig({
    MC_HOST: '127.0.0.1',
    MC_PORT: '25565',
    MC_USERNAME: 'Moxue_Test',
    MC_AUTH: 'offline',
    MC_VERSION: '1.21.1'
  })

  assert.deepEqual(config, {
    host: '127.0.0.1',
    port: 25565,
    username: 'Moxue_Test',
    auth: 'offline',
    version: '1.21.1',
    logLevel: 'info'
  })
})

test('config rejects missing keys, invalid port and unsupported auth', () => {
  assert.throws(() => loadMinecraftConfig({}), /MC_HOST/)
  assert.throws(
    () =>
      loadMinecraftConfig({
        MC_HOST: 'localhost',
        MC_PORT: '70000',
        MC_USERNAME: 'Moxue_Test',
        MC_AUTH: 'offline'
      }),
    /MC_PORT/
  )
  assert.throws(
    () =>
      loadMinecraftConfig({
        MC_HOST: 'localhost',
        MC_PORT: '25565',
        MC_USERNAME: 'Moxue_Test',
        MC_AUTH: 'unknown'
      }),
    /MC_AUTH/
  )
})

test('reconnect policy is bounded exponential backoff', () => {
  const policy = new ReconnectPolicy({ maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 250 })

  assert.equal(policy.nextDelayMs(), 100)
  assert.equal(policy.nextDelayMs(), 200)
  assert.equal(policy.nextDelayMs(), 250)
  assert.equal(policy.nextDelayMs(), null)

  policy.reset()
  assert.equal(policy.nextDelayMs(), 100)
})

test('observation-only adapter emits normalized events and never initiates movement', async () => {
  const bots: FakeBot[] = []
  const factory: MineflayerBotFactory = () => {
    const bot = new FakeBot()
    bots.push(bot)
    return bot as unknown as Bot
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
      reconnect: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
      schedule: () => ({}) as ReturnType<typeof setTimeout>,
      cancelSchedule: () => undefined,
      now: () => 10
    }
  )
  const seen: string[] = []
  adapter.onEvent(event => seen.push(event.type))

  await adapter.connect()
  const bot = bots[0]
  assert.ok(bot)

  bot.emit('login')
  bot.emit('spawn')
  bot.emit('health')
  bot.inventory.emit('updateSlot', 9, null, { name: 'oak_log', count: 3, slot: 9 })
  bot.emit('chat', 'Boss', 'hello', null, {}, null)

  assert.deepEqual(seen, [
    'connected',
    'spawned',
    'health_changed',
    'inventory_changed',
    'player_chat'
  ])
  assert.equal(bot.clearControlStatesCount, 0)

  await adapter.stopMotion()
  assert.equal(bot.clearControlStatesCount, 1)

  await adapter.disconnect()
  assert.equal(bot.quitCount, 1)
})

test('inventory listener waits until spawn when Mineflayer injects inventory later', async () => {
  const bot = new DeferredInventoryBot()
  const factory: MineflayerBotFactory = () => bot as unknown as Bot
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
      now: () => 10
    }
  )
  const seen: string[] = []
  adapter.onEvent(event => seen.push(event.type))

  await assert.doesNotReject(adapter.connect())

  bot.inventory = new FakeInventory()
  bot.emit('login')
  bot.emit('spawn')
  bot.inventory.emit('updateSlot', 9, null, { name: 'oak_log', count: 3, slot: 9 })

  assert.deepEqual(seen, ['connected', 'spawned', 'inventory_changed'])
})
