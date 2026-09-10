import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SqliteMemoryRepository
} from '../../src/memory/sqlite-repository.js'
import type {
  MinecraftMemoryInput
} from '../../src/memory/repository.js'

function memory(overrides: Partial<MinecraftMemoryInput> = {}): MinecraftMemoryInput {
  return {
    type: 'resource',
    content: 'Oak forest east of base',
    dimension: 'overworld',
    position: { x: 5, y: 64, z: 0 },
    tags: ['wood', 'oak'],
    importance: 0.6,
    observedAt: 100,
    ...overrides
  }
}

test('exact duplicate reinforces one row instead of inserting a duplicate', () => {
  let now = 1_000
  const repo = new SqliteMemoryRepository(':memory:', { now: () => now++ })
  try {
    const first = repo.remember(memory())
    const reinforced = repo.remember(memory({ importance: 0.8, observedAt: 200 }))
    const all = repo.search({ text: 'Oak forest', limit: 10 })

    assert.equal(reinforced.id, first.id)
    assert.equal(reinforced.reinforcementCount, 1)
    assert.equal(reinforced.importance, 0.8)
    assert.equal(reinforced.observedAt, 200)
    assert.equal(all.length, 1)
    assert.equal(all[0]?.id, first.id)
  } finally {
    repo.close()
  }
})

test('search supports bounded coordinate, dimension, type and tag filters', () => {
  const repo = new SqliteMemoryRepository(':memory:')
  try {
    repo.remember(memory({
      type: 'storage',
      content: 'Main food chest',
      position: { x: 1, y: 64, z: 0 },
      tags: ['base', 'food'],
      observedAt: 10
    }))
    repo.remember(memory({
      type: 'resource',
      content: 'Nearby oak forest',
      position: { x: 7, y: 64, z: 0 },
      tags: ['wood'],
      observedAt: 20
    }))
    repo.remember(memory({
      type: 'hazard',
      content: 'Lava ravine',
      position: { x: 30, y: 50, z: 0 },
      tags: ['lava'],
      observedAt: 30
    }))
    repo.remember(memory({
      type: 'landmark',
      content: 'Nether portal',
      dimension: 'the_nether',
      position: { x: 0, y: 64, z: 0 },
      tags: ['portal'],
      observedAt: 40
    }))

    const nearby = repo.search({
      dimension: 'overworld',
      types: ['storage', 'resource'],
      near: { position: { x: 0, y: 64, z: 0 }, radius: 10 },
      limit: 10
    })
    assert.deepEqual(nearby.map(result => result.type).sort(), ['resource', 'storage'])
    assert.equal(nearby.every(result => result.dimension === 'overworld'), true)

    const tagged = repo.search({ tags: ['wood'], limit: 10 })
    assert.deepEqual(tagged.map(result => result.content), ['Nearby oak forest'])
  } finally {
    repo.close()
  }
})

test('search ordering is deterministic by importance then recency', () => {
  const repo = new SqliteMemoryRepository(':memory:')
  try {
    repo.remember(memory({ content: 'low importance recent', importance: 0.2, observedAt: 300 }))
    repo.remember(memory({ content: 'high importance old', importance: 0.9, observedAt: 100 }))
    repo.remember(memory({ content: 'high importance recent', importance: 0.9, observedAt: 200 }))

    const results = repo.search({ types: ['resource'], limit: 10 })
    assert.deepEqual(results.map(result => result.content), [
      'high importance recent',
      'high importance old',
      'low importance recent'
    ])
  } finally {
    repo.close()
  }
})

test('text search is bounded and forget removes exactly one memory', () => {
  const repo = new SqliteMemoryRepository(':memory:')
  try {
    const forest = repo.remember(memory({ content: 'Dark oak forest by the river' }))
    repo.remember(memory({ content: 'Village wheat farm' }))

    const results = repo.search({ text: 'oak forest', limit: 1 })
    assert.equal(results.length, 1)
    assert.equal(results[0]?.id, forest.id)

    assert.equal(repo.forget(forest.id), true)
    assert.equal(repo.forget(forest.id), false)
    assert.deepEqual(repo.search({ text: 'oak forest', limit: 10 }), [])
  } finally {
    repo.close()
  }
})

test('transient world-state shaped objects are rejected by strict memory input validation', () => {
  const repo = new SqliteMemoryRepository(':memory:')
  try {
    const transient = {
      type: 'episode',
      content: 'raw snapshot should not persist',
      observedAt: 100,
      connected: true,
      health: 20,
      food: 18,
      nearbyPlayers: [],
      inventory: []
    } as unknown as MinecraftMemoryInput

    assert.throws(() => repo.remember(transient))
    assert.deepEqual(repo.search({ text: 'raw snapshot', limit: 10 }), [])
  } finally {
    repo.close()
  }
})
