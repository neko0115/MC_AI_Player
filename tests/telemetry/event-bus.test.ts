import assert from 'node:assert/strict'
import test from 'node:test'
import { RuntimeEventBus } from '../../src/telemetry/event-bus.js'

test('event bus preserves publish order', async () => {
  const bus = new RuntimeEventBus()
  const seen: string[] = []

  bus.subscribe(event => {
    seen.push(event.type)
  })

  await bus.publish({ type: 'connected', at: 1 })
  await bus.publish({
    type: 'spawned',
    at: 2,
    dimension: 'overworld',
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20
  })

  assert.deepEqual(seen, ['connected', 'spawned'])
})

test('unsubscribe stops future delivery', async () => {
  const bus = new RuntimeEventBus()
  const seen: string[] = []
  const unsubscribe = bus.subscribe(event => {
    seen.push(event.type)
  })

  await bus.publish({ type: 'connected', at: 1 })
  unsubscribe()
  await bus.publish({ type: 'disconnected', at: 2, reason: 'test' })

  assert.deepEqual(seen, ['connected'])
})
