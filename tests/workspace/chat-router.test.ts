import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  WorkspaceChatIntent,
  WorkspaceIntentInterpreter,
  WorkspaceSemanticContext
} from '../../src/workspace/chat-intent.js'
import {
  WorkspaceChatRouter
} from '../../src/workspace/chat-router.js'
import {
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

class FakeInterpreter
implements WorkspaceIntentInterpreter {
  readonly contexts:
    WorkspaceSemanticContext[] = []
  readonly learned:
    Array<{
      context: WorkspaceSemanticContext
      intent: WorkspaceChatIntent
    }> = []
  intent:
    WorkspaceChatIntent = {
      kind: 'not_workspace'
    }

  async interpret(
    context: WorkspaceSemanticContext,
    _signal: AbortSignal
  ): Promise<WorkspaceChatIntent> {
    this.contexts.push(
      structuredClone(context)
    )
    return structuredClone(
      this.intent
    )
  }

  learnSuccessful(
    context: WorkspaceSemanticContext,
    intent: WorkspaceChatIntent
  ): void {
    this.learned.push({
      context:
        structuredClone(context),
      intent:
        structuredClone(intent)
    })
  }
}

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
    const current =
      this.selection
    if (!current) return null
    if (
      current.worldKey !==
        query.worldKey ||
      current.dimension !==
        query.dimension ||
      current.playerId !==
        query.playerId
    ) {
      return null
    }
    return structuredClone(current)
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

function setup() {
  let id = 0
  const repository =
    new SqliteWorkspaceRepository(
      ':memory:',
      {
        nextId: () =>
          `workspace-${++id}`
      }
    )
  const selections =
    new FakeSelections()
  const management =
    new WorkspaceManagementService({
      worldKey: 'server:survival',
      repository,
      selections
    })
  const interpreter =
    new FakeInterpreter()
  const router =
    new WorkspaceChatRouter({
      worldKey: 'server:survival',
      interpreter,
      management,
      repository,
      selections
    })

  return {
    repository,
    selections,
    management,
    interpreter,
    router
  }
}

test('router preserves arbitrary natural language and lets semantic intent create owner-only workspace', async () => {
  const current = setup()
  try {
    const utterance =
      '這整塊我打算自己慢慢種，你知道這裡就好，裡面的東西不要拿。'

    current.interpreter.intent = {
      kind: 'create',
      label: '我的種植區',
      purpose: 'farm',
      moxueUsePolicy:
        'owner_only'
    }

    const result =
      await current.router.route(
        {
          utterance,
          actorPrincipal:
            'player-1',
          dimension: 'overworld'
        },
        new AbortController().signal
      )

    assert.equal(
      current.interpreter
        .contexts[0]?.utterance,
      utterance
    )
    assert.equal(
      result.kind,
      'handled'
    )
    if (
      result.kind === 'handled'
    ) {
      assert.equal(
        result.workspace
          ?.moxueUsePolicy,
        'owner_only'
      )
      assert.equal(
        result.workspace?.purpose,
        'farm'
      )
    }
    assert.equal(
      current.interpreter
        .learned.length,
      1
    )
    assert.equal(
      current.interpreter
        .learned[0]?.intent.kind,
      'create'
    )
  } finally {
    current.repository.close()
  }
})

test('not_workspace falls through without creating or mutating workspace state', async () => {
  const current = setup()
  try {
    current.interpreter.intent = {
      kind: 'not_workspace'
    }

    const result =
      await current.router.route(
        {
          utterance:
            '跟著我去山上看看',
          actorPrincipal:
            'player-1',
          dimension: 'overworld'
        },
        new AbortController().signal
      )

    assert.deepEqual(
      result,
      { kind: 'fallback' }
    )
    assert.deepEqual(
      current.management.list({
        actorPrincipal:
          'player-1',
        includeArchived: true
      }),
      []
    )
    assert.equal(
      current.interpreter
        .learned.length,
      0
    )
  } finally {
    current.repository.close()
  }
})

test('router uses current trusted selection for create and never accepts coordinates from semantic intent', async () => {
  const current = setup()
  try {
    current.interpreter.intent = {
      kind: 'create',
      label: '給墨雪用的田',
      purpose: 'farm',
      moxueUsePolicy:
        'moxue_preferred'
    }

    const result =
      await current.router.route(
        {
          utterance:
            '這個以後你優先用',
          actorPrincipal:
            'player-1',
          dimension: 'overworld'
        },
        new AbortController().signal
      )

    assert.equal(
      result.kind,
      'handled'
    )
    if (
      result.kind === 'handled'
    ) {
      assert.deepEqual(
        result.workspace?.bounds,
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
      assert.equal(
        result.workspace
          ?.moxueUsePolicy,
        'moxue_preferred'
      )
    }
  } finally {
    current.repository.close()
  }
})

test('router asks for selection instead of guessing when semantic create has no fresh trusted selection', async () => {
  const current = setup()
  try {
    current.selections.state =
      'stale'
    current.interpreter.intent = {
      kind: 'create',
      label: '農田',
      purpose: 'farm',
      moxueUsePolicy: 'shared'
    }

    const result =
      await current.router.route(
        {
          utterance:
            '這裡以後當農田',
          actorPrincipal:
            'player-1',
          dimension: 'overworld'
        },
        new AbortController().signal
      )

    assert.deepEqual(
      result,
      {
        kind: 'clarify',
        reason: 'missing_selection'
      }
    )
    assert.equal(
      current.interpreter
        .learned.length,
      0
    )
  } finally {
    current.repository.close()
  }
})

test('router resolves explicit management targets and changes use policy without phrase logic', async () => {
  const current = setup()
  try {
    const workspace =
      current.management.create({
        dimension: 'overworld',
        actorPrincipal: 'player-1',
        label: '東側倉庫',
        purpose: 'storage'
      })

    current.interpreter.intent = {
      kind: 'change_use_policy',
      target: {
        kind: 'explicit',
        value: '東側倉庫'
      },
      moxueUsePolicy:
        'moxue_preferred'
    }

    const result =
      await current.router.route(
        {
          utterance:
            '那個東邊放東西的地方以後你先用',
          actorPrincipal:
            'player-1',
          dimension: 'overworld'
        },
        new AbortController().signal
      )

    assert.equal(
      result.kind,
      'handled'
    )
    assert.equal(
      current.management.get(
        workspace.id,
        'player-1'
      ).moxueUsePolicy,
      'moxue_preferred'
    )
  } finally {
    current.repository.close()
  }
})

test('ambiguous explicit target produces clarification instead of last-write-wins', async () => {
  const current = setup()
  try {
    current.management.create({
      dimension: 'overworld',
      actorPrincipal: 'player-1',
      label: '農田',
      purpose: 'farm'
    })

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
        x: 28,
        y: 64,
        z: 28
      }
    }

    current.management.create({
      dimension: 'overworld',
      actorPrincipal: 'player-1',
      label: '農田',
      purpose: 'farm'
    })

    current.interpreter.intent = {
      kind: 'archive',
      target: {
        kind: 'explicit',
        value: '農田'
      }
    }

    const result =
      await current.router.route(
        {
          utterance:
            '那個農田不要了',
          actorPrincipal:
            'player-1',
          dimension: 'overworld'
        },
        new AbortController().signal
      )

    assert.equal(
      result.kind,
      'clarify'
    )
    if (
      result.kind === 'clarify'
    ) {
      assert.equal(
        result.reason,
        'ambiguous_reference'
      )
      assert.equal(
        result.candidates?.length,
        2
      )
    }
  } finally {
    current.repository.close()
  }
})

test('archived workspace can be restored through explicit or recent semantic reference only when restore opts in', async () => {
  const current = setup()
  try {
    const workspace =
      current.management.create({
        dimension: 'overworld',
        actorPrincipal: 'player-1',
        label: '舊農田',
        purpose: 'farm'
      })

    current.interpreter.intent = {
      kind: 'archive',
      target: {
        kind: 'explicit',
        value: '舊農田'
      }
    }

    const archived =
      await current.router.route(
        {
          utterance:
            '先把舊農田收起來',
          actorPrincipal:
            'player-1',
          dimension: 'overworld'
        },
        new AbortController().signal
      )
    assert.equal(
      archived.kind,
      'handled'
    )

    current.interpreter.intent = {
      kind: 'restore',
      target: {
        kind: 'recent'
      }
    }

    const restored =
      await current.router.route(
        {
          utterance:
            '剛剛那個還是恢復好了',
          actorPrincipal:
            'player-1',
          dimension: 'overworld'
        },
        new AbortController().signal
      )

    assert.equal(
      restored.kind,
      'handled'
    )
    assert.equal(
      current.management.get(
        workspace.id,
        'player-1'
      ).status,
      'active'
    )
  } finally {
    current.repository.close()
  }
})

test('cancelled semantic routing does not mutate workspace state', async () => {
  const current = setup()
  try {
    const abort =
      new AbortController()
    abort.abort('cancelled')

    current.interpreter.intent = {
      kind: 'create',
      label: '不該建立',
      purpose: 'custom',
      moxueUsePolicy: 'shared'
    }

    const result =
      await current.router.route(
        {
          utterance: '建立這區',
          actorPrincipal:
            'player-1',
          dimension: 'overworld'
        },
        abort.signal
      )

    assert.deepEqual(
      result,
      {
        kind: 'rejected',
        code:
          'workspace_chat_cancelled'
      }
    )
    assert.deepEqual(
      current.management.list({
        actorPrincipal:
          'player-1',
        includeArchived: true
      }),
      []
    )
  } finally {
    current.repository.close()
  }
})
