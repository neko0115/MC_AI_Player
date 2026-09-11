import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteMemoryRepository } from '../../src/memory/sqlite-repository.js'
import type { MemorySearchQuery } from '../../src/memory/repository.js'

test('identical world facts in different world keys remain isolated', () => {
  const repo = new SqliteMemoryRepository(':memory:')
  try {
    const a = repo.remember({
      worldKey: 'server-a:survival-v1',
      type: 'landmark',
      content: 'Main base entrance',
      dimension: 'overworld',
      position: { x: 0, y: 64, z: 0 },
      tags: ['base'],
      observedAt: 100
    })
    const b = repo.remember({
      worldKey: 'server-b:survival-v1',
      type: 'landmark',
      content: 'Main base entrance',
      dimension: 'overworld',
      position: { x: 0, y: 64, z: 0 },
      tags: ['base'],
      observedAt: 100
    })

    assert.notEqual(a.id, b.id)
    assert.deepEqual(
      repo.search({ worldKey: 'server-a:survival-v1', tags: ['base'], limit: 10 })
        .map(memory => memory.id),
      [a.id]
    )
    assert.deepEqual(
      repo.search({ worldKey: 'server-b:survival-v1', tags: ['base'], limit: 10 })
        .map(memory => memory.id),
      [b.id]
    )
  } finally {
    repo.close()
  }
})

test('memory search without an explicit world key fails closed', () => {
  const repo = new SqliteMemoryRepository(':memory:')
  try {
    const unsafeQuery = { text: 'base', limit: 10 } as unknown as MemorySearchQuery
    assert.throws(() => repo.search(unsafeQuery))
  } finally {
    repo.close()
  }
})
