import assert from 'node:assert/strict'
import test from 'node:test'
import type { GoalRecord } from '../../src/contracts/goals.js'
import type { Position } from '../../src/contracts/events.js'
import type { SkillResult } from '../../src/contracts/skills.js'
import { ThreatSupervisor } from '../../src/runtime/threat-supervisor.js'
import { RuntimeEventBus } from '../../src/telemetry/event-bus.js'
import { WorldStateCache } from '../../src/state/world-state-cache.js'

class FakeGoals {
  goal: GoalRecord | null = {
    goalId: 'goal-1',
    request: {
      kind: 'gather_resource',
      args: {
        resource: 'iron_ore',
        quantity: 16
      }
    },
    status: 'running',
    source: 'ai',
    createdAt: 1,
    updatedAt: 1
  }
  suspendCalls = 0

  activeGoal(): GoalRecord | null {
    return this.goal ? structuredClone(this.goal) : null
  }

  async suspendActive(): Promise<boolean> {
    if (!this.goal || this.goal.status !== 'running') return false
    this.suspendCalls += 1
    this.goal.status = 'suspended'
    return true
  }

  async resumeSuspended(): Promise<boolean> {
    if (!this.goal || this.goal.status !== 'suspended') return false
    this.goal.status = 'running'
    return true
  }
}

class FakeNavigation {
  readonly calls: Position[] = []

  async goTo(
    position: Position,
    _options: {
      readonly range: number
      readonly canDig: false
    },
    signal: AbortSignal
  ): Promise<SkillResult> {
    if (signal.aborted) {
      return {
        status: 'cancelled',
        code: 'cancelled'
      }
    }
    this.calls.push({ ...position })
    return {
      status: 'succeeded',
      code: 'reached'
    }
  }
}

function workspace(
  overrides: Record<string, unknown> = {}
) {
  return {
    id: 'workspace-iron-farm',
    worldKey: 'test-world',
    dimension: 'overworld',
    bounds: {
      min: { x: 0, y: 60, z: 0 },
      max: { x: 10, y: 70, z: 10 }
    },
    label: '鐵巨人農場',
    purpose: 'farm',
    moxueUsePolicy: 'shared',
    status: 'active',
    tags: ['iron-farm'],
    constraints: {
      controlledHostiles: [{
        kind: 'zombie',
        maxCount: 1
      }]
    },
    ownerPrincipal: 'owner-1',
    sourceSelectionId: 'selection-1',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

interface TestWorkspaceSource {
  snapshot(): {
    readonly state:
      'current' | 'stale' | 'unavailable'
    readonly workspaces:
      readonly unknown[]
  }
  subscribe?(
    listener: () => void
  ): () => void
}

function runtime(
  input:
    (() => ReturnType<
      TestWorkspaceSource['snapshot']
    >) |
    TestWorkspaceSource
) {
  const events = new RuntimeEventBus()
  const state = new WorldStateCache({
    maxRecentEvents: 64
  })
  events.subscribe(event => {
    state.apply(event)
  })
  const goals = new FakeGoals()
  const navigation = new FakeNavigation()
  const supervisor = new ThreatSupervisor({
    events,
    state,
    goals,
    navigation,
    retryCooldownMs: 0,
    workspaceContext: {
      worldKey: 'test-world',
      source:
        typeof input === 'function'
          ? {
              snapshot: input
            }
          : input
    }
  } as ConstructorParameters<
    typeof ThreatSupervisor
  >[0])
  supervisor.start()
  return {
    events,
    goals,
    navigation,
    supervisor
  }
}

async function ready(
  events: RuntimeEventBus
): Promise<void> {
  await events.publish({
    type: 'connected',
    at: 1
  })
  await events.publish({
    type: 'spawned',
    at: 2,
    dimension: 'overworld',
    position: {
      x: 5,
      y: 64,
      z: 5
    },
    health: 20,
    food: 20
  })
}

async function settle(): Promise<void> {
  await new Promise(resolve =>
    setTimeout(resolve, 10)
  )
}

async function waitFor(
  predicate: () => boolean
): Promise<void> {
  for (
    let attempt = 0;
    attempt < 100;
    attempt += 1
  ) {
    if (predicate()) return
    await new Promise(resolve =>
      setTimeout(resolve, 2)
    )
  }
  throw new Error(
    'condition did not become true'
  )
}

test('one exact controlled hostile inside an active Workspace is tolerated', async () => {
  const current = runtime(() => ({
    state: 'current',
    workspaces: [workspace()]
  }))
  try {
    await ready(current.events)
    await current.events.publish({
      type: 'hostile_seen',
      at: 3,
      hostile: {
        entityId: 21,
        kind: 'zombie',
        position: {
          x: 6.5,
          y: 64,
          z: 5.5
        }
      }
    })
    await settle()

    assert.equal(
      current.goals.suspendCalls,
      0
    )
    assert.deepEqual(
      current.navigation.calls,
      []
    )
  } finally {
    current.supervisor.dispose()
  }
})

test('controlled hostile count above the Workspace bound restores normal threat response', async () => {
  const current = runtime(() => ({
    state: 'current',
    workspaces: [workspace()]
  }))
  try {
    await ready(current.events)
    await current.events.publish({
      type: 'hostile_seen',
      at: 3,
      hostile: {
        entityId: 21,
        kind: 'zombie',
        position: {
          x: 6,
          y: 64,
          z: 5
        }
      }
    })
    await current.events.publish({
      type: 'hostile_seen',
      at: 4,
      hostile: {
        entityId: 22,
        kind: 'zombie',
        position: {
          x: 7,
          y: 64,
          z: 5
        }
      }
    })

    await waitFor(() =>
      current.goals.suspendCalls === 1
    )
    assert.ok(
      current.navigation.calls.length >= 1
    )
  } finally {
    current.supervisor.dispose()
  }
})

test('controlled hostile leaving the Workspace immediately restores normal threat response', async () => {
  const current = runtime(() => ({
    state: 'current',
    workspaces: [workspace()]
  }))
  try {
    await ready(current.events)
    await current.events.publish({
      type: 'hostile_seen',
      at: 3,
      hostile: {
        entityId: 21,
        kind: 'zombie',
        position: {
          x: 6,
          y: 64,
          z: 5
        }
      }
    })
    await settle()
    assert.equal(
      current.goals.suspendCalls,
      0
    )

    await current.events.publish({
      type: 'hostile_seen',
      at: 4,
      hostile: {
        entityId: 21,
        kind: 'zombie',
        position: {
          x: 11,
          y: 64,
          z: 5
        }
      }
    })

    await waitFor(() =>
      current.goals.suspendCalls === 1
    )
  } finally {
    current.supervisor.dispose()
  }
})

test('stale Workspace safety metadata never suppresses a hostile', async () => {
  const current = runtime(() => ({
    state: 'stale',
    workspaces: [workspace()]
  }))
  try {
    await ready(current.events)
    await current.events.publish({
      type: 'hostile_seen',
      at: 3,
      hostile: {
        entityId: 21,
        kind: 'zombie',
        position: {
          x: 6,
          y: 64,
          z: 5
        }
      }
    })

    await waitFor(() =>
      current.goals.suspendCalls === 1
    )
  } finally {
    current.supervisor.dispose()
  }
})

test('archived or kind-mismatched Workspace metadata never suppresses a hostile', async () => {
  for (const candidate of [
    workspace({
      status: 'archived'
    }),
    workspace({
      constraints: {
        controlledHostiles: [{
          kind: 'skeleton',
          maxCount: 1
        }]
      }
    })
  ]) {
    const current = runtime(() => ({
      state: 'current',
      workspaces: [candidate]
    }))
    try {
      await ready(current.events)
      await current.events.publish({
        type: 'hostile_seen',
        at: 3,
        hostile: {
          entityId: 21,
          kind: 'zombie',
          position: {
            x: 6,
            y: 64,
            z: 5
          }
        }
      })

      await waitFor(() =>
        current.goals.suspendCalls === 1
      )
    } finally {
      current.supervisor.dispose()
    }
  }
})


test('archiving a Workspace invalidates an already-tolerated hostile without waiting for entity movement', async () => {
  let currentWorkspace =
    workspace()
  const listeners =
    new Set<() => void>()
  const source: TestWorkspaceSource = {
    snapshot() {
      return {
        state: 'current',
        workspaces: [
          currentWorkspace
        ]
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
  const current = runtime(source)

  try {
    await ready(current.events)
    await current.events.publish({
      type: 'hostile_seen',
      at: 3,
      hostile: {
        entityId: 21,
        kind: 'zombie',
        position: {
          x: 6,
          y: 64,
          z: 5
        }
      }
    })
    await settle()
    assert.equal(
      current.goals.suspendCalls,
      0
    )

    currentWorkspace =
      workspace({
        status: 'archived'
      })
    for (
      const listener of listeners
    ) {
      listener()
    }

    await waitFor(() =>
      current.goals.suspendCalls === 1
    )
  } finally {
    current.supervisor.dispose()
  }
})

test('a stale Workspace source invalidates an already-tolerated hostile immediately', async () => {
  let sourceState:
    'current' | 'stale' =
      'current'
  const listeners =
    new Set<() => void>()
  const source: TestWorkspaceSource = {
    snapshot() {
      return {
        state: sourceState,
        workspaces: [workspace()]
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
  const current = runtime(source)

  try {
    await ready(current.events)
    await current.events.publish({
      type: 'hostile_seen',
      at: 3,
      hostile: {
        entityId: 21,
        kind: 'zombie',
        position: {
          x: 6,
          y: 64,
          z: 5
        }
      }
    })
    await settle()
    assert.equal(
      current.goals.suspendCalls,
      0
    )

    sourceState = 'stale'
    for (
      const listener of listeners
    ) {
      listener()
    }

    await waitFor(() =>
      current.goals.suspendCalls === 1
    )
  } finally {
    current.supervisor.dispose()
  }
})
