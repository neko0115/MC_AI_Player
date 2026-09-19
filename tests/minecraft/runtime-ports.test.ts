import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RuntimePortRegistry,
  defineRuntimePort
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

test('runtime port ids are bounded semantic identifiers', () => {
  assert.throws(
    () => defineRuntimePort('Bad Port'),
    /invalid runtime port id/
  )
})
