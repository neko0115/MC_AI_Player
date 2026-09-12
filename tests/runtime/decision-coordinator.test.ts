import assert from 'node:assert/strict'
import test from 'node:test'
import { ContextBuilder } from '../../src/agent/context-builder.js'
import { DecisionGate } from '../../src/agent/decision-gate.js'
import type {
  LogicalDecisionRequest,
  LogicalDecisionResult
} from '../../src/agent/routing/contracts.js'
import { GoalManager } from '../../src/goals/goal-manager.js'
import type { MinecraftMemoryRepository } from '../../src/memory/repository.js'
import { MinecraftIdentityRegistry } from '../../src/minecraft/identity-registry.js'
import { DecisionCoordinator } from '../../src/runtime/decision-coordinator.js'
import { SafetyPolicy } from '../../src/safety/policy.js'
import { SkillRegistry } from '../../src/skills/registry.js'
import { WorldStateCache } from '../../src/state/world-state-cache.js'
import { RuntimeEventBus } from '../../src/telemetry/event-bus.js'

class EmptyMemory implements MinecraftMemoryRepository {
  remember(): never { throw new Error('not used') }
  search() { return [] }
  forget() { return false }
  close(): void {}
}

class FakeLogicalExecutor {
  readonly requests: LogicalDecisionRequest[] = []
  readonly signals: AbortSignal[] = []
  private readonly pending: Array<(result: LogicalDecisionResult) => void> = []

  execute(request: LogicalDecisionRequest, signal: AbortSignal): Promise<LogicalDecisionResult> {
    this.requests.push(structuredClone(request))
    this.signals.push(signal)
    return new Promise(resolve => this.pending.push(resolve))
  }

  resolveNext(result: LogicalDecisionResult): void {
    const resolve = this.pending.shift()
    if (!resolve) throw new Error('no pending decision')
    resolve(result)
  }
}

function harness() {
  const events = new RuntimeEventBus()
  const state = new WorldStateCache({ maxRecentEvents: 32 })
  events.subscribe(event => state.apply(event))

  const registry = new SkillRegistry()
  registry.register({
    name: 'stay',
    async execute() { return { status: 'succeeded', code: 'held' } }
  })

  const goals = new GoalManager({
    skillController: { async cancelActive() {} },
    events,
    nextGoalId: (() => {
      let value = 0
      return () => `goal-${++value}`
    })(),
    now: () => 100
  })
  const identity = new MinecraftIdentityRegistry()
  identity.beginSession()
  const logicalExecutor = new FakeLogicalExecutor()

  const coordinator = new DecisionCoordinator({
    events,
    state,
    goals,
    memory: new EmptyMemory(),
    registry,
    identity,
    identityMode: 'offline',
    manualAccess: { ownerUuid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', operatorAllowlistUuids: [] },
    worldKey: 'test-world',
    botUsername: 'Moxue_Test',
    logicalExecutor,
    decisionGate: new DecisionGate({ safety: new SafetyPolicy(), events }),
    contextBuilder: new ContextBuilder(),
    safetyConstraints: ['PvP is disabled.'],
    nextTaskId: (() => { let value = 0; return () => `task-${++value}` })(),
    nextDecisionId: (() => { let value = 0; return () => `decision-${++value}` })(),
    now: () => 1_000
  })
  coordinator.start()
  return { coordinator, events, state, logicalExecutor, goals, registry }
}

async function ready(events: RuntimeEventBus): Promise<void> {
  await events.publish({ type: 'connected', at: 1 })
  await events.publish({
    type: 'spawned', at: 2, dimension: 'overworld',
    position: { x: 0, y: 64, z: 0 }, health: 20, food: 20
  })
}

function completeResult(): LogicalDecisionResult {
  return {
    kind: 'success',
    providerResult: {
      kind: 'structured', provider: 'fake', mode: 'function_call',
      value: { version: 2, outcome: 'complete' }
    }
  }
}

function stayResult(): LogicalDecisionResult {
  return {
    kind: 'success',
    providerResult: {
      kind: 'structured', provider: 'fake', mode: 'function_call',
      value: {
        version: 2,
        outcome: 'action',
        action: { intent: 'stay', args: {} }
      }
    }
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('condition did not become true')
}

test('addressed chat enqueues AI work without blocking RuntimeEventBus on an unresolved provider call', async () => {
  const current = harness()
  await ready(current.events)

  await Promise.race([
    current.events.publish({
      type: 'player_chat', at: 3, player: 'Boss', message: '墨雪 跟我來'
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('event bus waited for AI decision')), 100)
    )
  ])

  await waitFor(() => current.logicalExecutor.requests.length === 1)
  assert.equal(current.coordinator.status().decisionInFlight, true)
  assert.equal(current.logicalExecutor.requests[0]?.context.task?.objective, '跟我來')

  current.coordinator.dispose()
})

test('state-only events update latest state during an in-flight decision without starting a second AI call', async () => {
  const current = harness()
  await ready(current.events)
  await current.events.publish({
    type: 'player_chat', at: 3, player: 'Boss', message: '墨雪 跟我來'
  })
  await waitFor(() => current.logicalExecutor.requests.length === 1)

  await current.events.publish({
    type: 'inventory_changed', at: 4, items: [{ name: 'bread', count: 2 }]
  })
  await current.events.publish({
    type: 'position_changed', at: 5, position: { x: 5, y: 64, z: 5 }
  })
  await new Promise(resolve => setTimeout(resolve, 5))

  assert.equal(current.logicalExecutor.requests.length, 1)
  assert.deepEqual(current.state.snapshot().inventory, [{ name: 'bread', count: 2 }])
  assert.deepEqual(current.state.snapshot().position, { x: 5, y: 64, z: 5 })

  current.coordinator.dispose()
})

test('successful action is gated against latest state before the Coordinator submits one AI goal', async () => {
  const current = harness()
  await ready(current.events)
  await current.events.publish({
    type: 'player_chat', at: 3, player: 'Boss', message: '墨雪 原地待命'
  })
  await waitFor(() => current.logicalExecutor.requests.length === 1)

  current.logicalExecutor.resolveNext(stayResult())
  await waitFor(() => current.goals.activeGoal()?.source === 'ai')

  const goal = current.goals.activeGoal()
  assert.equal(goal?.request.kind, 'stay')
  assert.equal(current.coordinator.status().activeGoalId, goal?.goalId ?? null)
  assert.equal(current.coordinator.status().execution, 'goal_running')
  assert.equal(current.coordinator.status().decisionInFlight, false)

  current.coordinator.dispose()
})

test('complete closes the active task without creating a GoalRequest', async () => {
  const current = harness()
  await ready(current.events)
  await current.events.publish({
    type: 'player_chat', at: 3, player: 'Boss', message: '墨雪 看看是否已完成'
  })
  await waitFor(() => current.logicalExecutor.requests.length === 1)

  current.logicalExecutor.resolveNext(completeResult())
  await waitFor(() => current.coordinator.status().activeTaskId === null)

  assert.equal(current.goals.activeGoal(), null)
  assert.equal(current.coordinator.status().execution, 'idle')

  current.coordinator.dispose()
})

test('emergency stop aborts the in-flight decision and a late provider response cannot resurrect work', async () => {
  const current = harness()
  await ready(current.events)
  await current.events.publish({
    type: 'player_chat', at: 3, player: 'Boss', message: '墨雪 原地待命'
  })
  await waitFor(() => current.logicalExecutor.requests.length === 1)
  const signal = current.logicalExecutor.signals[0]
  assert.ok(signal)

  await current.events.publish({
    type: 'emergency_stop', at: 4, reason: 'operator stop'
  })
  await waitFor(() => signal.aborted)
  assert.equal(current.coordinator.status().activeTaskId, null)

  current.logicalExecutor.resolveNext(stayResult())
  await new Promise(resolve => setTimeout(resolve, 5))

  assert.equal(current.goals.activeGoal(), null)
  assert.equal(current.coordinator.status().execution, 'idle')

  current.coordinator.dispose()
})
