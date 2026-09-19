import assert from 'node:assert/strict'
import test from 'node:test'
import type { GoalRecord, GoalRequest, GoalSource } from '../../src/contracts/goals.js'
import type { RuntimeEvent } from '../../src/contracts/events.js'
import { ControlServer } from '../../src/api/control-server.js'

function state() {
  return {
    connected: true,
    spawned: true,
    health: 20,
    food: 20,
    dimension: 'overworld',
    position: { x: 0, y: 64, z: 0 },
    nearbyPlayers: [],
    inventory: [],
    recentEvents: []
  }
}

const goals = {
  async submit(request: GoalRequest, source: GoalSource): Promise<GoalRecord> {
    return { goalId: 'goal-1', request, source, status: 'running', createdAt: 1, updatedAt: 1 }
  },
  activeGoal(): GoalRecord | null { return null },
  queuedGoals(): readonly GoalRecord[] { return [] },
  async emergencyStop(): Promise<void> {}
}

const events = {
  subscribe(_listener: (event: RuntimeEvent) => void | Promise<void>): () => void {
    return () => {}
  }
}

test('/v1/status exposes only coarse bounded AI routing state', async () => {
  const aiStatus = {
    snapshot() {
      return {
        routineModel: 'gemini-3.5-flash-lite',
        complexModel: 'gemini-3.8-flash',
        available: true,
        activeProject: 'backup-1',
        flashAutoUsedPct: 42,
        manualDeepThinkAvailable: true,
        coordinatorState: 'running' as const,
        activeTaskId: 'task-7',
        activeGoalKind: 'gather_resource' as const,
        pendingTaskCount: 2,
        decisionInFlight: false,
        objective: 'MUST_NOT_LEAK',
        ownerUuid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        projectKey: 'internal-project-a',
        rawError: 'SECRET_STACK',
        apiKey: 'SECRET_KEY'
      }
    }
  }
  const server = new ControlServer({
    host: '127.0.0.1',
    port: 0,
    goals,
    state: { snapshot: state },
    memory: { search: () => [] },
    events,
    aiStatus
  })
  const address = await server.start()
  try {
    const response = await fetch(`${address.baseUrl}/v1/status`)
    assert.equal(response.status, 200)
    const payload = await response.json() as any
    assert.deepEqual(payload.ai, {
      routine_model: 'gemini-3.5-flash-lite',
      complex_model: 'gemini-3.8-flash',
      available: true,
      active_project: 'backup-1',
      flash_auto_used_pct: 42,
      manual_deep_think_available: true,
      coordinator_state: 'running',
      active_task_id: 'task-7',
      active_goal_kind: 'gather_resource',
      pending_task_count: 2,
      decision_in_flight: false
    })
    const serialized = JSON.stringify(payload.ai)
    for (const forbidden of [
      'MUST_NOT_LEAK',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'internal-project-a',
      'SECRET_STACK',
      'SECRET_KEY'
    ]) {
      assert.equal(serialized.includes(forbidden), false)
    }
  } finally {
    await server.close()
  }
})

test('/v1/status remains backward-compatible when no AI status port is supplied', async () => {
  const server = new ControlServer({
    host: '127.0.0.1',
    port: 0,
    goals,
    state: { snapshot: state },
    memory: { search: () => [] },
    events
  })
  const address = await server.start()
  try {
    const response = await fetch(`${address.baseUrl}/v1/status`)
    const payload = await response.json() as any
    assert.equal('ai' in payload, false)
  } finally {
    await server.close()
  }
})
