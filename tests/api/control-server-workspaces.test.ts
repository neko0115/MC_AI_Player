import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  GoalRecord,
  GoalRequest,
  GoalSource
} from '../../src/contracts/goals.js'
import type {
  RuntimeEvent
} from '../../src/contracts/events.js'
import type {
  MemorySearchQuery,
  MinecraftMemoryRepository
} from '../../src/memory/repository.js'
import {
  ControlServer,
  type ControlGoalPort,
  type ControlWorkspaceManagementPort,
  type RuntimeEventSource
} from '../../src/api/control-server.js'
import {
  WorkspaceManagementError
} from '../../src/workspace/management-service.js'
import type {
  WorkspaceRegion
} from '../../src/workspace/contracts.js'

class NoopGoals implements ControlGoalPort {
  async submit(
    request: GoalRequest,
    source: GoalSource
  ): Promise<GoalRecord> {
    return {
      goalId: 'goal-1',
      request,
      source,
      status: 'queued',
      createdAt: 1,
      updatedAt: 1
    }
  }

  activeGoal(): GoalRecord | null {
    return null
  }

  queuedGoals(): readonly GoalRecord[] {
    return []
  }

  async emergencyStop(): Promise<void> {}
}

class NoopEvents implements RuntimeEventSource {
  subscribe(
    _listener:
      (event: RuntimeEvent) =>
        void | Promise<void>
  ): () => void {
    return () => {}
  }
}

class NoopMemory
implements Pick<
  MinecraftMemoryRepository,
  'search'
> {
  search(
    _query: MemorySearchQuery
  ) {
    return []
  }
}

function workspace(
  overrides:
    Partial<WorkspaceRegion> = {}
): WorkspaceRegion {
  return {
    id: 'workspace-1',
    worldKey: 'server:survival',
    dimension: 'overworld',
    bounds: {
      min: { x: 0, y: 64, z: 0 },
      max: { x: 8, y: 64, z: 8 }
    },
    label: '農田',
    purpose: 'farm',
    status: 'active',
    tags: ['crop'],
    constraints: {
      requestedSpacing: 5,
      preserveExistingStructures: true
    },
    ownerPrincipal: 'player-1',
    sourceSelectionId:
      'selection-1',
    createdAt: 10,
    updatedAt: 20,
    ...overrides
  }
}

class FakeWorkspaceManagement
implements ControlWorkspaceManagementPort {
  readonly calls: Array<{
    kind: string
    value: unknown
  }> = []

  create(
    request:
      Parameters<
        ControlWorkspaceManagementPort[
          'create'
        ]
      >[0]
  ): WorkspaceRegion {
    this.calls.push({
      kind: 'create',
      value: structuredClone(request)
    })
    return workspace({
      label: request.label,
      purpose: request.purpose,
      tags: [...(request.tags ?? [])],
      constraints:
        structuredClone(
          request.constraints ?? {}
        ),
      ownerPrincipal:
        request.actorPrincipal,
      dimension: request.dimension
    })
  }

  list(
    request:
      Parameters<
        ControlWorkspaceManagementPort[
          'list'
        ]
      >[0]
  ): WorkspaceRegion[] {
    this.calls.push({
      kind: 'list',
      value: structuredClone(request)
    })
    return [workspace()]
  }

  get(
    id: string,
    actor: string
  ): WorkspaceRegion {
    this.calls.push({
      kind: 'get',
      value: { id, actor }
    })
    return workspace({ id })
  }

  rename(
    id: string,
    actor: string,
    label: string
  ): WorkspaceRegion {
    this.calls.push({
      kind: 'rename',
      value: { id, actor, label }
    })
    return workspace({
      id,
      label
    })
  }

  resizeFromCurrentSelection(
    id: string,
    actor: string
  ): WorkspaceRegion {
    this.calls.push({
      kind: 'resize',
      value: { id, actor }
    })
    return workspace({
      id,
      sourceSelectionId:
        'selection-2'
    })
  }

  changePurpose(
    id: string,
    actor: string,
    purpose:
      WorkspaceRegion['purpose']
  ): WorkspaceRegion {
    this.calls.push({
      kind: 'purpose',
      value: {
        id,
        actor,
        purpose
      }
    })
    return workspace({
      id,
      purpose
    })
  }

  replaceTags(
    id: string,
    actor: string,
    tags: readonly string[]
  ): WorkspaceRegion {
    this.calls.push({
      kind: 'tags',
      value: {
        id,
        actor,
        tags: [...tags]
      }
    })
    return workspace({
      id,
      tags: [...tags]
    })
  }

  changeConstraints(
    id: string,
    actor: string,
    constraints:
      WorkspaceRegion['constraints']
  ): WorkspaceRegion {
    this.calls.push({
      kind: 'constraints',
      value: {
        id,
        actor,
        constraints:
          structuredClone(
            constraints
          )
      }
    })
    return workspace({
      id,
      constraints:
        structuredClone(
          constraints
        )
    })
  }

  archive(
    id: string,
    actor: string
  ): WorkspaceRegion {
    this.calls.push({
      kind: 'archive',
      value: { id, actor }
    })
    return workspace({
      id,
      status: 'archived'
    })
  }

  restore(
    id: string,
    actor: string
  ): WorkspaceRegion {
    this.calls.push({
      kind: 'restore',
      value: { id, actor }
    })
    return workspace({
      id,
      status: 'active'
    })
  }

  audit(
    id: string,
    actor: string,
    limit = 50
  ) {
    this.calls.push({
      kind: 'audit',
      value: {
        id,
        actor,
        limit
      }
    })
    return [{
      eventId: 'audit-1',
      workspaceId: id,
      actorPrincipal: actor,
      action: 'created' as const,
      safeSummary:
        'Workspace created',
      sourceSelectionId:
        'selection-1',
      createdAt: 10
    }]
  }
}

function server(
  management?: ControlWorkspaceManagementPort
) {
  const control = new ControlServer({
    host: '127.0.0.1',
    port: 0,
    goals: new NoopGoals(),
    state: {
      snapshot: () => ({
        connected: false,
        spawned: false,
        health: 0,
        food: 0,
        dimension: 'overworld',
        position: null,
        nearbyPlayers: [],
        inventory: [],
        recentEvents: []
      })
    },
    memory: new NoopMemory(),
    events: new NoopEvents(),
    ...(management
      ? {
          workspaceManagement:
            management
        }
      : {})
  })
  return control
}

async function json(
  response: Response
): Promise<any> {
  return response.json()
}

test('workspace create/list/get API is bounded and never accepts caller coordinates', async () => {
  const management =
    new FakeWorkspaceManagement()
  const control = server(management)
  const address =
    await control.start()

  try {
    const invalid =
      await fetch(
        address.baseUrl +
          '/v1/workspaces',
        {
          method: 'POST',
          headers: {
            'content-type':
              'application/json'
          },
          body: JSON.stringify({
            actor_principal:
              'player-1',
            dimension: 'overworld',
            label: '農田',
            purpose: 'farm',
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
            }
          })
        }
      )

    assert.equal(
      invalid.status,
      400
    )
    assert.equal(
      management.calls.length,
      0
    )

    const created =
      await fetch(
        address.baseUrl +
          '/v1/workspaces',
        {
          method: 'POST',
          headers: {
            'content-type':
              'application/json'
          },
          body: JSON.stringify({
            actor_principal:
              'player-1',
            dimension: 'overworld',
            label: '農田',
            purpose: 'farm',
            tags: ['crop'],
            constraints: {
              requested_spacing: 5
            }
          })
        }
      )

    assert.equal(
      created.status,
      201
    )
    const createdBody =
      await json(created)
    assert.equal(
      createdBody.workspace.label,
      '農田'
    )
    assert.equal(
      createdBody.workspace
        .constraints
        .requested_spacing,
      5
    )
    assert.deepEqual(
      management.calls[0]?.value,
      {
        dimension: 'overworld',
        actorPrincipal: 'player-1',
        label: '農田',
        purpose: 'farm',
        tags: ['crop'],
        constraints: {
          requestedSpacing: 5
        }
      }
    )

    const listed =
      await fetch(
        address.baseUrl +
          '/v1/workspaces' +
          '?actor_principal=player-1' +
          '&dimension=overworld' +
          '&include_archived=true'
      )
    assert.equal(
      listed.status,
      200
    )

    const got =
      await fetch(
        address.baseUrl +
          '/v1/workspaces/workspace-1' +
          '?actor_principal=player-1'
      )
    assert.equal(got.status, 200)

    assert.deepEqual(
      management.calls
        .slice(0, 3)
        .map(call => call.kind),
      ['create', 'list', 'get']
    )
  } finally {
    await control.close()
  }
})

test('workspace mutation endpoints map one action each and expose audit without physical purge', async () => {
  const management =
    new FakeWorkspaceManagement()
  const control = server(management)
  const address =
    await control.start()

  const post = async (
    action: string,
    body: unknown
  ) => fetch(
    address.baseUrl +
      '/v1/workspaces/workspace-1/' +
      action,
    {
      method: 'POST',
      headers: {
        'content-type':
          'application/json'
      },
      body: JSON.stringify(body)
    }
  )

  try {
    assert.equal(
      (await post('rename', {
        actor_principal:
          'player-1',
        label: '東側農田'
      })).status,
      200
    )

    assert.equal(
      (await post('resize', {
        actor_principal:
          'player-1'
      })).status,
      200
    )

    assert.equal(
      (await post('purpose', {
        actor_principal:
          'player-1',
        purpose: 'production'
      })).status,
      200
    )

    assert.equal(
      (await post('tags', {
        actor_principal:
          'player-1',
        tags: [
          'smelting',
          'fast'
        ]
      })).status,
      200
    )

    assert.equal(
      (await post('constraints', {
        actor_principal:
          'player-1',
        constraints: {
          requested_spacing: 6
        }
      })).status,
      200
    )

    assert.equal(
      (await post('archive', {
        actor_principal:
          'player-1'
      })).status,
      200
    )

    assert.equal(
      (await post('restore', {
        actor_principal:
          'player-1'
      })).status,
      200
    )

    assert.deepEqual(
      management.calls.find(
        call =>
          call.kind === 'constraints'
      )?.value,
      {
        id: 'workspace-1',
        actor: 'player-1',
        constraints: {
          requestedSpacing: 6
        }
      }
    )

    const audit =
      await fetch(
        address.baseUrl +
          '/v1/workspaces/workspace-1/audit' +
          '?actor_principal=player-1' +
          '&limit=10'
      )
    assert.equal(
      audit.status,
      200
    )
    assert.equal(
      (await json(audit))
        .audit[0]
        .action,
      'created'
    )

    assert.deepEqual(
      management.calls.map(
        call => call.kind
      ),
      [
        'rename',
        'resize',
        'purpose',
        'tags',
        'constraints',
        'archive',
        'restore',
        'audit'
      ]
    )

    const purge =
      await fetch(
        address.baseUrl +
          '/v1/workspaces/workspace-1/delete',
        {
          method: 'POST',
          headers: {
            'content-type':
              'application/json'
          },
          body: JSON.stringify({
            actor_principal:
              'player-1'
          })
        }
      )
    assert.equal(
      purge.status,
      404
    )
  } finally {
    await control.close()
  }
})

test('workspace API maps management failure codes without leaking internal errors', async () => {
  const management =
    new FakeWorkspaceManagement()
  management.create = () => {
    throw new WorkspaceManagementError(
      'workspace_selection_stale'
    )
  }

  const control = server(management)
  const address =
    await control.start()

  try {
    const response =
      await fetch(
        address.baseUrl +
          '/v1/workspaces',
        {
          method: 'POST',
          headers: {
            'content-type':
              'application/json'
          },
          body: JSON.stringify({
            actor_principal:
              'player-1',
            dimension: 'overworld',
            label: '區域',
            purpose: 'custom'
          })
        }
      )

    assert.equal(
      response.status,
      503
    )
    assert.deepEqual(
      await json(response),
      {
        error:
          'workspace_selection_stale'
      }
    )
  } finally {
    await control.close()
  }
})

test('workspace API is unavailable when management service is not wired', async () => {
  const control = server()
  const address =
    await control.start()

  try {
    const response =
      await fetch(
        address.baseUrl +
          '/v1/workspaces' +
          '?actor_principal=player-1'
      )
    assert.equal(
      response.status,
      503
    )
    assert.deepEqual(
      await json(response),
      {
        error:
          'workspace_management_unavailable'
      }
    )
  } finally {
    await control.close()
  }
})
