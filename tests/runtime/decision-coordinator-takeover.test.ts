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

function goToResult(): LogicalDecisionResult {
  return {
    kind: 'success',
    providerResult: {
      kind: 'structured', provider: 'fake', mode: 'function_call',
      value: {
        version: 2,
        outcome: 'action',
        action: { intent: 'go_to', args: { x: 4, y: 64, z: 4, radius: 1 } }
      }
    }
  }
}

function stayResult(): LogicalDecisionResult {
  return {
    kind: 'success',
    providerResult: {
      kind: 'structured', provider: 'fake', mode: 'function_call',
      value: { version: 2, outcome: 'action', action: { intent: 'stay', args: {} } }
    }
  }
}

function harness() {
  const events = new RuntimeEventBus()
  const state = new WorldStateCache({ maxRecentEvents: 32 })
  events.subscribe(event => state.apply(event))
  const registry = new SkillRegistry()
  registry.register({ name: 'stay', async execute() { return { status: 'succeeded', code: 'held' } } })
  registry.register({ name: 'go_to', async execute() { return { status: 'succeeded', code: 'reached' } } })
  const goals = new GoalManager({
    skillController: { async cancelActive() {} },
    events,
    nextGoalId: (() => { let value = 0; return () => `goal-${++value}` })(),
    now: () => 100
  })
  const logicalExecutor = new FakeLogicalExecutor()
  const coordinator = new DecisionCoordinator({
    events,
    state,
    goals,
    memory: new EmptyMemory(),
    registry,
    identity: new MinecraftIdentityRegistry(),
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
  return { coordinator, events, goals, logicalExecutor }
}

async function ready(current: ReturnType<typeof harness>): Promise<void> {
  await current.events.publish({ type: 'connected', at: 1 })
  await current.events.publish({
    type: 'spawned', at: 2, dimension: 'overworld',
    position: { x: 0, y: 64, z: 0 }, health: 20, food: 20
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('condition did not become true')
}

test('direct player goal aborts an in-flight AI decision and late AI success cannot create a goal', async () => {
  const current = harness()
  await ready(current)
  await current.events.publish({
    type: 'player_chat', at: 3, player: 'Boss', message: '墨雪 幫我規劃'
  })
  await waitFor(() => current.logicalExecutor.requests.length === 1)
  const aiSignal = current.logicalExecutor.signals[0]
  assert.ok(aiSignal)

  const playerGoal = await current.goals.submit({ kind: 'stay', args: {} }, 'player')
  await waitFor(() => aiSignal.aborted)
  assert.equal(current.coordinator.status().activeTaskId, null)
  assert.equal(current.goals.activeGoal()?.goalId, playerGoal.goalId)

  current.logicalExecutor.resolveNext(stayResult())
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(current.goals.activeGoal()?.goalId, playerGoal.goalId)
  assert.equal(current.goals.queuedGoals().length, 0)

  current.coordinator.dispose()
})

test('player takeover supersedes active AI goal but preserves queued explicit tasks until player work finishes', async () => {
  const current = harness()
  await ready(current)
  await current.events.publish({
    type: 'player_chat', at: 3, player: 'Boss', message: '墨雪 去那邊'
  })
  await waitFor(() => current.logicalExecutor.requests.length === 1)
  current.logicalExecutor.resolveNext(goToResult())
  await waitFor(() => current.goals.activeGoal()?.request.kind === 'go_to')
  const aiGoalId = current.goals.activeGoal()?.goalId
  assert.ok(aiGoalId)

  await current.events.publish({
    type: 'player_chat', at: 4, player: 'Alice', message: '墨雪 等一下幫我看看'
  })
  await waitFor(() => current.coordinator.status().pendingTaskCount === 1)

  const playerGoal = await current.goals.submit({ kind: 'stay', args: {} }, 'player')
  await waitFor(() => current.coordinator.status().activeTaskId === null)
  assert.equal(current.goals.getGoal(aiGoalId)?.status, 'cancelled')
  assert.equal(current.coordinator.status().pendingTaskCount, 1)
  assert.equal(current.logicalExecutor.requests.length, 1)

  await current.goals.completeGoal(playerGoal.goalId, { status: 'succeeded', code: 'done' })
  await waitFor(() => current.logicalExecutor.requests.length === 2)
  assert.equal(current.logicalExecutor.requests[1]?.context.task?.objective, '等一下幫我看看')
  assert.equal(current.coordinator.status().pendingTaskCount, 0)

  current.coordinator.dispose()
})
