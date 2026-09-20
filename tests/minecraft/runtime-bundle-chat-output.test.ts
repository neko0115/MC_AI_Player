import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { Bot } from 'mineflayer'
import {
  createMineflayerRuntimeBundle
} from '../../src/minecraft/runtime-bundle.js'
import {
  MINECRAFT_CHAT_OUTPUT_PORT,
  runtimePortRegistry
} from '../../src/minecraft/runtime-ports.js'

class FakeInventory extends EventEmitter {
  items() {
    return []
  }
}

class FakeBot extends EventEmitter {
  readonly game = {
    dimension: 'overworld'
  }
  readonly entity = {
    position: {
      x: 0,
      y: 64,
      z: 0
    }
  }
  readonly inventory =
    new FakeInventory()
  readonly players = {}
  readonly username =
    'Moxue_Test'
  readonly sent: string[] = []
  health = 20
  food = 20

  chat(message: string): void {
    this.sent.push(message)
  }

  clearControlStates(): void {}

  quit(): void {
    this.emit(
      'end',
      'operator-disconnect'
    )
  }
}

test('default mineflayer runtime registers bounded chat output without adding an enumerable raw bot surface', async () => {
  const bot = new FakeBot()
  const runtime =
    createMineflayerRuntimeBundle(
      {
        host: 'localhost',
        port: 25565,
        username: 'Moxue_Test',
        auth: 'offline',
        logLevel: 'info'
      },
      {
        createBot: () =>
          bot as unknown as Bot
      }
    )

  assert.deepEqual(
    Object.keys(runtime).sort(),
    [
      'adapter',
      'gathering',
      'inventory'
    ]
  )

  const ports =
    runtimePortRegistry(runtime)
  const output =
    ports.require(
      MINECRAFT_CHAT_OUTPUT_PORT
    )

  assert.deepEqual(
    output.sendMessage(
      'spawn 前不應送出'
    ),
    {
      status: 'failed',
      code: 'minecraft_not_ready'
    }
  )

  await runtime.adapter.connect()
  bot.emit('login')
  bot.emit('spawn')

  assert.deepEqual(
    output.sendMessage(
      '好，我記住了。'
    ),
    {
      status: 'sent'
    }
  )
  assert.deepEqual(
    bot.sent,
    ['好，我記住了。']
  )

  await runtime.adapter.disconnect()
}
