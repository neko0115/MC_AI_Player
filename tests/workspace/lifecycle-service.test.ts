import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WorkspaceLifecycleError,
  WorkspaceLifecycleService
} from '../../src/workspace/lifecycle-service.js'
import {
  SqliteWorkspaceRepository
} from '../../src/workspace/sqlite-repository.js'
import type {
  WorkspaceSelection
} from '../../src/workspace/contracts.js'

function selection(
  overrides: Partial<WorkspaceSelection> = {}
): WorkspaceSelection {
  return {
    id: 'selection-1',
    generation: 1,
    worldKey: 'server:survival',
    dimension: 'overworld',
    playerId: 'player-1',
    playerName: 'Boss',
    pointA: { x: 0, y: 64, z: 0 },
    pointB: { x: 8, y: 64, z: 8 },
    selectedAt: 100,
    ...overrides
  }
}

function expectCode(
  operation: () => unknown,
  code: string
): void {
  assert.throws(
    operation,
    error =>
      error instanceof WorkspaceLifecycleError &&
      error.code === code
  )
}

test('lifecycle creates a durable active workspace from the trusted actor selection', () => {
  let auditId = 0
  const repo = new SqliteWorkspaceRepository(
    ':memory:',
    {
      now: () => 200,
      nextId: () => 'workspace-1',
      nextAuditId: () =>
        `audit-${++auditId}`
    }
  )

  try {
    const service =
      new WorkspaceLifecycleService(repo)
    const created =
      service.createFromSelection({
        selection: selection(),
        actorPrincipal: 'player-1',
        label: '東側農田',
        purpose: 'farm',
        tags: ['crop']
      })

    assert.equal(created.status, 'active')
    assert.deepEqual(created.bounds, {
      min: { x: 0, y: 64, z: 0 },
      max: { x: 8, y: 64, z: 8 }
    })
    assert.deepEqual(
      repo.listAudit(created.id),
      [{
        eventId: 'audit-1',
        workspaceId: 'workspace-1',
        actorPrincipal: 'player-1',
        action: 'created',
        safeSummary:
          'Workspace created from trusted selection',
        sourceSelectionId: 'selection-1',
        createdAt: 200
      }]
    )
  } finally {
    repo.close()
  }
})

test('lifecycle rename resize purpose tags and constraints preserve identity and append specific audit records', () => {
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
    const service =
      new WorkspaceLifecycleService(repo)
    const created =
      service.createFromSelection({
        selection: selection(),
        actorPrincipal: 'player-1',
        label: '區域',
        purpose: 'custom'
      })

    const renamed = service.rename(
      created.id,
      'player-1',
      '快速熔爐'
    )
    assert.equal(renamed.label, '快速熔爐')

    const resized =
      service.replaceBoundsFromSelection(
        created.id,
        'player-1',
        selection({
          id: 'selection-2',
          generation: 2,
          pointA: {
            x: 10,
            y: 64,
            z: 10
          },
          pointB: {
            x: 14,
            y: 73,
            z: 19
          }
        })
      )
    assert.equal(
      resized.sourceSelectionId,
      'selection-2'
    )

    const purposed =
      service.changePurpose(
        created.id,
        'player-1',
        'production'
      )
    assert.equal(
      purposed.purpose,
      'production'
    )

    const tagged =
      service.replaceTags(
        created.id,
        'player-1',
        ['smelting', 'high-throughput']
      )
    assert.deepEqual(
      tagged.tags,
      ['high-throughput', 'smelting']
    )

    const constrained =
      service.changeConstraints(
        created.id,
        'player-1',
        {
          preserveExistingStructures: true,
          requestedSpacing: 5
        }
      )
    assert.deepEqual(
      constrained.constraints,
      {
        preserveExistingStructures: true,
        requestedSpacing: 5
      }
    )

    const actions =
      repo.listAudit(created.id)
        .map(entry => entry.action)
    assert.deepEqual(actions, [
      'constraints_changed',
      'tags_changed',
      'purpose_changed',
      'resized',
      'renamed',
      'created'
    ])
  } finally {
    repo.close()
  }
})

test('archive is user-facing delete semantics while ordinary search hides archived workspace and restore brings it back', () => {
  let auditId = 0
  const repo = new SqliteWorkspaceRepository(
    ':memory:',
    {
      nextId: () => 'workspace-1',
      nextAuditId: () =>
        `audit-${++auditId}`
    }
  )

  try {
    const service =
      new WorkspaceLifecycleService(repo)
    const created =
      service.createFromSelection({
        selection: selection(),
        actorPrincipal: 'player-1',
        label: '農田',
        purpose: 'farm'
      })

    const archived =
      service.archive(
        created.id,
        'player-1'
      )
    assert.equal(
      archived.status,
      'archived'
    )
    assert.deepEqual(
      repo.search({
        worldKey: 'server:survival',
        limit: 10
      }),
      []
    )
    assert.equal(
      repo.search({
        worldKey: 'server:survival',
        includeArchived: true,
        limit: 10
      })[0]?.status,
      'archived'
    )
    expectCode(
      () => service.rename(
        created.id,
        'player-1',
        '不該成功'
      ),
      'workspace_archived'
    )

    const restored =
      service.restore(
        created.id,
        'player-1'
      )
    assert.equal(restored.status, 'active')
    assert.equal(
      repo.search({
        worldKey: 'server:survival',
        limit: 10
      }).length,
      1
    )

    assert.deepEqual(
      repo.listAudit(created.id)
        .slice(0, 2)
        .map(entry => entry.action),
      ['restored', 'archived']
    )
  } finally {
    repo.close()
  }
})

test('lifecycle rejects non-owner mutation and cross-scope or foreign-player resize selections', () => {
  const repo =
    new SqliteWorkspaceRepository(
      ':memory:',
      {
        nextId: () => 'workspace-1'
      }
    )

  try {
    const service =
      new WorkspaceLifecycleService(repo)
    const created =
      service.createFromSelection({
        selection: selection(),
        actorPrincipal: 'player-1',
        label: '基地',
        purpose: 'custom'
      })

    expectCode(
      () => service.rename(
        created.id,
        'player-2',
        '偷改名稱'
      ),
      'workspace_not_owner'
    )

    expectCode(
      () =>
        service.replaceBoundsFromSelection(
          created.id,
          'player-1',
          selection({
            id: 'selection-other-player',
            playerId: 'player-2'
          })
        ),
      'workspace_selection_owner_mismatch'
    )

    expectCode(
      () =>
        service.replaceBoundsFromSelection(
          created.id,
          'player-1',
          selection({
            id: 'selection-nether',
            dimension: 'the_nether'
          })
        ),
      'workspace_selection_scope_mismatch'
    )
  } finally {
    repo.close()
  }
})
