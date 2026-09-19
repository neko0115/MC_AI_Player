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
  readonly username = 'Moxue_Test'
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
  readonly username = 'Moxue_Test'
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
    'inventory_changed',
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

test('self movement emits at most one position update per Minecraft block cell', async () => {
  const bot = new FakeBot()
  const adapter = new MineflayerAdapter(
    {
      host: 'localhost',
      port: 25565,
      username: 'Moxue_Test',
      auth: 'offline',
      logLevel: 'info'
    },
    {
      createBot: () => bot as unknown as Bot,
      reconnect: { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0 },
      now: () => 10
    }
  )
  const seen: Array<Record<string, unknown>> = []
  adapter.onEvent(event => {
    seen.push(structuredClone(event) as unknown as Record<string, unknown>)
  })

  await adapter.connect()
  bot.emit('login')
  bot.emit('spawn')

  bot.entity.position.x = 0.2
  bot.emit('move')
  bot.entity.position.x = 0.8
  bot.emit('move')
  bot.entity.position.x = 1.1
  bot.emit('move')
  bot.entity.position.x = 1.9
  bot.emit('move')

  assert.deepEqual(
    seen.filter(event => event.type === 'position_changed'),
    [{
      type: 'position_changed',
      at: 10,
      position: { x: 1.1, y: 64, z: 0 }
    }]
  )
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

  assert.deepEqual(seen, [
    'connected',
    'spawned',
    'inventory_changed',
    'inventory_changed'
  ])
})

test('definitely hostile mobs are observed by block cell while neutral mobs are ignored', async () => {
  const bot = new FakeBot()
  const adapter = new MineflayerAdapter(
    {
      host: 'localhost',
      port: 25565,
      username: 'Moxue_Test',
      auth: 'offline',
      logLevel: 'info'
    },
    {
      createBot: () => bot as unknown as Bot,
      reconnect: { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0 },
      now: () => 10
    }
  )
  const seen: Array<Record<string, unknown>> = []
  adapter.onEvent(event => {
    if (
      event.type === 'hostile_seen' ||
      event.type === 'hostile_left'
    ) {
      seen.push(structuredClone(event) as unknown as Record<string, unknown>)
    }
  })

  await adapter.connect()
  bot.emit('login')
  bot.emit('spawn')

  const creeper = {
    id: 7,
    type: 'mob',
    name: 'creeper',
    position: { x: 5.2, y: 64, z: 0 }
  }
  bot.emit('entitySpawn', creeper)
  creeper.position.x = 5.8
  bot.emit('entityMoved', creeper)
  creeper.position.x = 4.9
  bot.emit('entityMoved', creeper)

  bot.emit('entitySpawn', {
    id: 8,
    type: 'mob',
    name: 'enderman',
    position: { x: 3, y: 64, z: 0 }
  })

  bot.emit('entityGone', creeper)

  assert.deepEqual(seen, [
    {
      type: 'hostile_seen',
      at: 10,
      hostile: {
        entityId: 7,
        kind: 'creeper',
        position: { x: 5.2, y: 64, z: 0 }
      }
    },
    {
      type: 'hostile_seen',
      at: 10,
      hostile: {
        entityId: 7,
        kind: 'creeper',
        position: { x: 4.9, y: 64, z: 0 }
      }
    },
    {
      type: 'hostile_left',
      at: 10,
      entityId: 7
    }
  ])
})

test('modern hostile entity classification emits hostile observations', async () => {
  const bot = new FakeBot()
  const adapter = new MineflayerAdapter(
    {
      host: 'localhost',
      port: 25565,
      username: 'Moxue_Test',
      auth: 'offline',
      logLevel: 'info'
    },
    {
      createBot: () => bot as unknown as Bot,
      reconnect: { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0 },
      now: () => 10
    }
  )
  const seen: Array<Record<string, unknown>> = []
  adapter.onEvent(event => {
    if (event.type === 'hostile_seen') {
      seen.push(structuredClone(event) as unknown as Record<string, unknown>)
    }
  })

  await adapter.connect()
  bot.emit('login')
  bot.emit('spawn')

  bot.emit('entitySpawn', {
    id: 9,
    type: 'hostile',
    name: 'zombie',
    position: { x: 3, y: 64, z: 0 }
  })

  assert.deepEqual(seen, [{
    type: 'hostile_seen',
    at: 10,
    hostile: {
      entityId: 9,
      kind: 'zombie',
      position: { x: 3, y: 64, z: 0 }
    }
  }])
})

test('player info without entity waits for player entitySpawn before emitting player_seen', async () => {
  const bot = new FakeBot()
  const adapter = new MineflayerAdapter(
    {
      host: 'localhost',
      port: 25565,
      username: 'Moxue_Test',
      auth: 'offline',
      logLevel: 'info'
    },
    {
      createBot: () => bot as unknown as Bot,
      reconnect: { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0 },
      now: () => 10
    }
  )
  const seen: Array<{ type: string; name?: string }> = []
  adapter.onEvent(event => {
    seen.push({
      type: event.type,
      ...(event.type === 'player_seen' ? { name: event.player.name } : {})
    })
  })

  await adapter.connect()
  assert.doesNotThrow(() => {
    bot.emit('playerJoined', {
      username: 'Boss',
      uuid: 'player-uuid',
      entity: undefined
    })
  })
  assert.equal(seen.some(event => event.type === 'player_seen'), false)

  bot.emit('entitySpawn', {
    type: 'player',
    username: 'Boss',
    uuid: 'player-uuid',
    position: { x: 3, y: 64, z: 4 }
  })

  assert.deepEqual(seen, [{ type: 'player_seen', name: 'Boss' }])
})
