import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WorkspaceManagementError,
  WorkspaceManagementService
} from '../../src/workspace/management-service.js'
import {
  SqliteWorkspaceRepository
} from '../../src/workspace/sqlite-repository.js'
import type {
  WorkspaceSelection
} from '../../src/workspace/contracts.js'
import type {
  WorkspaceSelectionSource
} from '../../src/workspace/selection-source.js'

class FakeSelections
implements WorkspaceSelectionSource {
  state:
    | 'current'
    | 'stale'
    | 'unavailable' =
      'current'
  selection:
    WorkspaceSelection | null = {
      id: 'selection-1',
      generation: 1,
      worldKey: 'server:survival',
      dimension: 'overworld',
      playerId: 'player-1',
      playerName: 'Boss',
      pointA: {
        x: 0,
        y: 64,
        z: 0
      },
      pointB: {
        x: 8,
        y: 64,
        z: 8
      },
      selectedAt: 100
    }

  latest(query: {
    worldKey: string
    dimension: string
    playerId: string
  }): WorkspaceSelection | null {
    const selection =
      this.selection
    if (!selection) return null
    if (
      query.worldKey !==
        selection.worldKey ||
      query.dimension.toLowerCase() !==
        selection.dimension.toLowerCase() ||
      query.playerId !==
        selection.playerId
    ) {
      return null
    }
    return structuredClone(selection)
  }

  status() {
    return {
      state: this.state,
      lastSuccessAt:
        this.state === 'unavailable'
          ? null
          : 100,
      lastErrorCode:
        this.state === 'stale'
          ? 'bridge_failed'
          : null
    }
  }
}

function expectCode(
  operation: () => unknown,
  code: string
): void {
  assert.throws(
    operation,
    error =>
      error instanceof
        WorkspaceManagementError &&
      error.code === code
  )
}

function setup() {
  let id = 0
  let audit = 0
  const repo =
    new SqliteWorkspaceRepository(
      ':memory:',
      {
        nextId: () =>
          `workspace-${++id}`,
        nextAuditId: () =>
          `audit-${++audit}`
      }
    )
  const selections =
    new FakeSelections()
  const service =
    new WorkspaceManagementService({
      worldKey: 'server:survival',
      repository: repo,
      selections
    })
  return {
    repo,
    selections,
    service
  }
}

test('management create uses only current trusted selection and owner scope', () => {
  const current = setup()
  try {
    const created =
      current.service.create({
        dimension: 'overworld',
        actorPrincipal: 'player-1',
        label: '農田',
        purpose: 'farm',
        moxueUsePolicy:
          'owner_only',
        tags: ['crop']
      })

    assert.equal(
      created.ownerPrincipal,
      'player-1'
    )
    assert.equal(
      created.moxueUsePolicy,
      'owner_only'
    )
    assert.equal(
      created.sourceSelectionId,
      'selection-1'
    )
    assert.deepEqual(
      created.bounds,
      {
        min: {
          x: 0,
          y: 64,
          z: 0
        },
        max: {
          x: 8,
          y: 64,
          z: 8
        }
      }
    )

    assert.deepEqual(
      current.service.list({
        actorPrincipal: 'player-1',
        dimension: 'overworld'
      }).map(item => item.id),
      [created.id]
    )

    assert.deepEqual(
      current.service.list({
        actorPrincipal: 'player-2',
        dimension: 'overworld'
      }),
      []
    )
  } finally {
    current.repo.close()
  }
})

test('management create fails closed for unavailable stale or missing selection', () => {
  const current = setup()
  try {
    current.selections.state =
      'unavailable'
    expectCode(
      () =>
        current.service.create({
          dimension: 'overworld',
          actorPrincipal: 'player-1',
          label: '區域',
          purpose: 'custom'
        }),
      'workspace_selection_unavailable'
    )

    current.selections.state = 'stale'
    expectCode(
      () =>
        current.service.create({
          dimension: 'overworld',
          actorPrincipal: 'player-1',
          label: '區域',
          purpose: 'custom'
        }),
      'workspace_selection_stale'
    )

    current.selections.state = 'current'
    current.selections.selection = null
    expectCode(
      () =>
        current.service.create({
          dimension: 'overworld',
          actorPrincipal: 'player-1',
          label: '區域',
          purpose: 'custom'
        }),
      'workspace_selection_missing'
    )
  } finally {
    current.repo.close()
  }
})

test('management update and resize preserve lifecycle authority and use current selection rather than arbitrary coordinates', () => {
  const current = setup()
  try {
    const created =
      current.service.create({
        dimension: 'overworld',
        actorPrincipal: 'player-1',
        label: '區域',
        purpose: 'custom'
      })

    assert.equal(
      current.service.rename(
        created.id,
        'player-1',
        '快速熔爐'
      ).label,
      '快速熔爐'
    )

    current.selections.selection = {
      ...current.selections.selection!,
      id: 'selection-2',
      generation: 2,
      pointA: {
        x: 20,
        y: 64,
        z: 20
      },
      pointB: {
        x: 24,
        y: 73,
        z: 29
      }
    }

    const resized =
      current.service
        .resizeFromCurrentSelection(
          created.id,
          'player-1'
        )

    assert.deepEqual(
      resized.bounds,
      {
        min: {
          x: 20,
          y: 64,
          z: 20
        },
        max: {
          x: 24,
          y: 73,
          z: 29
        }
      }
    )
    assert.equal(
      resized.sourceSelectionId,
      'selection-2'
    )

    assert.equal(
      current.service.changePurpose(
        created.id,
        'player-1',
        'production'
      ).purpose,
      'production'
    )

    assert.equal(
      current.service.changeUsePolicy(
        created.id,
        'player-1',
        'moxue_preferred'
      ).moxueUsePolicy,
      'moxue_preferred'
    )

    assert.deepEqual(
      current.service.replaceTags(
        created.id,
        'player-1',
        ['smelting', 'fast']
      ).tags,
      ['fast', 'smelting']
    )

    assert.deepEqual(
      current.service.changeConstraints(
        created.id,
        'player-1',
        {
          requestedSpacing: 5
        }
      ).constraints,
      {
        requestedSpacing: 5
      }
    )
  } finally {
    current.repo.close()
  }
})

test('management archive restore get and audit remain owner scoped', () => {
  const current = setup()
  try {
    const created =
      current.service.create({
        dimension: 'overworld',
        actorPrincipal: 'player-1',
        label: '農田',
        purpose: 'farm'
      })

    expectCode(
      () =>
        current.service.get(
          created.id,
          'player-2'
        ),
      'workspace_not_owner'
    )

    assert.equal(
      current.service.archive(
        created.id,
        'player-1'
      ).status,
      'archived'
    )

    assert.deepEqual(
      current.service.list({
        actorPrincipal: 'player-1'
      }),
      []
    )

    assert.equal(
      current.service.list({
        actorPrincipal: 'player-1',
        includeArchived: true
      })[0]?.status,
      'archived'
    )

    assert.equal(
      current.service.restore(
        created.id,
        'player-1'
      ).status,
      'active'
    )

    const actions =
      current.service.audit(
        created.id,
        'player-1'
      ).map(item => item.action)

    assert.deepEqual(
      actions.slice(0, 3),
      [
        'restored',
        'archived',
        'created'
      ]
    )
  } finally {
    current.repo.close()
  }
})

test('archived resize fails before consulting current selection', () => {
  const current = setup()
  try {
    const created =
      current.service.create({
        dimension: 'overworld',
        actorPrincipal: 'player-1',
        label: '農田',
        purpose: 'farm'
      })

    current.service.archive(
      created.id,
      'player-1'
    )

    current.selections.state =
      'unavailable'

    expectCode(
      () =>
        current.service
          .resizeFromCurrentSelection(
            created.id,
            'player-1'
          ),
      'workspace_archived'
    )
  } finally {
    current.repo.close()
  }
})

test('management rejects workspace ids from another world even when owner matches', () => {
  const current = setup()
  try {
    const foreign =
      current.repo.create({
        worldKey: 'other:world',
        dimension: 'overworld',
        bounds: {
          min: {
            x: 0,
            y: 64,
            z: 0
          },
          max: {
            x: 8,
            y: 64,
            z: 8
          }
        },
        label: 'Foreign',
        purpose: 'custom',
        tags: [],
        constraints: {},
        ownerPrincipal: 'player-1',
        sourceSelectionId: null
      })

    expectCode(
      () =>
        current.service.get(
          foreign.id,
          'player-1'
        ),
      'workspace_not_found'
    )
  } finally {
    current.repo.close()
  }
})
