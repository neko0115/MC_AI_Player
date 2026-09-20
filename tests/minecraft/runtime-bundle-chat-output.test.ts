import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMineflayerRuntimeBundle
} from '../../src/minecraft/runtime-bundle.js'
import {
  MINECRAFT_CHAT_OUTPUT_PORT,
  runtimePortRegistry
} from '../../src/minecraft/runtime-ports.js'

test('default mineflayer runtime registers bounded chat output without adding an enumerable raw bot surface', () => {
  const runtime =
    createMineflayerRuntimeBundle({
      host: 'localhost',
      port: 25565,
      username: 'Moxue_Test',
      auth: 'offline',
      logLevel: 'info'
    })

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

  assert.equal(
    ports.has(
      MINECRAFT_CHAT_OUTPUT_PORT
    ),
    true
  )
  assert.equal(
    ports.registeredIds().includes(
      'minecraft.chat_output'
    ),
    true
  )

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
})
