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
import type {
  WorkspaceChatInstructionRouter,
  WorkspaceChatRouteInput,
  WorkspaceChatRouteResult
} from '../../src/workspace/chat-router.js'

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

class FakeChatOutput {
  readonly messages: string[] = []

  sendMessage(message: string) {
    this.messages.push(message)
    return {
      status: 'sent' as const
    }
  }
}

class FakeWorkspaceChatRouter
implements WorkspaceChatInstructionRouter {
  readonly requests:
    WorkspaceChatRouteInput[] = []
  readonly signals:
    AbortSignal[] = []
  private readonly pending:
    Array<
      (result: WorkspaceChatRouteResult) =>
        void
    > = []

  route(
    input: WorkspaceChatRouteInput,
    signal: AbortSignal
  ): Promise<WorkspaceChatRouteResult> {
    this.requests.push(
      structuredClone(input)
    )
    this.signals.push(signal)
    return new Promise(resolve =>
      this.pending.push(resolve)
    )
  }

  resolveNext(
    result: WorkspaceChatRouteResult
  ): void {
    const resolve =
      this.pending.shift()
    if (!resolve) {
      throw new Error(
        'no pending workspace route'
      )
    }
    resolve(structuredClone(result))
  }
}

function harness(options: {
  readonly workspaceChatRouter?:
    WorkspaceChatInstructionRouter
  readonly identityMode?:
    'online' | 'offline'
  readonly chatOutput?:
    FakeChatOutput
  readonly decisionTimeoutMs?:
    number
  readonly workspaceRouteTimeoutMs?:
    number
} = {}) {
  const events = new RuntimeEventBus()
  const state = new WorldStateCache({ maxRecentEvents: 32 })
  events.subscribe(event => state.apply(event))

  const registry = new SkillRegistry()
  registry.register({
    name: 'stay',
    async execute() { return { status: 'succeeded', code: 'held' } }
  })
  registry.register({
    name: 'go_to',
    async execute() { return { status: 'succeeded', code: 'reached' } }
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
    identityMode:
      options.identityMode ??
      'offline',
    manualAccess: { ownerUuid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', operatorAllowlistUuids: [] },
    worldKey: 'test-world',
    botUsername: 'Moxue_Test',
    logicalExecutor,
    ...(options.workspaceChatRouter
      ? {
          workspaceChatRouter:
            options.workspaceChatRouter
        }
      : {}),
    ...(options.chatOutput
      ? {
          chatOutput:
            options.chatOutput
        }
      : {}),
    decisionGate: new DecisionGate({ safety: new SafetyPolicy(), events }),
    contextBuilder: new ContextBuilder(),
    safetyConstraints: ['PvP is disabled.'],
    nextTaskId: (() => { let value = 0; return () => `task-${++value}` })(),
    nextDecisionId: (() => { let value = 0; return () => `decision-${++value}` })(),
    now: () => 1_000,
    ...(options.decisionTimeoutMs === undefined
      ? {}
      : {
          decisionTimeoutMs:
            options.decisionTimeoutMs
        }),
    ...(options.workspaceRouteTimeoutMs === undefined
      ? {}
      : {
          workspaceRouteTimeoutMs:
            options.workspaceRouteTimeoutMs
        })
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

async function observeTrustedBoss(
  events: RuntimeEventBus
): Promise<void> {
  await events.publish({
    type: 'player_seen',
    at: 2.5,
    player: {
      name: 'Boss',
      id:
        'cccccccc-cccc-cccc-cccc-cccccccccccc',
      position: {
        x: 1,
        y: 64,
        z: 1
      }
    }
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

function goToResult(): LogicalDecisionResult {
  return {
    kind: 'success',
    providerResult: {
      kind: 'structured', provider: 'fake', mode: 'function_call',
      value: {
        version: 2,
        outcome: 'action',
        action: {
          intent: 'go_to',
          args: { x: 4, y: 64, z: 4, radius: 1 }
        }
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

async function startStayGoal(
  current: ReturnType<typeof harness>,
  message = '墨雪 原地待命'
): Promise<string> {
  const beforeRequests = current.logicalExecutor.requests.length
  await current.events.publish({
    type: 'player_chat', at: 3 + beforeRequests, player: 'Boss', message
  })
  await waitFor(() => current.logicalExecutor.requests.length === beforeRequests + 1)
  current.logicalExecutor.resolveNext(stayResult())
  await waitFor(() => current.goals.activeGoal()?.source === 'ai')
  const goalId = current.goals.activeGoal()?.goalId
  assert.ok(goalId)
  return goalId
}

async function startGoToGoal(
  current: ReturnType<typeof harness>,
  message = '墨雪 去那邊看看'
): Promise<string> {
  const beforeRequests = current.logicalExecutor.requests.length
  await current.events.publish({
    type: 'player_chat', at: 30 + beforeRequests, player: 'Boss', message
  })
  await waitFor(() => current.logicalExecutor.requests.length === beforeRequests + 1)
  current.logicalExecutor.resolveNext(goToResult())
  await waitFor(() => current.goals.activeGoal()?.request.kind === 'go_to')
  const goalId = current.goals.activeGoal()?.goalId
  assert.ok(goalId)
  return goalId
}

test('addressed chat with authoritative player id is semantically routed before gameplay AI', async () => {
  const workspace =
    new FakeWorkspaceChatRouter()
  const chatOutput =
    new FakeChatOutput()
  const current = harness({
    workspaceChatRouter:
      workspace,
    identityMode: 'online',
    chatOutput
  })
  await ready(current.events)
  await observeTrustedBoss(
    current.events
  )

  await current.events.publish({
    type: 'player_chat',
    at: 3,
    player: 'Boss',
    playerId:
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
    message:
      '墨雪 這塊以後我自己留著種，你不要拿'
  })

  await waitFor(() =>
    workspace.requests.length === 1
  )
  assert.equal(
    workspace.requests[0]
      ?.utterance,
    '這塊以後我自己留著種，你不要拿'
  )
  assert.equal(
    workspace.requests[0]
      ?.actorPrincipal,
    'cccccccccccccccccccccccccccccccc'
  )
  assert.equal(
    current.logicalExecutor
      .requests.length,
    0
  )

  workspace.resolveNext({
    kind: 'handled',
    operation: 'create'
  })
  await new Promise(resolve =>
    setTimeout(resolve, 5)
  )

  assert.equal(
    current.logicalExecutor
      .requests.length,
    0
  )
  assert.deepEqual(
    chatOutput.messages,
    [
      '收到，我開始處理。',
      '好，我已記住這個區域。'
    ]
  )
  current.coordinator.dispose()
})

test('workspace clarification is visible to the player without starting gameplay AI', async () => {
  const workspace =
    new FakeWorkspaceChatRouter()
  const chatOutput =
    new FakeChatOutput()
  const current = harness({
    workspaceChatRouter:
      workspace,
    identityMode: 'online',
    chatOutput
  })
  await ready(current.events)
  await observeTrustedBoss(
    current.events
  )

  await current.events.publish({
    type: 'player_chat',
    at: 3,
    player: 'Boss',
    playerId:
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
    message:
      '墨雪 這邊設一下'
  })

  await waitFor(() =>
    workspace.requests.length === 1
  )
  workspace.resolveNext({
    kind: 'clarify',
    reason: 'missing_selection'
  })

  await waitFor(() =>
    chatOutput.messages.length === 2
  )
  assert.deepEqual(
    chatOutput.messages,
    [
      '收到，我開始處理。',
      '請先用墨雪設定棍框選區域，再告訴我這裡要設定成什麼。'
    ]
  )
  assert.equal(
    current.logicalExecutor
      .requests.length,
    0
  )
  current.coordinator.dispose()
})

test('workspace not_workspace result falls through to unchanged gameplay AI objective', async () => {
  const workspace =
    new FakeWorkspaceChatRouter()
  const current = harness({
    workspaceChatRouter:
      workspace,
    identityMode: 'online'
  })
  await ready(current.events)
  await observeTrustedBoss(
    current.events
  )

  await current.events.publish({
    type: 'player_chat',
    at: 3,
    player: 'Boss',
    playerId:
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
    message: '墨雪 跟我去山上'
  })

  await waitFor(() =>
    workspace.requests.length === 1
  )
  workspace.resolveNext({
    kind: 'fallback'
  })

  await waitFor(() =>
    current.logicalExecutor
      .requests.length === 1
  )
  assert.equal(
    current.logicalExecutor
      .requests[0]
      ?.context.task?.objective,
    '跟我去山上'
  )
  current.coordinator.dispose()
})

test('workspace semantic routing stays off the coordinator mailbox while state events continue', async () => {
  const workspace =
    new FakeWorkspaceChatRouter()
  const current = harness({
    workspaceChatRouter:
      workspace,
    identityMode: 'online'
  })
  await ready(current.events)
  await observeTrustedBoss(
    current.events
  )

  await current.events.publish({
    type: 'player_chat',
    at: 3,
    player: 'Boss',
    playerId:
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
    message: '墨雪 隨便一種很難理解的說法'
  })
  await waitFor(() =>
    workspace.requests.length === 1
  )

  await current.events.publish({
    type: 'position_changed',
    at: 4,
    position: {
      x: 9,
      y: 64,
      z: 9
    }
  })

  await waitFor(() =>
    current.state.snapshot()
      .position?.x === 9
  )
  assert.equal(
    current.logicalExecutor
      .requests.length,
    0
  )

  workspace.resolveNext({
    kind: 'handled',
    operation: 'show'
  })
  current.coordinator.dispose()
})

test('disconnect aborts pending workspace semantic route and late result cannot create gameplay work', async () => {
  const workspace =
    new FakeWorkspaceChatRouter()
  const current = harness({
    workspaceChatRouter:
      workspace,
    identityMode: 'online'
  })
  await ready(current.events)
  await observeTrustedBoss(
    current.events
  )

  await current.events.publish({
    type: 'player_chat',
    at: 3,
    player: 'Boss',
    playerId:
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
    message: '墨雪 這個先記一下'
  })
  await waitFor(() =>
    workspace.signals.length === 1
  )

  await current.events.publish({
    type: 'disconnected',
    at: 4,
    reason: 'test'
  })
  await waitFor(() =>
    workspace.signals[0]
      ?.aborted === true
  )

  workspace.resolveNext({
    kind: 'fallback'
  })
  await new Promise(resolve =>
    setTimeout(resolve, 5)
  )
  assert.equal(
    current.logicalExecutor
      .requests.length,
    0
  )
  current.coordinator.dispose()
})

test('chat without authoritative player id preserves legacy gameplay path instead of mutating workspace state', async () => {
  const workspace =
    new FakeWorkspaceChatRouter()
  const current = harness({
    workspaceChatRouter:
      workspace,
    identityMode: 'online'
  })
  await ready(current.events)
  await observeTrustedBoss(
    current.events
  )

  await current.events.publish({
    type: 'player_chat',
    at: 3,
    player: 'Boss',
    message: '墨雪 原地待命'
  })

  await waitFor(() =>
    current.logicalExecutor
      .requests.length === 1
  )
  assert.equal(
    workspace.requests.length,
    0
  )
  current.coordinator.dispose()
})

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

test('exact undelimited stone command reaches gameplay routing and is visibly acknowledged', async () => {
  const chatOutput =
    new FakeChatOutput()
  const current = harness({
    chatOutput
  })
  await ready(current.events)

  await current.events.publish({
    type: 'player_chat',
    at: 3,
    player: 'Boss',
    message: '墨雪幫我採一組石頭'
  })

  await waitFor(() =>
    current.logicalExecutor
      .requests.length === 1
  )
  assert.equal(
    current.logicalExecutor
      .requests[0]
      ?.context.task?.objective,
    '幫我採一組石頭'
  )
  assert.deepEqual(
    chatOutput.messages,
    ['收到，我開始處理。']
  )

  current.logicalExecutor
    .resolveNext(completeResult())
  await waitFor(() =>
    current.coordinator.status()
      .activeTaskId === null
  )
  assert.deepEqual(
    chatOutput.messages,
    [
      '收到，我開始處理。',
      '完成了。'
    ]
  )

  current.coordinator.dispose()
})

test('decision watchdog aborts an unresolved provider and terminates the task visibly', async () => {
  const chatOutput =
    new FakeChatOutput()
  const current = harness({
    chatOutput,
    decisionTimeoutMs: 10
  })
  await ready(current.events)

  await current.events.publish({
    type: 'player_chat',
    at: 3,
    player: 'Boss',
    message: '墨雪 幫我做一件事'
  })
  await waitFor(() =>
    current.logicalExecutor
      .signals.length === 1
  )
  const signal =
    current.logicalExecutor.signals[0]
  assert.ok(signal)

  await waitFor(() =>
    signal.aborted &&
    current.coordinator.status()
      .activeTaskId === null
  )

  assert.equal(
    current.coordinator.status()
      .execution,
    'idle'
  )
  assert.deepEqual(
    chatOutput.messages,
    [
      '收到，我開始處理。',
      '這個任務等太久沒有進展，我先停止了。'
    ]
  )

  current.coordinator.dispose()
})

test('workspace semantic watchdog breaks a hung serial route and lets the next addressed chat enter routing', async () => {
  const workspace =
    new FakeWorkspaceChatRouter()
  const chatOutput =
    new FakeChatOutput()
  const current = harness({
    workspaceChatRouter:
      workspace,
    identityMode: 'online',
    chatOutput,
    workspaceRouteTimeoutMs: 10
  })
  await ready(current.events)
  await observeTrustedBoss(
    current.events
  )

  await current.events.publish({
    type: 'player_chat',
    at: 3,
    player: 'Boss',
    playerId:
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
    message: '墨雪 這個區域先處理一下'
  })

  await waitFor(() =>
    workspace.signals[0]
      ?.aborted === true
  )
  await waitFor(() =>
    chatOutput.messages.length === 2
  )
  assert.deepEqual(
    chatOutput.messages,
    [
      '收到，我開始處理。',
      '這個區域操作目前無法安全完成。'
    ]
  )
  assert.equal(
    current.logicalExecutor
      .requests.length,
    0
  )

  await current.events.publish({
    type: 'player_chat',
    at: 4,
    player: 'Boss',
    playerId:
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
    message: '墨雪 再看另一個區域'
  })
  await waitFor(() =>
    workspace.requests.length === 2
  )

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

test('goal completion continues the same task exactly once and carries the previous action into fresh context', async () => {
  const current = harness()
  await ready(current.events)
  const goalId = await startStayGoal(current, '墨雪 原地待命然後再確認')

  await current.goals.completeGoal(goalId, { status: 'succeeded', code: 'held' })
  await waitFor(() => current.logicalExecutor.requests.length === 2)

  assert.equal(current.coordinator.status().activeTaskId, 'task-1')
  assert.equal(current.logicalExecutor.requests[1]?.context.task?.previousAction, 'stay')
  assert.equal(current.logicalExecutor.requests[1]?.context.task?.consecutiveReplans, 0)

  current.logicalExecutor.resolveNext(completeResult())
  await waitFor(() => current.coordinator.status().activeTaskId === null)
  assert.equal(current.coordinator.status().execution, 'idle')

  current.coordinator.dispose()
})

test('stuck and skill failure coalesce until goal_failed then dispatch one Flash-medium replan', async () => {
  const current = harness()
  await ready(current.events)
  const goalId = await startStayGoal(current)

  await current.events.publish({ type: 'stuck', at: 10, code: 'no_path' })
  await current.events.publish({ type: 'skill_failed', at: 11, skill: 'stay', code: 'blocked' })
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(current.logicalExecutor.requests.length, 1)

  await current.goals.completeGoal(goalId, { status: 'failed', code: 'blocked' })
  await waitFor(() => current.logicalExecutor.requests.length === 2)

  const replan = current.logicalExecutor.requests[1]
  assert.equal(replan?.routePlan.routeClass, 'complex')
  assert.equal(replan?.routePlan.thinking, 'medium')
  assert.equal(replan?.routePlan.reserveAuthorized, false)
  assert.equal(replan?.routePlan.reasons.includes('stuck'), true)
  assert.equal(replan?.routePlan.reasons.includes('goal_failed'), true)
  assert.equal(replan?.context.task?.consecutiveReplans, 1)

  current.coordinator.dispose()
})

test('second consecutive goal failure escalates to high without reserve and a later success resets consecutive replans', async () => {
  const current = harness()
  await ready(current.events)
  const firstGoalId = await startStayGoal(current)

  await current.events.publish({ type: 'stuck', at: 10, code: 'no_path' })
  await current.goals.completeGoal(firstGoalId, { status: 'failed', code: 'blocked' })
  await waitFor(() => current.logicalExecutor.requests.length === 2)

  current.logicalExecutor.resolveNext(stayResult())
  await waitFor(() => current.goals.activeGoal()?.goalId === 'goal-2')
  await current.goals.completeGoal('goal-2', { status: 'failed', code: 'blocked_again' })
  await waitFor(() => current.logicalExecutor.requests.length === 3)

  const highReplan = current.logicalExecutor.requests[2]
  assert.equal(highReplan?.routePlan.routeClass, 'complex')
  assert.equal(highReplan?.routePlan.thinking, 'high')
  assert.equal(highReplan?.routePlan.highReason, 'repeated_replanning')
  assert.equal(highReplan?.routePlan.reserveAuthorized, false)
  assert.equal(highReplan?.context.task?.consecutiveReplans, 2)

  current.logicalExecutor.resolveNext(stayResult())
  await waitFor(() => current.goals.activeGoal()?.goalId === 'goal-3')
  await current.goals.completeGoal('goal-3', { status: 'succeeded', code: 'held' })
  await waitFor(() => current.logicalExecutor.requests.length === 4)

  assert.equal(current.logicalExecutor.requests[3]?.context.task?.consecutiveReplans, 0)

  current.coordinator.dispose()
})

test('bounded goal lets a different player task queue and starts it only after the active task completes', async () => {
  const current = harness()
  await ready(current.events)
  const boundedGoalId = await startGoToGoal(current)

  await current.events.publish({
    type: 'player_chat', at: 40, player: 'Alice', message: '墨雪 幫我看背包'
  })
  await new Promise(resolve => setTimeout(resolve, 5))

  assert.equal(current.coordinator.status().pendingTaskCount, 1)
  assert.equal(current.logicalExecutor.requests.length, 1)
  assert.equal(current.goals.activeGoal()?.goalId, boundedGoalId)

  await current.goals.completeGoal(boundedGoalId, { status: 'succeeded', code: 'reached' })
  await waitFor(() => current.logicalExecutor.requests.length === 2)
  assert.equal(current.logicalExecutor.requests[1]?.context.task?.taskId, 'task-1')

  current.logicalExecutor.resolveNext(completeResult())
  await waitFor(() => current.logicalExecutor.requests.length === 3)
  assert.equal(current.logicalExecutor.requests[2]?.context.task?.taskId, 'task-2')
  assert.equal(current.logicalExecutor.requests[2]?.context.task?.objective, '幫我看背包')
  assert.equal(current.coordinator.status().pendingTaskCount, 0)

  current.coordinator.dispose()
})

test('continuous stay goal is safely superseded by a new explicit task instead of blocking the queue', async () => {
  const current = harness()
  await ready(current.events)
  const continuousGoalId = await startStayGoal(current)

  await current.events.publish({
    type: 'player_chat', at: 50, player: 'Alice', message: '墨雪 新任務'
  })
  await waitFor(() => current.logicalExecutor.requests.length === 2)

  assert.equal(current.goals.getGoal(continuousGoalId)?.status, 'cancelled')
  assert.equal(current.coordinator.status().activeTaskId, 'task-2')
  assert.equal(current.coordinator.status().pendingTaskCount, 0)
  assert.equal(current.logicalExecutor.requests[1]?.context.task?.objective, '新任務')

  current.coordinator.dispose()
})

test('pending explicit task queue is capped at eight and never merges different ingress requests', async () => {
  const current = harness()
  await ready(current.events)
  await current.events.publish({
    type: 'player_chat', at: 60, player: 'Boss', message: '墨雪 主任務'
  })
  await waitFor(() => current.logicalExecutor.requests.length === 1)

  for (let index = 0; index < 9; index += 1) {
    await current.events.publish({
      type: 'player_chat',
      at: 61 + index,
      player: index % 2 === 0 ? 'Alice' : 'Bob',
      message: `墨雪 排隊任務${index}`
    })
  }
  await waitFor(() => current.coordinator.status().pendingTaskCount === 8)
  assert.equal(current.logicalExecutor.requests.length, 1)

  current.logicalExecutor.resolveNext(completeResult())
  await waitFor(() => current.logicalExecutor.requests.length === 2)
  assert.equal(current.logicalExecutor.requests[1]?.context.task?.objective, '排隊任務0')
  assert.equal(current.coordinator.status().pendingTaskCount, 7)

  current.coordinator.dispose()
})
