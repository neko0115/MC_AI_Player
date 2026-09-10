import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { Bot } from 'mineflayer'
import { MineflayerAdapter } from '../../src/minecraft/mineflayer-adapter.js'

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

test('MineflayerAdapter exposes only semantic gameplay runtimes, never a raw Bot handle', async () => {
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
      reconnect: { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0 }
    }
  )

  const runtimes = adapter.createGameplayRuntimes()
  assert.deepEqual(Object.keys(runtimes).sort(), ['gathering', 'inventory'])
  assert.equal('bot' in runtimes, false)
  assert.deepEqual(runtimes.inventory.inventoryItems(), [])
  assert.equal(runtimes.gathering.currentPosition(), null)

  await adapter.connect()
  bot.emit('login')
  bot.emit('spawn')

  assert.deepEqual(runtimes.inventory.inventoryItems(), [{ name: 'bread', count: 2 }])
  assert.deepEqual(runtimes.gathering.currentPosition(), { x: 4, y: 64, z: -2 })
})
