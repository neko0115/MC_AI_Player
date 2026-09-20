import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WorkspaceResolver
} from '../../src/workspace/resolver.js'
import {
  SqliteWorkspaceRepository
} from '../../src/workspace/sqlite-repository.js'
import {
  normalizeWorkspaceBounds
} from '../../src/workspace/geometry.js'
import type {
  WorkspaceRegion,
  WorkspaceSelection
} from '../../src/workspace/contracts.js'

function makeRepo() {
  let id = 0
  return new SqliteWorkspaceRepository(
    ':memory:',
    {
      nextId: () => `workspace-${++id}`
    }
  )
}

function createWorkspace(
  repo: SqliteWorkspaceRepository,
  input: {
    label: string
    owner?: string
    worldKey?: string
    dimension?: string
    minX: number
    maxX: number
    minZ: number
    maxZ: number
    sourceSelectionId?: string | null
  }
): WorkspaceRegion {
  return repo.create({
    worldKey:
      input.worldKey ??
      'server:survival',
    dimension:
      input.dimension ??
      'overworld',
    bounds: normalizeWorkspaceBounds(
      {
        x: input.minX,
        y: 64,
        z: input.minZ
      },
      {
        x: input.maxX,
        y: 70,
        z: input.maxZ
      }
    ),
    label: input.label,
    purpose: 'custom',
    tags: [],
    constraints: {},
    ownerPrincipal:
      input.owner ??
      'player-1',
    sourceSelectionId:
      input.sourceSelectionId ??
      null
  })
}

function selection(
  overrides: Partial<WorkspaceSelection> = {}
): WorkspaceSelection {
  return {
    id: 'selection-live',
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
      y: 70,
      z: 8
    },
    selectedAt: 100,
    ...overrides
  }
}

test('explicit id or exact label resolves before conversation, selection, nearby and recent context', () => {
  const repo = makeRepo()
  try {
    const explicit =
      createWorkspace(repo, {
        label: '東側農田',
        minX: 0,
        maxX: 8,
        minZ: 0,
        maxZ: 8
      })
    const conversation =
      createWorkspace(repo, {
        label: '快速熔爐',
        minX: 20,
        maxX: 28,
        minZ: 20,
        maxZ: 28
      })

    const resolver =
      new WorkspaceResolver(repo)

    const byId = resolver.resolve({
      worldKey: 'server:survival',
      dimension: 'overworld',
      actorPrincipal: 'player-1',
      explicitReference: explicit.id,
      conversationWorkspaceId:
        conversation.id,
      playerPosition: {
        x: 25,
        y: 64,
        z: 25
      },
      recentWorkspaceId:
        conversation.id
    })

    assert.equal(
      byId.kind,
      'resolved'
    )
    if (byId.kind === 'resolved') {
      assert.equal(
        byId.reason,
        'explicit'
      )
      assert.equal(
        byId.workspace.id,
        explicit.id
      )
    }

    const byName = resolver.resolve({
      worldKey: 'server:survival',
      dimension: 'overworld',
      actorPrincipal: 'player-1',
      explicitReference: '  東側農田  '
    })

    assert.equal(
      byName.kind,
      'resolved'
    )
    if (byName.kind === 'resolved') {
      assert.equal(
        byName.workspace.id,
        explicit.id
      )
    }
  } finally {
    repo.close()
  }
})

test('explicit missing or unauthorized reference fails closed without nearby fallback', () => {
  const repo = makeRepo()
  try {
    createWorkspace(repo, {
      label: 'Nearby',
      minX: 0,
      maxX: 8,
      minZ: 0,
      maxZ: 8
    })
    const foreign =
      createWorkspace(repo, {
        label: 'Foreign',
        owner: 'player-2',
        minX: 20,
        maxX: 28,
        minZ: 20,
        maxZ: 28
      })

    const resolver =
      new WorkspaceResolver(repo)

    assert.deepEqual(
      resolver.resolve({
        worldKey: 'server:survival',
        dimension: 'overworld',
        actorPrincipal: 'player-1',
        explicitReference: '不存在',
        playerPosition: {
          x: 1,
          y: 64,
          z: 1
        }
      }),
      {
        kind: 'none',
        reason: 'explicit_not_found'
      }
    )

    assert.deepEqual(
      resolver.resolve({
        worldKey: 'server:survival',
        dimension: 'overworld',
        actorPrincipal: 'player-1',
        explicitReference: foreign.id
      }),
      {
        kind: 'none',
        reason: 'explicit_not_found'
      }
    )
  } finally {
    repo.close()
  }
})

test('duplicate explicit labels are ambiguous instead of last-write-wins', () => {
  const repo = makeRepo()
  try {
    createWorkspace(repo, {
      label: '農田',
      minX: 0,
      maxX: 8,
      minZ: 0,
      maxZ: 8
    })
    createWorkspace(repo, {
      label: '農田',
      minX: 20,
      maxX: 28,
      minZ: 20,
      maxZ: 28
    })

    const result =
      new WorkspaceResolver(repo)
        .resolve({
          worldKey: 'server:survival',
          dimension: 'overworld',
          actorPrincipal: 'player-1',
          explicitReference: '農田'
        })

    assert.equal(
      result.kind,
      'ambiguous'
    )
    if (result.kind === 'ambiguous') {
      assert.equal(
        result.reason,
        'explicit'
      )
      assert.equal(
        result.candidates.length,
        2
      )
    }
  } finally {
    repo.close()
  }
})

test('conversation binding precedes selection context', () => {
  const repo = makeRepo()
  try {
    const conversation =
      createWorkspace(repo, {
        label: 'Conversation',
        minX: 50,
        maxX: 58,
        minZ: 50,
        maxZ: 58
      })
    createWorkspace(repo, {
      label: 'Selection',
      minX: 0,
      maxX: 8,
      minZ: 0,
      maxZ: 8,
      sourceSelectionId:
        'selection-live'
    })

    const result =
      new WorkspaceResolver(repo)
        .resolve({
          worldKey: 'server:survival',
          dimension: 'overworld',
          actorPrincipal: 'player-1',
          conversationWorkspaceId:
            conversation.id,
          selection: selection()
        })

    assert.equal(
      result.kind,
      'resolved'
    )
    if (result.kind === 'resolved') {
      assert.equal(
        result.reason,
        'conversation'
      )
      assert.equal(
        result.workspace.id,
        conversation.id
      )
    }
  } finally {
    repo.close()
  }
})

test('trusted selection first resolves exact source id then unique intersection', () => {
  const repo = makeRepo()
  try {
    const exact =
      createWorkspace(repo, {
        label: 'Exact',
        minX: 0,
        maxX: 8,
        minZ: 0,
        maxZ: 8,
        sourceSelectionId:
          'selection-live'
      })
    createWorkspace(repo, {
      label: 'Other intersection',
      minX: 7,
      maxX: 15,
      minZ: 7,
      maxZ: 15
    })

    const resolver =
      new WorkspaceResolver(repo)

    const sourceResult =
      resolver.resolve({
        worldKey: 'server:survival',
        dimension: 'overworld',
        actorPrincipal: 'player-1',
        selection: selection()
      })

    assert.equal(
      sourceResult.kind,
      'resolved'
    )
    if (
      sourceResult.kind === 'resolved'
    ) {
      assert.equal(
        sourceResult.reason,
        'selection_source'
      )
      assert.equal(
        sourceResult.workspace.id,
        exact.id
      )
    }

    const intersectionResult =
      resolver.resolve({
        worldKey: 'server:survival',
        dimension: 'overworld',
        actorPrincipal: 'player-1',
        selection: selection({
          id: 'selection-new',
          pointA: {
            x: 30,
            y: 64,
            z: 30
          },
          pointB: {
            x: 35,
            y: 70,
            z: 35
          }
        })
      })

    assert.deepEqual(
      intersectionResult,
      {
        kind: 'none',
        reason: 'no_match'
      }
    )

    const unique =
      createWorkspace(repo, {
        label: 'Unique intersection',
        minX: 30,
        maxX: 40,
        minZ: 30,
        maxZ: 40
      })

    const uniqueResult =
      resolver.resolve({
        worldKey: 'server:survival',
        dimension: 'overworld',
        actorPrincipal: 'player-1',
        selection: selection({
          id: 'selection-new',
          pointA: {
            x: 30,
            y: 64,
            z: 30
          },
          pointB: {
            x: 35,
            y: 70,
            z: 35
          }
        })
      })

    assert.equal(
      uniqueResult.kind,
      'resolved'
    )
    if (
      uniqueResult.kind === 'resolved'
    ) {
      assert.equal(
        uniqueResult.reason,
        'selection_intersection'
      )
      assert.equal(
        uniqueResult.workspace.id,
        unique.id
      )
    }
  } finally {
    repo.close()
  }
})

test('duplicate workspaces from the same selection are ambiguous instead of last-write-wins', () => {
  const repo = makeRepo()
  try {
    createWorkspace(repo, {
      label: 'First from selection',
      minX: 0,
      maxX: 8,
      minZ: 0,
      maxZ: 8,
      sourceSelectionId:
        'selection-live'
    })
    createWorkspace(repo, {
      label: 'Second from selection',
      minX: 20,
      maxX: 28,
      minZ: 20,
      maxZ: 28,
      sourceSelectionId:
        'selection-live'
    })

    const result =
      new WorkspaceResolver(repo)
        .resolve({
          worldKey: 'server:survival',
          dimension: 'overworld',
          actorPrincipal: 'player-1',
          selection: selection()
        })

    assert.equal(
      result.kind,
      'ambiguous'
    )
    if (
      result.kind === 'ambiguous'
    ) {
      assert.equal(
        result.reason,
        'selection_source'
      )
      assert.equal(
        result.candidates.length,
        2
      )
    }
  } finally {
    repo.close()
  }
})

test('foreign or cross-scope selection is ignored', () => {
  const repo = makeRepo()
  try {
    const recent =
      createWorkspace(repo, {
        label: 'Recent',
        minX: 50,
        maxX: 58,
        minZ: 50,
        maxZ: 58
      })

    const resolver =
      new WorkspaceResolver(repo)

    const result =
      resolver.resolve({
        worldKey: 'server:survival',
        dimension: 'overworld',
        actorPrincipal: 'player-1',
        selection: selection({
          playerId: 'player-2'
        }),
        recentWorkspaceId:
          recent.id
      })

    assert.equal(
      result.kind,
      'resolved'
    )
    if (result.kind === 'resolved') {
      assert.equal(
        result.reason,
        'recent'
      )
      assert.equal(
        result.workspace.id,
        recent.id
      )
    }
  } finally {
    repo.close()
  }
})

test('unique nearby workspace resolves but multiple nearby workspaces are ambiguous', () => {
  const repo = makeRepo()
  try {
    const first =
      createWorkspace(repo, {
        label: 'First',
        minX: 0,
        maxX: 8,
        minZ: 0,
        maxZ: 8
      })

    const resolver =
      new WorkspaceResolver(repo)

    const unique =
      resolver.resolve({
        worldKey: 'server:survival',
        dimension: 'overworld',
        actorPrincipal: 'player-1',
        playerPosition: {
          x: 10,
          y: 64,
          z: 4
        },
        nearbyRadius: 4
      })

    assert.equal(
      unique.kind,
      'resolved'
    )
    if (unique.kind === 'resolved') {
      assert.equal(
        unique.reason,
        'nearby'
      )
      assert.equal(
        unique.workspace.id,
        first.id
      )
    }

    createWorkspace(repo, {
      label: 'Second',
      minX: 10,
      maxX: 18,
      minZ: 0,
      maxZ: 8
    })

    const multiple =
      resolver.resolve({
        worldKey: 'server:survival',
        dimension: 'overworld',
        actorPrincipal: 'player-1',
        playerPosition: {
          x: 9,
          y: 64,
          z: 4
        },
        nearbyRadius: 2
      })

    assert.equal(
      multiple.kind,
      'ambiguous'
    )
    if (
      multiple.kind === 'ambiguous'
    ) {
      assert.equal(
        multiple.reason,
        'nearby'
      )
      assert.equal(
        multiple.candidates.length,
        2
      )
    }
  } finally {
    repo.close()
  }
})

test('recent workspace is fallback only and archived workspace is excluded from all resolution paths', () => {
  const repo = makeRepo()
  try {
    const recent =
      createWorkspace(repo, {
        label: 'Recent',
        minX: 50,
        maxX: 58,
        minZ: 50,
        maxZ: 58
      })
    const archived =
      createWorkspace(repo, {
        label: 'Archived',
        minX: 0,
        maxX: 8,
        minZ: 0,
        maxZ: 8,
        sourceSelectionId:
          'selection-live'
      })

    repo.setStatus(
      archived.id,
      'archived',
      {
        actorPrincipal: 'player-1',
        action: 'archived',
        safeSummary: 'archive for resolver test'
      }
    )

    const resolver =
      new WorkspaceResolver(repo)

    const recentResult =
      resolver.resolve({
        worldKey: 'server:survival',
        dimension: 'overworld',
        actorPrincipal: 'player-1',
        recentWorkspaceId:
          recent.id
      })

    assert.equal(
      recentResult.kind,
      'resolved'
    )
    if (
      recentResult.kind === 'resolved'
    ) {
      assert.equal(
        recentResult.reason,
        'recent'
      )
    }

    assert.deepEqual(
      resolver.resolve({
        worldKey: 'server:survival',
        dimension: 'overworld',
        actorPrincipal: 'player-1',
        explicitReference:
          archived.id
      }),
      {
        kind: 'none',
        reason: 'explicit_not_found'
      }
    )

    assert.equal(
      resolver.resolve({
        worldKey: 'server:survival',
        dimension: 'overworld',
        actorPrincipal: 'player-1',
        selection: selection()
      }).kind,
      'none'
    )
  } finally {
    repo.close()
  }
})
