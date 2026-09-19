import assert from 'node:assert/strict'
import test from 'node:test'
import type { GoalRecord } from '../../src/contracts/goals.js'
import type { Position } from '../../src/contracts/events.js'
import type { SkillResult } from '../../src/contracts/skills.js'
import { RuntimeEventBus } from '../../src/telemetry/event-bus.js'
import { WorldStateCache } from '../../src/state/world-state-cache.js'
import { ThreatSupervisor } from '../../src/runtime/threat-supervisor.js'

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
    source: 'player',
    createdAt: 1,
    updatedAt: 1
  }
  suspendCalls = 0
  resumeCalls = 0

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
    this.resumeCalls += 1
    this.goal.status = 'running'
    return true
  }
}

class FakeNavigation {
  readonly calls: Array<{
    position: Position
    canDig: false
  }> = []
  result: SkillResult = {
    status: 'succeeded',
    code: 'reached'
  }

  async goTo(
    position: Position,
    options: { readonly range: number; readonly canDig: false },
    signal: AbortSignal
  ): Promise<SkillResult> {
    if (signal.aborted) {
      return {
        status: 'cancelled',
        code: 'cancelled'
      }
    }
    this.calls.push({
      position: { ...position },
      canDig: options.canDig
    })
    return { ...this.result }
  }
}

function runtime() {
  const events = new RuntimeEventBus()
  const state = new WorldStateCache({
    maxRecentEvents: 64
  })
  events.subscribe(event => {
    state.apply(event)
  })
  const goals = new FakeGoals()
  const navigation = new FakeNavigation()
  let now = 1000
  const supervisor = new ThreatSupervisor({
    events,
    state,
    goals,
    navigation,
    now: () => now,
    retryCooldownMs: 0
  })
  supervisor.start()

  return {
    events,
    state,
    goals,
    navigation,
    supervisor,
    advance(ms: number) {
      now += ms
    }
  }
}

async function spawnReady(
  events: RuntimeEventBus,
  position: Position = { x: 0, y: 64, z: 0 }
): Promise<void> {
  await events.publish({
    type: 'connected',
    at: 1
  })
  await events.publish({
    type: 'spawned',
    at: 2,
    dimension: 'overworld',
    position,
    health: 20,
    food: 20
  })
}

test('nearby creeper suspends the current goal and retreats without digging', async () => {
  const current = runtime()
  try {
    await spawnReady(current.events)

    await current.events.publish({
      type: 'hostile_seen',
      at: 3,
      hostile: {
        entityId: 7,
        kind: 'creeper',
        position: { x: 5, y: 64, z: 0 }
      }
    })

    await waitFor(() => current.navigation.calls.length >= 1)

    assert.equal(current.goals.suspendCalls, 1)
    assert.equal(current.goals.goal?.status, 'suspended')
    assert.equal(current.navigation.calls[0]?.canDig, false)
    assert.ok((current.navigation.calls[0]?.position.x ?? 0) < 0)
  } finally {
    current.supervisor.dispose()
  }
})

test('moving beyond the threat clearance radius resumes the same suspended goal', async () => {
  const current = runtime()
  try {
    await spawnReady(current.events)

    await current.events.publish({
      type: 'hostile_seen',
      at: 3,
      hostile: {
        entityId: 7,
        kind: 'creeper',
        position: { x: 5, y: 64, z: 0 }
      }
    })
    await waitFor(() => current.goals.goal?.status === 'suspended')

    await current.events.publish({
      type: 'position_changed',
      at: 4,
      position: { x: -20, y: 64, z: 0 }
    })
    await waitFor(() => current.goals.resumeCalls === 1)

    assert.equal(current.goals.goal?.goalId, 'goal-1')
    assert.equal(current.goals.goal?.status, 'running')
  } finally {
    current.supervisor.dispose()
  }
})

test('hostile disappearance resumes a goal even after every retreat path failed', async () => {
  const current = runtime()
  current.navigation.result = {
    status: 'failed',
    code: 'no_path'
  }

  try {
    await spawnReady(current.events)

    await current.events.publish({
      type: 'hostile_seen',
      at: 3,
      hostile: {
        entityId: 9,
        kind: 'zombie',
        position: { x: 4, y: 64, z: 0 }
      }
    })
    await waitFor(() => current.navigation.calls.length === 3)

    assert.equal(current.goals.goal?.status, 'suspended')

    await current.events.publish({
      type: 'hostile_left',
      at: 4,
      entityId: 9
    })
    await waitFor(() => current.goals.resumeCalls === 1)

    assert.equal(current.goals.goal?.status, 'running')
  } finally {
    current.supervisor.dispose()
  }
})

test('low health expands the retreat trigger radius', async () => {
  const current = runtime()
  try {
    await spawnReady(current.events)
    await current.events.publish({
      type: 'health_changed',
      at: 3,
      health: 8,
      food: 20
    })
    await current.events.publish({
      type: 'hostile_seen',
      at: 4,
      hostile: {
        entityId: 11,
        kind: 'zombie',
        position: { x: 14, y: 64, z: 0 }
      }
    })

    await waitFor(() => current.goals.suspendCalls === 1)
    assert.ok(current.navigation.calls.length >= 1)
  } finally {
    current.supervisor.dispose()
  }
})

async function waitFor(
  predicate: () => boolean
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error('condition did not become true')
}
