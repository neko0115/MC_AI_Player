import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
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

const require = createRequire(import.meta.url)

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

test('workspace create round-trips exact geometry, semantics, active status, provenance and audit', () => {
  let now = 100
  let auditId = 0
  const repo = new SqliteWorkspaceRepository(
    ':memory:',
    {
      now: () => now++,
      nextId: () => 'workspace-1',
      nextAuditId: () =>
        `audit-${++auditId}`
    }
  )

  try {
    const created = repo.create(workspace())

    assert.equal(created.id, 'workspace-1')
    assert.equal(created.status, 'active')
    assert.equal(created.moxueUsePolicy, 'shared')
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
    assert.equal(
      repo.listAudit(created.id)[0]?.action,
      'created'
    )
  } finally {
    repo.close()
  }
})

test('workspace update preserves identity/status/creation time while replacing mutable metadata and auditing', () => {
  let now = 100
  let auditId = 0
  const repo = new SqliteWorkspaceRepository(
    ':memory:',
    {
      now: () => now++,
      nextId: () => 'workspace-1',
      nextAuditId: () =>
        `audit-${++auditId}`
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
    assert.equal(updated.status, 'active')
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
    assert.deepEqual(
      repo.listAudit(created.id)
        .map(entry => entry.action),
      ['updated', 'created']
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
      moxueUsePolicy: 'moxue_preferred',
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

    const preferred = repo.search({
      worldKey: 'server:survival',
      dimension: 'overworld',
      usePolicies: ['moxue_preferred'],
      limit: 10
    })

    assert.deepEqual(
      preferred.map(result => result.label),
      ['Overworld furnace']
    )
  } finally {
    repo.close()
  }
})

test('low-level delete physically purges one workspace and cascades tags/audit for maintenance use', () => {
  const repo = new SqliteWorkspaceRepository(
    ':memory:',
    {
      nextId: () => 'workspace-delete',
      nextAuditId: () => 'audit-delete'
    }
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
        includeArchived: true,
        limit: 10
      }),
      []
    )
    assert.deepEqual(
      repo.listAudit(created.id),
      []
    )
  } finally {
    repo.close()
  }
})

test('workspace data and audit survive repository restart', () => {
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
        nextAuditId: () => 'audit-persist',
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
      assert.equal(restored.status, 'active')
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
      assert.equal(
        reopened.listAudit(created.id)
          .length,
        1
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

test('v1 database migrates to active v2 workspace status without losing existing rows', () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'mc-ai-workspace-v1-')
  )
  const filename = join(
    directory,
    'workspaces.sqlite3'
  )
  const Database =
    require('better-sqlite3') as new (
      filename: string
    ) => {
      exec(sql: string): void
      prepare(sql: string): {
        run(...params: unknown[]): unknown
      }
      close(): void
    }

  try {
    const db = new Database(filename)
    db.exec(`
      CREATE TABLE workspace_schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE workspace_regions (
        id TEXT PRIMARY KEY,
        world_key TEXT NOT NULL,
        dimension TEXT NOT NULL,
        min_x INTEGER NOT NULL,
        min_y INTEGER NOT NULL,
        min_z INTEGER NOT NULL,
        max_x INTEGER NOT NULL,
        max_y INTEGER NOT NULL,
        max_z INTEGER NOT NULL,
        label TEXT NOT NULL,
        purpose TEXT NOT NULL,
        constraints_json TEXT NOT NULL,
        owner_principal TEXT NOT NULL,
        source_selection_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE workspace_tags (
        workspace_id TEXT NOT NULL
          REFERENCES workspace_regions(id)
          ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (workspace_id, tag)
      );
    `)
    db.prepare(
      'INSERT INTO workspace_schema_meta (key, value) VALUES (?, ?)'
    ).run('schema_version', '1')
    db.prepare(`
      INSERT INTO workspace_regions (
        id, world_key, dimension,
        min_x, min_y, min_z,
        max_x, max_y, max_z,
        label, purpose, constraints_json,
        owner_principal, source_selection_id,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      'workspace-old',
      'server:survival',
      'overworld',
      0, 64, 0,
      8, 64, 8,
      'Legacy farm',
      'farm',
      '{}',
      'player-1',
      'selection-old',
      10,
      10
    )
    db.close()

    const repo =
      new SqliteWorkspaceRepository(filename)
    try {
      const migrated =
        repo.get('workspace-old')
      assert.ok(migrated)
      assert.equal(
        migrated.status,
        'active'
      )
      assert.equal(
        migrated.moxueUsePolicy,
        'shared'
      )
      assert.equal(
        migrated.label,
        'Legacy farm'
      )
      assert.deepEqual(
        repo.listAudit('workspace-old'),
        []
      )
    } finally {
      repo.close()
    }
  } finally {
    rmSync(directory, {
      recursive: true,
      force: true
    })
  }
})

test('v2 database migrates to shared v3 Moxue use policy without losing rows or audit support', () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'mc-ai-workspace-v2-')
  )
  const filename = join(
    directory,
    'workspaces.sqlite3'
  )
  const Database =
    require('better-sqlite3') as new (
      filename: string
    ) => {
      exec(sql: string): void
      prepare(sql: string): {
        run(...params: unknown[]): unknown
      }
      close(): void
    }

  try {
    const db = new Database(filename)
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE workspace_schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE workspace_regions (
        id TEXT PRIMARY KEY,
        world_key TEXT NOT NULL,
        dimension TEXT NOT NULL,
        min_x INTEGER NOT NULL,
        min_y INTEGER NOT NULL,
        min_z INTEGER NOT NULL,
        max_x INTEGER NOT NULL,
        max_y INTEGER NOT NULL,
        max_z INTEGER NOT NULL,
        label TEXT NOT NULL,
        purpose TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'archived')),
        constraints_json TEXT NOT NULL,
        owner_principal TEXT NOT NULL,
        source_selection_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE workspace_tags (
        workspace_id TEXT NOT NULL
          REFERENCES workspace_regions(id)
          ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (workspace_id, tag)
      );
      CREATE TABLE workspace_audit (
        event_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL
          REFERENCES workspace_regions(id)
          ON DELETE CASCADE,
        actor_principal TEXT NOT NULL,
        action TEXT NOT NULL,
        safe_summary TEXT NOT NULL,
        source_selection_id TEXT,
        created_at INTEGER NOT NULL
      );
    `)
    db.prepare(
      'INSERT INTO workspace_schema_meta (key, value) VALUES (?, ?)'
    ).run('schema_version', '2')
    db.prepare(`
      INSERT INTO workspace_regions (
        id, world_key, dimension,
        min_x, min_y, min_z,
        max_x, max_y, max_z,
        label, purpose, status,
        constraints_json,
        owner_principal, source_selection_id,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      'workspace-v2',
      'server:survival',
      'overworld',
      0, 64, 0,
      8, 64, 8,
      'V2 farm',
      'farm',
      'active',
      '{}',
      'player-1',
      'selection-v2',
      20,
      20
    )
    db.close()

    const repo =
      new SqliteWorkspaceRepository(filename)
    try {
      const migrated =
        repo.get('workspace-v2')
      assert.ok(migrated)
      assert.equal(
        migrated.moxueUsePolicy,
        'shared'
      )
      assert.equal(
        migrated.label,
        'V2 farm'
      )
    } finally {
      repo.close()
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
