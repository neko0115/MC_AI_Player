import assert from 'node:assert/strict'
import test from 'node:test'
import type { RuntimeEvent } from '../../src/contracts/events.js'
import { WorldStateCache } from '../../src/state/world-state-cache.js'

test('recent events keep only the configured maximum', () => {
  const cache = new WorldStateCache({ maxRecentEvents: 2 })

  cache.apply({ type: 'connected', at: 1 })
  cache.apply({
    type: 'spawned',
    at: 2,
    dimension: 'overworld',
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20
  })
  cache.apply({ type: 'player_chat', at: 3, player: 'Boss', message: 'hello' })

  assert.deepEqual(cache.snapshot().recentEvents.map(event => event.at), [2, 3])
})

test('position update replaces the spawned self position', () => {
  const cache = new WorldStateCache({ maxRecentEvents: 10 })
  cache.apply({ type: 'connected', at: 1 })
  cache.apply({
    type: 'spawned',
    at: 2,
    dimension: 'overworld',
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20
  })

  cache.apply({
    type: 'position_changed',
    at: 3,
    position: { x: 12.25, y: 65, z: -4.5 }
  } as unknown as RuntimeEvent)

  assert.deepEqual(cache.snapshot().position, { x: 12.25, y: 65, z: -4.5 })
})

test('nearby players replace by identity instead of growing forever', () => {
  const cache = new WorldStateCache({ maxRecentEvents: 10 })

  cache.apply({
    type: 'player_seen',
    at: 1,
    player: { name: 'Boss', id: 'player-1', position: { x: 1, y: 64, z: 1 } }
  })
  cache.apply({
    type: 'player_seen',
    at: 2,
    player: { name: 'Boss', id: 'player-1', position: { x: 5, y: 64, z: 5 } }
  })

  const players = cache.snapshot().nearbyPlayers
  assert.equal(players.length, 1)
  assert.deepEqual(players[0]?.position, { x: 5, y: 64, z: 5 })
})

test('inventory is a current snapshot rather than an append-only history', () => {
  const cache = new WorldStateCache({ maxRecentEvents: 10 })

  cache.apply({ type: 'inventory_changed', at: 1, items: [{ name: 'oak_log', count: 4 }] })
  cache.apply({ type: 'inventory_changed', at: 2, items: [{ name: 'stone', count: 16 }] })

  assert.deepEqual(cache.snapshot().inventory, [{ name: 'stone', count: 16 }])
})

test('disconnect clears transient world state', () => {
  const cache = new WorldStateCache({ maxRecentEvents: 10 })
  cache.apply({ type: 'connected', at: 1 })
  cache.apply({
    type: 'spawned',
    at: 2,
    dimension: 'overworld',
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20
  })
  cache.apply({
    type: 'player_seen',
    at: 3,
    player: { name: 'Boss', position: { x: 2, y: 64, z: 2 } }
  })
  cache.apply({ type: 'inventory_changed', at: 4, items: [{ name: 'oak_log', count: 4 }] })

  cache.apply({ type: 'disconnected', at: 5, reason: 'test' })
  const state = cache.snapshot()

  assert.equal(state.connected, false)
  assert.equal(state.spawned, false)
  assert.equal(state.dimension, null)
  assert.equal(state.position, null)
  assert.deepEqual(state.nearbyPlayers, [])
  assert.deepEqual(state.inventory, [])
})
