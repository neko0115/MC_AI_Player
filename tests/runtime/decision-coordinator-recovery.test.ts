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

const OWNER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

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

function harness(identityMode: 'online' | 'offline' = 'offline') {
  const events = new RuntimeEventBus()
  const state = new WorldStateCache({ maxRecentEvents: 32 })
  events.subscribe(event => state.apply(event))

  const registry = new SkillRegistry()
  registry.register({ name: 'stay', async execute() { return { status: 'succeeded', code: 'held' } } })

  const goals = new GoalManager({
    skillController: { async cancelActive() {} },
    events,
    nextGoalId: (() => { let value = 0; return () => `goal-${++value}` })(),
    now: () => 100
  })
  const identity = new MinecraftIdentityRegistry()
  const logicalExecutor = new FakeLogicalExecutor()
  let now = 1_000

  const coordinator = new DecisionCoordinator({
    events,
    state,
    goals,
    memory: new EmptyMemory(),
    registry,
    identity,
    identityMode,
    manualAccess: { ownerUuid: OWNER, operatorAllowlistUuids: [] },
    worldKey: 'test-world',
    botUsername: 'Moxue_Test',
    logicalExecutor,
    decisionGate: new DecisionGate({ safety: new SafetyPolicy(), events }),
    contextBuilder: new ContextBuilder(),
    safetyConstraints: ['PvP is disabled.'],
    nextTaskId: (() => { let value = 0; return () => `task-${++value}` })(),
    nextDecisionId: (() => { let value = 0; return () => `decision-${++value}` })(),
    now: () => now
  })
  coordinator.start()
  return {
    coordinator,
    events,
    state,
    goals,
    identity,
    logicalExecutor,
    setNow(value: number) { now = value }
  }
}

async function ready(current: ReturnType<typeof harness>, owner = false): Promise<void> {
  await current.events.publish({ type: 'connected', at: 1 })
  await current.events.publish({
    type: 'spawned', at: 2, dimension: 'overworld',
    position: { x: 0, y: 64, z: 0 }, health: 20, food: 20
  })
  if (owner) {
    await current.events.publish({
      type: 'player_seen',
      at: 3,
      player: { name: 'Boss', id: OWNER, position: { x: 1, y: 64, z: 1 } }
    })
  }
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

async function waitFor(predicate: () => boolean, attempts = 150): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('condition did not become true')
}

async function sendChat(
  current: ReturnType<typeof harness>,
  message: string,
  at = 10,
  playerId?: string
): Promise<void> {
  await current.events.publish({
    type: 'player_chat',
    at,
    player: 'Boss',
    ...(playerId === undefined ? {} : { playerId }),
    message
  })
}

async function startStayGoal(current: ReturnType<typeof harness>): Promise<string> {
  await sendChat(current, '墨雪 原地待命')
  await waitFor(() => current.logicalExecutor.requests.length === 1)
  current.logicalExecutor.resolveNext(stayResult())
  await waitFor(() => current.goals.activeGoal()?.request.kind === 'stay')
  const id = current.goals.activeGoal()?.goalId
  assert.ok(id)
  return id
}

test('timed unavailable schedules exactly one fresh recovery decision from latest state', async () => {
  const current = harness()
  await ready(current)
  await sendChat(current, '墨雪 幫我看看')
  await waitFor(() => current.logicalExecutor.requests.length === 1)

  current.logicalExecutor.resolveNext({ kind: 'unavailable', retryAt: 1_010 })
  await waitFor(() => current.coordinator.status().aiAvailability === 'unavailable')
  await current.events.publish({
    type: 'inventory_changed', at: 11, items: [{ name: 'bread', count: 3 }]
  })
  current.setNow(1_010)

  await waitFor(() => current.logicalExecutor.requests.length === 2)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(current.logicalExecutor.requests.length, 2)
  assert.deepEqual(current.logicalExecutor.requests[1]?.context.inventory, [{ name: 'bread', count: 3 }])
  assert.equal(current.logicalExecutor.requests[1]?.context.task?.taskId, 'task-1')

  current.coordinator.dispose()
})

test('unavailable with null retryAt does not poll or silently switch models', async () => {
  const current = harness()
  await ready(current)
  await sendChat(current, '墨雪 幫我看看')
  await waitFor(() => current.logicalExecutor.requests.length === 1)

  current.logicalExecutor.resolveNext({ kind: 'unavailable', retryAt: null })
  await waitFor(() => current.coordinator.status().aiAvailability === 'unavailable')
  await new Promise(resolve => setTimeout(resolve, 20))

  assert.equal(current.logicalExecutor.requests.length, 1)
  assert.equal(current.coordinator.status().execution, 'decision_pending')

  current.coordinator.dispose()
})

test('disconnect suspends ordinary work, invalidates the in-flight decision, and reconnect spawn makes one fresh decision', async () => {
  const current = harness()
  await ready(current)
  await sendChat(current, '墨雪 幫我看看')
  await waitFor(() => current.logicalExecutor.requests.length === 1)
  const firstSignal = current.logicalExecutor.signals[0]
  assert.ok(firstSignal)

  await current.events.publish({ type: 'disconnected', at: 20, reason: 'network' })
  await waitFor(() => firstSignal.aborted)
  assert.equal(current.coordinator.status().activeTaskId, 'task-1')

  current.logicalExecutor.resolveNext(stayResult())
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(current.goals.activeGoal(), null)

  await current.events.publish({ type: 'connected', at: 21 })
  await current.events.publish({
    type: 'spawned', at: 22, dimension: 'overworld',
    position: { x: 9, y: 65, z: 9 }, health: 19, food: 18
  })
  await waitFor(() => current.logicalExecutor.requests.length === 2)
  await new Promise(resolve => setTimeout(resolve, 5))

  assert.equal(current.logicalExecutor.requests.length, 2)
  assert.deepEqual(current.logicalExecutor.requests[1]?.context.self.position, { x: 9, y: 65, z: 9 })

  current.coordinator.dispose()
})

test('trusted online deep-new creates one Flash-high reserve-authorized decision while offline command cannot', async () => {
  const trusted = harness('online')
  await ready(trusted, true)
  await sendChat(trusted, '!moxue deep 找個安全方法採一個木頭', 10, OWNER)
  await waitFor(() => trusted.logicalExecutor.requests.length === 1)

  const deep = trusted.logicalExecutor.requests[0]
  assert.equal(deep?.context.task?.objective, '找個安全方法採一個木頭')
  assert.equal(deep?.routePlan.routeClass, 'complex')
  assert.equal(deep?.routePlan.thinking, 'high')
  assert.equal(deep?.routePlan.highReason, 'manual_deep_think')
  assert.equal(deep?.routePlan.reserveAuthorized, true)
  trusted.coordinator.dispose()

  const offline = harness('offline')
  await ready(offline)
  await sendChat(offline, '!moxue deep 找個安全方法採一個木頭', 10, OWNER)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(offline.logicalExecutor.requests.length, 0)
  offline.coordinator.dispose()
})

test('trusted deep-current waits for the goal boundary, applies an ephemeral directive once, then returns to normal routing', async () => {
  const current = harness('online')
  await ready(current, true)
  const goalId = await startStayGoal(current)

  await sendChat(current, '!moxue deep current 仔細確認附近狀況', 20, OWNER)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(current.logicalExecutor.requests.length, 1)
  assert.equal(current.goals.activeGoal()?.goalId, goalId)

  await current.goals.completeGoal(goalId, { status: 'succeeded', code: 'held' })
  await waitFor(() => current.logicalExecutor.requests.length === 2)
  const deep = current.logicalExecutor.requests[1]
  assert.equal(deep?.routePlan.thinking, 'high')
  assert.equal(deep?.routePlan.reserveAuthorized, true)
  assert.equal(deep?.context.task?.ephemeralDirective, '仔細確認附近狀況')

  current.logicalExecutor.resolveNext(stayResult())
  await waitFor(() => current.goals.activeGoal()?.goalId === 'goal-2')
  await current.goals.completeGoal('goal-2', { status: 'succeeded', code: 'held' })
  await waitFor(() => current.logicalExecutor.requests.length === 3)
  const ordinary = current.logicalExecutor.requests[2]
  assert.equal(ordinary?.routePlan.thinking, 'low')
  assert.equal(ordinary?.routePlan.reserveAuthorized, false)
  assert.equal(ordinary?.context.task?.ephemeralDirective, undefined)

  current.coordinator.dispose()
})

test('admin deep-think is one-shot and explicit grant invalidation removes reserve authority before dispatch', async () => {
  const current = harness()
  await ready(current)

  const accepted = await current.coordinator.submitAdminDeepThink({ instruction: '規劃一個安全步驟' })
  assert.equal(accepted.kind, 'accepted')
  await waitFor(() => current.logicalExecutor.requests.length === 1)
  assert.equal(current.logicalExecutor.requests[0]?.routePlan.thinking, 'high')
  assert.equal(current.logicalExecutor.requests[0]?.routePlan.reserveAuthorized, true)

  current.logicalExecutor.resolveNext(stayResult())
  await waitFor(() => current.goals.activeGoal()?.goalId === 'goal-1')
  await current.coordinator.submitAdminDeepThink({
    instruction: '只在下一次決策仔細確認',
    targetGoalId: 'goal-1'
  })
  current.coordinator.invalidateManualGrants()
  await current.goals.completeGoal('goal-1', { status: 'succeeded', code: 'held' })
  await waitFor(() => current.logicalExecutor.requests.length === 2)

  assert.equal(current.logicalExecutor.requests[1]?.routePlan.reserveAuthorized, false)
  assert.equal(current.logicalExecutor.requests[1]?.context.task?.ephemeralDirective, undefined)

  await current.coordinator.clearAiWork('test_clear')
  assert.equal(current.coordinator.status().activeTaskId, null)
  assert.equal(current.coordinator.status().pendingTaskCount, 0)

  current.coordinator.dispose()
})
