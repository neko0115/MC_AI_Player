import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { Bot } from 'mineflayer'
import type { RuntimeEvent } from '../../src/contracts/events.js'
import {
  MineflayerAdapter,
  type MineflayerBotFactory
} from '../../src/minecraft/mineflayer-adapter.js'

class FakeInventory extends EventEmitter {
  items() {
    return []
  }
}

class IdentityBot extends EventEmitter {
  readonly game = { dimension: 'overworld' }
  readonly entity = { position: { x: 0, y: 64, z: 0 } }
  readonly inventory = new FakeInventory()
  readonly players: Record<string, unknown> = {
    Boss: {
      username: 'Boss',
      uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      entity: { position: { x: 2, y: 64, z: 0 } }
    }
  }
  readonly username = 'Neko0115'
  health = 20
  food = 20

  clearControlStates() {}

  quit() {
    this.emit('end', 'operator-disconnect')
  }
}

test('Mineflayer chat carries current UUID evidence and playerLeft emits invalidation evidence', async () => {
  const bot = new IdentityBot()
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
  const seen: RuntimeEvent[] = []
  adapter.onEvent(event => {
    seen.push(structuredClone(event))
  })

  await adapter.connect()
  bot.emit('login')
  bot.emit('chat', 'Boss', 'hello', null, {}, null)
  bot.emit('playerLeft', {
    username: 'Boss',
    uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    entity: { position: { x: 2, y: 64, z: 0 } }
  })

  assert.deepEqual(
    seen.filter(event => event.type === 'player_chat' || event.type === 'player_left'),
    [
      {
        type: 'player_chat',
        at: 10,
        player: 'Boss',
        playerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        message: 'hello'
      },
      {
        type: 'player_left',
        at: 10,
        player: 'Boss',
        playerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      }
    ]
  )
})


test('authenticated profile self is excluded from playerJoined and playerUpdated observations', async () => {
  const bot = new IdentityBot()
  const factory: MineflayerBotFactory = () => bot as unknown as Bot
  const adapter = new MineflayerAdapter(
    {
      host: 'localhost',
      port: 25565,
      // Microsoft auth may resolve this cache/account label to a different
      // actual Minecraft profile name exposed by bot.username.
      username: 'Moxue_Test',
      auth: 'microsoft',
      logLevel: 'info'
    },
    {
      createBot: factory,
      reconnect: { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0 },
      now: () => 20
    }
  )
  const seen: RuntimeEvent[] = []
  adapter.onEvent(event => {
    seen.push(structuredClone(event))
  })

  await adapter.connect()
  bot.emit('login')

  const selfPlayer = {
    username: 'Neko0115',
    uuid: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    entity: { position: { x: 0, y: 64, z: 0 } }
  }
  bot.emit('playerJoined', selfPlayer)
  bot.emit('playerUpdated', selfPlayer)

  const otherPlayer = {
    username: 'Boss',
    uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    entity: { position: { x: 2, y: 64, z: 0 } }
  }
  bot.emit('playerJoined', otherPlayer)

  assert.deepEqual(
    seen.filter(event => event.type === 'player_seen'),
    [{
      type: 'player_seen',
      at: 20,
      player: {
        name: 'Boss',
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        position: { x: 2, y: 64, z: 0 }
      }
    }]
  )
})
