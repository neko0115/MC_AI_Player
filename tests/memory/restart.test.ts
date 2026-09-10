import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SqliteMemoryRepository } from '../../src/memory/sqlite-repository.js'

test('player instructions, storage facts and reinforcement survive repository restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mc-ai-player-memory-'))
  const databasePath = join(directory, 'mc_memory.sqlite3')

  const first = new SqliteMemoryRepository(databasePath, { now: () => 1_000 })
  const instruction = first.remember({
    type: 'player_instruction',
    content: 'Boss prefers the east gate kept clear',
    dimension: 'overworld',
    tags: ['boss', 'base-rule'],
    importance: 0.95,
    observedAt: 100
  })
  const storage = first.remember({
    type: 'storage',
    content: 'Food chest beside the furnace',
    dimension: 'overworld',
    position: { x: 2, y: 64, z: -1 },
    tags: ['base', 'food'],
    importance: 0.8,
    observedAt: 110
  })
  first.remember({
    type: 'player_instruction',
    content: 'Boss prefers the east gate kept clear',
    dimension: 'overworld',
    tags: ['base-rule', 'boss'],
    importance: 0.95,
    observedAt: 120
  })
  first.close()

  const reopened = new SqliteMemoryRepository(databasePath, { now: () => 2_000 })
  try {
    const instructions = reopened.search({
      types: ['player_instruction'],
      tags: ['boss'],
      limit: 10
    })
    assert.equal(instructions.length, 1)
    assert.equal(instructions[0]?.id, instruction.id)
    assert.equal(instructions[0]?.reinforcementCount, 1)
    assert.equal(instructions[0]?.observedAt, 120)

    const storages = reopened.search({
      types: ['storage'],
      dimension: 'overworld',
      near: { position: { x: 0, y: 64, z: 0 }, radius: 5 },
      limit: 10
    })
    assert.equal(storages.length, 1)
    assert.equal(storages[0]?.id, storage.id)
    assert.deepEqual(storages[0]?.position, { x: 2, y: 64, z: -1 })
  } finally {
    reopened.close()
  }
})
