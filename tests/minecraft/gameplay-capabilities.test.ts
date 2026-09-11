import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { Bot } from 'mineflayer'
import { createMineflayerRuntimeBundle } from '../../src/minecraft/runtime-bundle.js'

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
