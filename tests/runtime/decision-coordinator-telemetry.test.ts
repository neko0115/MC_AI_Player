import assert from 'node:assert/strict'
import test from 'node:test'
import { ContextBuilder } from '../../src/agent/context-builder.js'
import { DecisionGate } from '../../src/agent/decision-gate.js'
import type {
  LogicalDecisionRequest,
  LogicalDecisionResult
} from '../../src/agent/routing/contracts.js'
import type { RuntimeEvent } from '../../src/contracts/events.js'
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
  private readonly pending: Array<(result: LogicalDecisionResult) => void> = []

  execute(request: LogicalDecisionRequest): Promise<LogicalDecisionResult> {
    this.requests.push(structuredClone(request))
    return new Promise(resolve => this.pending.push(resolve))
  }

  resolveNext(result: LogicalDecisionResult): void {
    const resolve = this.pending.shift()
    if (!resolve) throw new Error('no pending decision')
    resolve(result)
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
      value: { version: 2, outcome: 'action', action: { intent: 'stay', args: {} } }
    }
  }
}

function harness() {
  const events = new RuntimeEventBus()
  const state = new WorldStateCache({ maxRecentEvents: 32 })
  const observed: RuntimeEvent[] = []
  events.subscribe(event => state.apply(event))
  events.subscribe(event => {
    if (
      event.type === 'complexity_assessment' ||
      event.type === 'ai_availability_changed' ||
      event.type === 'task_started' ||
      event.type === 'task_completed' ||
      event.type === 'task_blocked' ||
      event.type === 'task_superseded'
    ) observed.push(structuredClone(event))
  })

  const registry = new SkillRegistry()
  registry.register({ name: 'stay', async execute() { return { status: 'succeeded', code: 'held' } } })
  const goals = new GoalManager({
    skillController: { async cancelActive() {} },
    events,
    nextGoalId: (() => { let value = 0; return () => `goal-${++value}` })(),
    now: () => 100
  })
  const logicalExecutor = new FakeLogicalExecutor()
  let now = 1_000
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
    now: () => now
  })
  coordinator.start()
  return {
    coordinator,
    events,
    goals,
    logicalExecutor,
    observed,
    setNow(value: number) { now = value }
  }
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

test('Coordinator publishes bounded task-start and complexity metadata without objective text', async () => {
  const current = harness()
  await ready(current)
  await current.events.publish({
    type: 'player_chat', at: 3, player: 'Boss', message: '墨雪 原地待命然後再確認'
  })
  await waitFor(() => current.logicalExecutor.requests.length === 1)
  await waitFor(() => current.observed.some(event => event.type === 'complexity_assessment'))

  assert.deepEqual(current.observed.slice(0, 2), [
    { type: 'task_started', at: 1_000, taskId: 'task-1', source: 'minecraft' },
    {
      type: 'complexity_assessment', at: 1_000,
      decisionId: 'decision-1', taskId: 'task-1', score: 3,
      routeClass: 'routine', thinking: 'low', reasons: ['multi_step'], highReason: null
    }
  ])
  const serialized = JSON.stringify(current.observed)
  assert.equal(serialized.includes('原地待命'), false)
  assert.equal(serialized.includes('Boss'), false)

  current.coordinator.dispose()
})

test('complete and provider safety block publish terminal task events and remove active work', async () => {
  const complete = harness()
  await ready(complete)
  await complete.events.publish({ type: 'player_chat', at: 3, player: 'Boss', message: '墨雪 看看完成沒' })
  await waitFor(() => complete.logicalExecutor.requests.length === 1)
  complete.logicalExecutor.resolveNext(completeResult())
  await waitFor(() => complete.coordinator.status().activeTaskId === null)
  assert.equal(
    complete.observed.some(event => event.type === 'task_completed' && event.taskId === 'task-1'),
    true
  )
  complete.coordinator.dispose()

  const blocked = harness()
  await ready(blocked)
  await blocked.events.publish({ type: 'player_chat', at: 3, player: 'Boss', message: '墨雪 做這件事' })
  await waitFor(() => blocked.logicalExecutor.requests.length === 1)
  blocked.logicalExecutor.resolveNext({ kind: 'safety_blocked', code: 'content_blocked' })
  await waitFor(() => blocked.coordinator.status().activeTaskId === null)
  assert.equal(
    blocked.observed.some(event =>
      event.type === 'task_blocked' && event.taskId === 'task-1' && event.code === 'content_blocked'
    ),
    true
  )
  blocked.coordinator.dispose()
})

test('AI availability telemetry emits only on real transitions and recovery returns to available once', async () => {
  const current = harness()
  await ready(current)
  await current.events.publish({ type: 'player_chat', at: 3, player: 'Boss', message: '墨雪 幫我看看' })
  await waitFor(() => current.logicalExecutor.requests.length === 1)

  current.logicalExecutor.resolveNext({ kind: 'unavailable', retryAt: 1_010 })
  await waitFor(() => current.observed.some(event => event.type === 'ai_availability_changed'))
  assert.deepEqual(
    current.observed.filter(event => event.type === 'ai_availability_changed'),
    [{ type: 'ai_availability_changed', at: 1_000, available: false, retryAt: 1_010 }]
  )

  current.setNow(1_010)
  await waitFor(() => current.logicalExecutor.requests.length === 2)
  await waitFor(() => current.observed.filter(event => event.type === 'ai_availability_changed').length === 2)
  assert.deepEqual(
    current.observed.filter(event => event.type === 'ai_availability_changed'),
    [
      { type: 'ai_availability_changed', at: 1_000, available: false, retryAt: 1_010 },
      { type: 'ai_availability_changed', at: 1_010, available: true, retryAt: null }
    ]
  )

  current.logicalExecutor.resolveNext(completeResult())
  await waitFor(() => current.coordinator.status().activeTaskId === null)
  assert.equal(
    current.observed.filter(event => event.type === 'ai_availability_changed').length,
    2
  )
  current.coordinator.dispose()
})

test('direct player takeover publishes task_superseded without leaking the replacement request', async () => {
  const current = harness()
  await ready(current)
  await current.events.publish({ type: 'player_chat', at: 3, player: 'Boss', message: '墨雪 原地待命' })
  await waitFor(() => current.logicalExecutor.requests.length === 1)
  current.logicalExecutor.resolveNext(stayResult())
  await waitFor(() => current.goals.activeGoal()?.source === 'ai')

  await current.goals.submit({ kind: 'stay', args: {} }, 'player')
  await waitFor(() => current.coordinator.status().activeTaskId === null)

  assert.equal(
    current.observed.some(event =>
      event.type === 'task_superseded' &&
      event.taskId === 'task-1' &&
      event.code === 'preempted_by_player'
    ),
    true
  )
  current.coordinator.dispose()
})
