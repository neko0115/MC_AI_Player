import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MINECRAFT_CHAT_OUTPUT_PORT,
  RuntimePortRegistry,
  SURVIVAL_INVENTORY_PORT,
  defineRuntimePort,
  runtimePortRegistry
} from '../../src/minecraft/runtime-ports.js'

test('runtime port registry preserves token type and rejects duplicate ids', () => {
  const registry = new RuntimePortRegistry()
  const textPort = defineRuntimePort<{ readonly text: string }>(
    'test.text'
  )
  const duplicateId = defineRuntimePort<number>('test.text')

  registry.register(textPort, { text: 'hello' })

  assert.equal(registry.require(textPort).text, 'hello')
  assert.deepEqual(registry.registeredIds(), ['test.text'])
  assert.throws(
    () => registry.register(duplicateId, 42),
    /runtime port already registered: test.text/
  )
})

test('runtime port registry fails closed for an unregistered token', () => {
  const registry = new RuntimePortRegistry()
  const port = defineRuntimePort<number>('test.missing')

  assert.equal(registry.has(port), false)
  assert.throws(
    () => registry.require(port),
    /runtime port not registered: test.missing/
  )
})

test('chat output is a typed bounded runtime capability token', () => {
  assert.equal(
    MINECRAFT_CHAT_OUTPUT_PORT.id,
    'minecraft.chat_output'
  )
})

test('runtime port ids are bounded semantic identifiers', () => {
  assert.throws(
    () => defineRuntimePort('Bad Port'),
    /invalid runtime port id/
  )
})


test('legacy semantic runtime bundles are adapted into typed ports', () => {
  const inventory = {
    inventoryItems: () => [],
    async consumeInventoryItem() {
      return { status: 'failed' as const, code: 'not_available' }
    },
    async equipInventoryItem() {
      return { status: 'failed' as const, code: 'not_available' }
    },
    async transferContainerItem() {
      return { status: 'failed' as const, code: 'not_available' }
    }
  }

  const registry = runtimePortRegistry({ inventory })

  assert.equal(
    registry.require(SURVIVAL_INVENTORY_PORT),
    inventory
  )
})
