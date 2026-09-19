import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { Bot } from 'mineflayer'
import { createMineflayerRuntimeBundle } from '../../src/minecraft/runtime-bundle.js'
import {
  defineRuntimePort,
  runtimePortRegistry
} from '../../src/minecraft/runtime-ports.js'

class FakeInventory extends EventEmitter {
  items() {
    return [{ name: 'bread', count: 2, slot: 9 }]
  }
}

class FakeBot extends EventEmitter {
  readonly game = { dimension: 'overworld' }
  readonly entity = { position: { x: 4, y: 64, z: -2 } }
  readonly inventory = new FakeInventory()
  readonly players = {}
  readonly username = 'Moxue_Test'
  health = 20
  food = 20

  clearControlStates() {}
  quit() {
    this.emit('end', 'operator-disconnect')
  }
}

test('Mineflayer runtime bundle exposes semantic gameplay interfaces, never a raw Bot handle', async () => {
  const bot = new FakeBot()
  const runtime = createMineflayerRuntimeBundle(
    {
      host: 'localhost',
      port: 25565,
      username: 'Moxue_Test',
      auth: 'offline',
      logLevel: 'info'
    },
    {
      createBot: () => bot as unknown as Bot
    }
  )

  assert.deepEqual(Object.keys(runtime).sort(), ['adapter', 'gathering', 'inventory'])
  assert.equal('bot' in runtime, false)
  assert.deepEqual(runtime.inventory.inventoryItems(), [])
  assert.equal(runtime.gathering.currentPosition(), null)

  await runtime.adapter.connect()
  bot.emit('login')
  bot.emit('spawn')

  assert.deepEqual(runtime.inventory.inventoryItems(), [{ name: 'bread', count: 2 }])
  assert.deepEqual(runtime.gathering.currentPosition(), { x: 4, y: 64, z: -2 })

  bot.emit('end', 'network-lost')
  assert.deepEqual(runtime.inventory.inventoryItems(), [])
  assert.equal(runtime.gathering.currentPosition(), null)
})


test('Mineflayer runtime extensions register typed ports without exposing raw Bot on the bundle', async () => {
  const bot = new FakeBot()
  const TEST_PORT = defineRuntimePort<{ readonly value: string }>(
    'test.semantic-port'
  )

  const runtime = createMineflayerRuntimeBundle(
    {
      host: 'localhost',
      port: 25565,
      username: 'Moxue_Test',
      auth: 'offline',
      logLevel: 'info'
    },
    {
      createBot: () => bot as unknown as Bot,
      extensions: [{
        id: 'test-extension',
        install({ readyBot, ports }) {
          assert.equal(readyBot(), null)
          ports.register(TEST_PORT, { value: 'ready' })
        }
      }]
    }
  )

  assert.deepEqual(
    Object.keys(runtime).sort(),
    ['adapter', 'gathering', 'inventory']
  )
  assert.equal('bot' in runtime, false)
  assert.equal(
    runtimePortRegistry(runtime).require(TEST_PORT).value,
    'ready'
  )
})

test('duplicate runtime extension ids fail before any extension installs', () => {
  const bot = new FakeBot()
  let installs = 0

  assert.throws(
    () => createMineflayerRuntimeBundle(
      {
        host: 'localhost',
        port: 25565,
        username: 'Moxue_Test',
        auth: 'offline',
        logLevel: 'info'
      },
      {
        createBot: () => bot as unknown as Bot,
        extensions: [
          { id: 'duplicate', install() { installs += 1 } },
          { id: 'duplicate', install() { installs += 1 } }
        ]
      }
    ),
    /duplicate Mineflayer runtime extension id/
  )
  assert.equal(installs, 0)
})
