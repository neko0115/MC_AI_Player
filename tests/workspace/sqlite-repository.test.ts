import assert from 'node:assert/strict'
import {
  mkdtempSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  normalizeWorkspaceBounds
} from '../../src/workspace/geometry.js'
import {
  SqliteWorkspaceRepository
} from '../../src/workspace/sqlite-repository.js'
import type {
  WorkspaceRegionInput
} from '../../src/workspace/contracts.js'

function workspace(
  overrides: Partial<WorkspaceRegionInput> = {}
): WorkspaceRegionInput {
  return {
    worldKey: 'server:survival',
    dimension: 'overworld',
    bounds: normalizeWorkspaceBounds(
      { x: 10, y: 64, z: 20 },
      { x: 14, y: 73, z: 29 }
    ),
    label: '快速熔爐',
    purpose: 'production',
    tags: ['smelting', 'high-throughput'],
    constraints: {
      preserveExistingStructures: true
    },
    ownerPrincipal: 'player-1',
    sourceSelectionId: 'selection-1',
    ...overrides
  }
}

test('workspace create round-trips exact geometry, semantics and provenance', () => {
  let now = 100
  const repo = new SqliteWorkspaceRepository(
    ':memory:',
    {
      now: () => now++,
      nextId: () => 'workspace-1'
    }
  )

  try {
    const created = repo.create(workspace())

    assert.equal(created.id, 'workspace-1')
    assert.equal(created.createdAt, 100)
    assert.equal(created.updatedAt, 100)
    assert.deepEqual(created.bounds, {
      min: { x: 10, y: 64, z: 20 },
      max: { x: 14, y: 73, z: 29 }
    })
    assert.equal(created.label, '快速熔爐')
    assert.equal(created.purpose, 'production')
    assert.deepEqual(
      created.tags,
      ['high-throughput', 'smelting']
    )
    assert.equal(
      created.sourceSelectionId,
      'selection-1'
    )
    assert.equal(
      created.ownerPrincipal,
      'player-1'
    )
  } finally {
    repo.close()
  }
})

test('workspace update preserves identity and creation time while replacing mutable metadata', () => {
  let now = 100
  const repo = new SqliteWorkspaceRepository(
    ':memory:',
    {
      now: () => now++,
      nextId: () => 'workspace-1'
    }
  )

  try {
    const created = repo.create(workspace())
    const updated = repo.update(
      created.id,
      workspace({
        label: '東側農田',
        purpose: 'farm',
        tags: ['crop', 'farm'],
        bounds: normalizeWorkspaceBounds(
          { x: 0, y: 64, z: 0 },
          { x: 8, y: 64, z: 8 }
        ),
        sourceSelectionId: 'selection-2'
      })
    )

    assert.ok(updated)
    assert.equal(updated.id, created.id)
    assert.equal(updated.createdAt, created.createdAt)
    assert.equal(updated.updatedAt, 101)
    assert.equal(updated.label, '東側農田')
    assert.equal(updated.purpose, 'farm')
    assert.deepEqual(updated.tags, ['crop', 'farm'])
    assert.deepEqual(updated.bounds, {
      min: { x: 0, y: 64, z: 0 },
      max: { x: 8, y: 64, z: 8 }
    })
    assert.equal(
      updated.sourceSelectionId,
      'selection-2'
    )
  } finally {
    repo.close()
  }
})

test('workspace search is isolated by world/dimension and supports tags, purpose, owner and intersection', () => {
  let id = 0
  const repo = new SqliteWorkspaceRepository(
    ':memory:',
    {
      nextId: () => `workspace-${++id}`
    }
  )

  try {
    repo.create(workspace({
      label: 'Overworld farm',
      purpose: 'farm',
      tags: ['crop', 'base'],
      bounds: normalizeWorkspaceBounds(
        { x: 0, y: 64, z: 0 },
        { x: 8, y: 64, z: 8 }
      )
    }))
    repo.create(workspace({
      label: 'Overworld furnace',
      purpose: 'production',
      tags: ['smelting', 'base'],
      bounds: normalizeWorkspaceBounds(
        { x: 20, y: 64, z: 20 },
        { x: 30, y: 70, z: 30 }
      )
    }))
    repo.create(workspace({
      worldKey: 'other:world',
      label: 'Foreign farm',
      purpose: 'farm',
      tags: ['crop']
    }))
    repo.create(workspace({
      dimension: 'the_nether',
      label: 'Nether furnace'
    }))

    const farm = repo.search({
      worldKey: 'server:survival',
      dimension: 'overworld',
      purposes: ['farm'],
      tags: ['crop'],
      ownerPrincipal: 'player-1',
      intersects: normalizeWorkspaceBounds(
        { x: 7, y: 64, z: 7 },
        { x: 12, y: 70, z: 12 }
      ),
      limit: 10
    })

    assert.deepEqual(
      farm.map(result => result.label),
      ['Overworld farm']
    )

    const base = repo.search({
      worldKey: 'server:survival',
      dimension: 'overworld',
      tags: ['base'],
      limit: 10
    })

    assert.deepEqual(
      base.map(result => result.label).sort(),
      ['Overworld farm', 'Overworld furnace']
    )
  } finally {
    repo.close()
  }
})

test('workspace delete removes exactly one region and its tags', () => {
  const repo = new SqliteWorkspaceRepository(
    ':memory:',
    { nextId: () => 'workspace-delete' }
  )

  try {
    const created = repo.create(workspace())
    assert.equal(repo.delete(created.id), true)
    assert.equal(repo.delete(created.id), false)
    assert.equal(repo.get(created.id), null)
    assert.deepEqual(
      repo.search({
        worldKey: 'server:survival',
        tags: ['smelting'],
        limit: 10
      }),
      []
    )
  } finally {
    repo.close()
  }
})

test('workspace data survives repository restart', () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'mc-ai-workspaces-')
  )
  const filename = join(
    directory,
    'workspaces.sqlite3'
  )

  try {
    const first = new SqliteWorkspaceRepository(
      filename,
      {
        nextId: () => 'workspace-persist',
        now: () => 123
      }
    )
    const created = first.create(workspace())
    first.close()

    const reopened =
      new SqliteWorkspaceRepository(filename)
    try {
      const restored = reopened.get(created.id)
      assert.ok(restored)
      assert.equal(restored.label, '快速熔爐')
      assert.equal(restored.purpose, 'production')
      assert.deepEqual(
        restored.bounds,
        created.bounds
      )
      assert.equal(
        restored.sourceSelectionId,
        'selection-1'
      )
    } finally {
      reopened.close()
    }
  } finally {
    rmSync(directory, {
      recursive: true,
      force: true
    })
  }
})

test('workspace repository rejects malformed transient fields instead of persisting them', () => {
  const repo = new SqliteWorkspaceRepository(':memory:')
  try {
    const malformed = {
      ...workspace(),
      connected: true,
      rawBot: {}
    } as unknown as WorkspaceRegionInput

    assert.throws(() => repo.create(malformed))
    assert.deepEqual(
      repo.search({
        worldKey: 'server:survival',
        limit: 10
      }),
      []
    )
  } finally {
    repo.close()
  }
})
