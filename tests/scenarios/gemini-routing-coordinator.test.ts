import assert from 'node:assert/strict'
import test from 'node:test'
import { ContextBuilder, type DecisionContext } from '../../src/agent/context-builder.js'
import { DecisionGate } from '../../src/agent/decision-gate.js'
import {
  RoutedDecisionExecutor,
  type RoutedExecutorLedgerPort,
  type RoutedExecutorTransportPort
} from '../../src/agent/routing/routed-executor.js'
import { ProjectPool } from '../../src/agent/routing/project-pool.js'
import type { RoutingConfigSnapshot } from '../../src/agent/routing/config-manager.js'
import type {
  AttemptSettlement,
  QuotaAdmissionRequest,
  QuotaAdmissionResult
} from '../../src/agent/routing/quota-ledger.js'
import type {
  GeminiAttemptResult,
  PreparedGeminiPayload
} from '../../src/agent/providers/gemini.js'
import type { AttemptLease } from '../../src/agent/routing/contracts.js'
import type { RuntimeEvent } from '../../src/contracts/events.js'
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

function routingSnapshot(): RoutingConfigSnapshot {
  return {
    generation: 1,
    models: {
      routine: {
        name: 'gemini-3.5-flash-lite',
        reservation: {
          inputTokenOverhead: 16,
          generationTokenAllowance: { low: 64 }
        }
      },
      complex: {
        name: 'gemini-3.8-flash',
        reservation: {
          inputTokenOverhead: 16,
          generationTokenAllowance: { medium: 128, high: 256 }
        }
      }
    },
    projects: [
      {
        projectKey: 'pool-a', credentialHandle: 'cred-a',
        providerLimits: {
          routine: { rpm: 100, inputTpm: 1_000_000, rpd: 1_000 },
          complex: { rpm: 100, inputTpm: 1_000_000, rpd: 1_000 }
        },
        flashBudget: {
          requestLimit: 100,
          totalTokenLimit: 1_000_000,
          resetWindow: 'america-los-angeles-day',
          source: 'operator_policy'
        }
      },
      {
        projectKey: 'pool-b', credentialHandle: 'cred-b',
        providerLimits: {
          routine: { rpm: 100, inputTpm: 1_000_000, rpd: 1_000 },
          complex: { rpm: 100, inputTpm: 1_000_000, rpd: 1_000 }
        },
        flashBudget: {
          requestLimit: 100,
          totalTokenLimit: 1_000_000,
          resetWindow: 'america-los-angeles-day',
          source: 'operator_policy'
        }
      }
    ],
    manualAccess: {
      ownerUuid: OWNER,
      operatorAllowlistUuids: []
    }
  }
}

class ScenarioLedger implements RoutedExecutorLedgerPort {
  readonly admissions: QuotaAdmissionRequest[] = []
  readonly dispatched: string[] = []
  readonly settlements: Array<{ id: string; settlement: AttemptSettlement }> = []
  readonly transientDomains = new Set<string>()
  readonly disabledCredentials = new Set<string>()
  forceReserveHigh = false
  unavailableAll = false
  unavailableRetryAt: number | null = null

  credentialDisabled(projectKey: string, processInstanceId: string): boolean {
    return this.disabledCredentials.has(`${processInstanceId}:${projectKey}`)
  }

  admitAttempt(request: QuotaAdmissionRequest): QuotaAdmissionResult {
    this.admissions.push(structuredClone(request))
    if (this.unavailableAll) {
      return {
        kind: 'rejected',
        code: 'domain_unavailable',
        retryAt: this.unavailableRetryAt
      }
    }
    if (this.transientDomains.has(`${request.projectKey}:${request.model}`)) {
      return {
        kind: 'rejected',
        code: 'domain_unavailable',
        retryAt: request.now + 5_000
      }
    }
    if (
      this.forceReserveHigh &&
      request.thinking === 'high' &&
      request.budgetClass === 'normal'
    ) {
      return {
        kind: 'rejected',
        code: 'flash_request_budget',
        retryAt: request.now + 10_000
      }
    }
    return { kind: 'admitted', reservationId: request.attemptId }
  }

  markDispatched(reservationId: string): void {
    this.dispatched.push(reservationId)
  }

  settleAttempt(reservationId: string, settlement: AttemptSettlement): void {
    this.settlements.push({ id: reservationId, settlement: structuredClone(settlement) })
  }

  recordTransientFailure(projectKey: string, model: string): number {
    this.transientDomains.add(`${projectKey}:${model}`)
    return 5_000
  }

  recordDomainSuccess(): void {}

  markQuotaUnavailable(): void {}

  disableCredentialForProcess(
    projectKey: string,
    processInstanceId: string
  ): void {
    this.disabledCredentials.add(`${processInstanceId}:${projectKey}`)
  }

  clearTransient(): void {
    this.transientDomains.clear()
  }
}

interface AttemptRecord {
  readonly context: DecisionContext
  readonly lease: AttemptLease
}

class ScriptedTransport implements RoutedExecutorTransportPort {
  readonly attempts: AttemptRecord[] = []
  private readonly results: GeminiAttemptResult[] = []

  enqueue(...results: GeminiAttemptResult[]): void {
    this.results.push(...results)
  }

  prepare(context: DecisionContext): PreparedGeminiPayload {
    const input = JSON.stringify(context)
    return {
      input,
      systemInstruction: 'test-only',
      tools: [],
      utf8Bytes: Buffer.byteLength(input, 'utf8')
    }
  }

  async execute(
    prepared: PreparedGeminiPayload,
    lease: AttemptLease,
    _signal: AbortSignal
  ): Promise<GeminiAttemptResult> {
    this.attempts.push({
      context: JSON.parse(prepared.input) as DecisionContext,
      lease: structuredClone(lease)
    })
    const next = this.results.shift()
    if (!next) throw new Error('scripted transport exhausted')
    return structuredClone(next)
  }
}

function successActionStay(): GeminiAttemptResult {
  return {
    kind: 'success',
    providerResult: {
      kind: 'structured', provider: 'gemini', mode: 'function_call',
      value: {
        version: 2,
        outcome: 'action',
        action: { intent: 'stay', args: {} }
      }
    },
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      thoughtTokens: 1,
      toolTokens: 1,
      totalTokens: 14
    }
  }
}

function successComplete(): GeminiAttemptResult {
  return {
    kind: 'success',
    providerResult: {
      kind: 'structured', provider: 'gemini', mode: 'function_call',
      value: { version: 2, outcome: 'complete' }
    },
    usage: {
      inputTokens: 8,
      outputTokens: 1,
      thoughtTokens: 1,
      toolTokens: 1,
      totalTokens: 11
    }
  }
}

function harness() {
  let now = 1_000
  let attempt = 0
  const events = new RuntimeEventBus()
  const observed: RuntimeEvent[] = []
  const state = new WorldStateCache({ maxRecentEvents: 64 })
  events.subscribe(event => state.apply(event))
  events.subscribe(event => { observed.push(structuredClone(event)) })

  const registry = new SkillRegistry()
  registry.register({
    name: 'stay',
    async execute() { return { status: 'succeeded', code: 'held' } }
  })

  const goals = new GoalManager({
    skillController: { async cancelActive() {} },
    events,
    nextGoalId: (() => { let value = 0; return () => `goal-${++value}` })(),
    now: () => now
  })
  const identity = new MinecraftIdentityRegistry()
  const ledger = new ScenarioLedger()
  const transport = new ScriptedTransport()
  const pool = new ProjectPool({
    config: { snapshot: routingSnapshot },
    ledger,
    processInstanceId: 'scenario-process',
    now: () => now,
    nextAttemptId: () => `attempt-${++attempt}`
  })
  const logicalExecutor = new RoutedDecisionExecutor({
    pool,
    ledger,
    transport,
    processInstanceId: 'scenario-process',
    events,
    now: () => now
  })
  const coordinator = new DecisionCoordinator({
    events,
    state,
    goals,
    memory: new EmptyMemory(),
    registry,
    identity,
    identityMode: 'online',
    manualAccess: routingSnapshot().manualAccess,
    worldKey: 'routing-e2e',
    botUsername: 'Moxue_Test',
    logicalExecutor,
    decisionGate: new DecisionGate({ safety: new SafetyPolicy(), events, now: () => now }),
    contextBuilder: new ContextBuilder(),
    safetyConstraints: ['PvP is disabled.'],
    nextTaskId: (() => { let value = 0; return () => `task-${++value}` })(),
    nextDecisionId: (() => { let value = 0; return () => `decision-${++value}` })(),
    now: () => now
  })
  coordinator.start()

  return {
    events,
    state,
    goals,
    ledger,
    transport,
    coordinator,
    observed,
    setNow(value: number) { now = value },
    now: () => now
  }
}

async function ready(current: ReturnType<typeof harness>): Promise<void> {
  await current.events.publish({ type: 'connected', at: 1 })
  await current.events.publish({
    type: 'spawned', at: 2, dimension: 'overworld',
    position: { x: 0, y: 64, z: 0 }, health: 20, food: 20
  })
  await current.events.publish({
    type: 'player_seen', at: 3,
    player: { name: 'Boss', id: OWNER, position: { x: 1, y: 64, z: 1 } }
  })
}

async function chat(
  current: ReturnType<typeof harness>,
  message: string,
  at: number,
  playerId?: string
): Promise<void> {
  await current.events.publish({
    type: 'player_chat', at, player: 'Boss',
    ...(playerId === undefined ? {} : { playerId }),
    message
  })
}

async function waitFor(predicate: () => boolean, attempts = 300): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('condition did not become true')
}

async function waitForNoTask(current: ReturnType<typeof harness>): Promise<void> {
  await waitFor(() => current.coordinator.status().activeTaskId === null)
}

test('routing coordinator E2E preserves routing, failover, reserve, terminal safety, and fresh recovery semantics', async () => {
  const current = harness()
  await ready(current)

  try {
    // Simple instruction: Lite/low starts on primary, transient failure JIT-fails over to backup.
    current.transport.enqueue(
      { kind: 'network_error' },
      successActionStay(),
      successActionStay(),
      successComplete()
    )
    await chat(current, '墨雪 原地待命', 10)
    await waitFor(() => current.transport.attempts.length === 2)
    assert.deepEqual(
      current.transport.attempts.slice(0, 2).map(item => [
        item.lease.projectLabel,
        item.lease.model,
        item.lease.thinking,
        item.lease.budgetClass
      ]),
      [
        ['primary', 'gemini-3.5-flash-lite', 'low', 'normal'],
        ['backup-1', 'gemini-3.5-flash-lite', 'low', 'normal']
      ]
    )
    await waitFor(() => current.goals.activeGoal()?.goalId === 'goal-1')

    // stuck + skill_failed are evidence only; goal_failed is the one authoritative replan boundary.
    await current.events.publish({ type: 'stuck', at: 11, code: 'path_stuck' })
    await current.events.publish({ type: 'skill_failed', at: 12, skill: 'stay', code: 'blocked' })
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(current.transport.attempts.length, 2)
    await current.goals.completeGoal('goal-1', { status: 'failed', code: 'blocked' })
    await waitFor(() => current.transport.attempts.length === 3)
    assert.equal(current.transport.attempts[2]?.lease.model, 'gemini-3.8-flash')
    assert.equal(current.transport.attempts[2]?.lease.thinking, 'medium')
    assert.equal(current.transport.attempts[2]?.lease.budgetClass, 'normal')
    await waitFor(() => current.goals.activeGoal()?.goalId === 'goal-2')

    // Second consecutive failure escalates to Flash/high but automatic work still cannot use reserve.
    await current.goals.completeGoal('goal-2', { status: 'failed', code: 'blocked_again' })
    await waitFor(() => current.transport.attempts.length === 4)
    assert.equal(current.transport.attempts[3]?.lease.model, 'gemini-3.8-flash')
    assert.equal(current.transport.attempts[3]?.lease.thinking, 'high')
    assert.equal(current.transport.attempts[3]?.lease.budgetClass, 'normal')
    const automaticHighRoute = current.observed.find(event =>
      event.type === 'model_route' &&
      event.thinking === 'high' &&
      event.reserveAuthorized === false
    )
    assert.ok(automaticHighRoute)
    assert.equal(automaticHighRoute.type === 'model_route' ? automaticHighRoute.reserveUsed : true, false)
    await waitForNoTask(current)
    current.ledger.clearTransient()

    // Obvious multi-step/open-ended instruction goes directly to Flash/medium.
    current.transport.enqueue(successComplete())
    await chat(current, '墨雪 先原地待命然後自己想辦法', 20)
    await waitFor(() => current.transport.attempts.length === 5)
    assert.equal(current.transport.attempts[4]?.lease.model, 'gemini-3.8-flash')
    assert.equal(current.transport.attempts[4]?.lease.thinking, 'medium')
    assert.equal(current.transport.attempts[4]?.lease.budgetClass, 'normal')
    await waitForNoTask(current)

    // Trusted manual deep checks every normal Project before entering reserve.
    current.ledger.forceReserveHigh = true
    const deepAdmissionStart = current.ledger.admissions.length
    current.transport.enqueue(successComplete())
    await chat(current, '!moxue deep 規劃一個安全步驟', 30, OWNER)
    await waitFor(() => current.transport.attempts.length === 6)
    const deepAttempt = current.transport.attempts[5]
    assert.equal(deepAttempt?.lease.model, 'gemini-3.8-flash')
    assert.equal(deepAttempt?.lease.thinking, 'high')
    assert.equal(deepAttempt?.lease.projectLabel, 'primary')
    assert.equal(deepAttempt?.lease.budgetClass, 'reserve')
    assert.deepEqual(
      current.ledger.admissions.slice(deepAdmissionStart).map(item => [item.projectKey, item.budgetClass]),
      [
        ['pool-a', 'normal'],
        ['pool-b', 'normal'],
        ['pool-a', 'reserve']
      ]
    )
    await waitForNoTask(current)
    current.ledger.forceReserveHigh = false

    // Provider content block is terminal and never consumes a failover lease.
    const blockedAttemptStart = current.transport.attempts.length
    current.transport.enqueue({ kind: 'content_blocked', code: 'content_blocked' })
    await chat(current, '墨雪 測試安全阻擋', 40)
    await waitForNoTask(current)
    assert.equal(current.transport.attempts.length, blockedAttemptStart + 1)
    assert.equal(current.transport.attempts.at(-1)?.lease.projectLabel, 'primary')

    // Deterministic goal finishes before unavailable continuation; recovery makes one fresh decision from latest state.
    current.transport.enqueue(successActionStay())
    await chat(current, '墨雪 原地待命等待恢復', 50)
    await waitFor(() => current.goals.activeGoal()?.goalId === 'goal-3')
    const recoveryAttemptStart = current.transport.attempts.length
    current.ledger.unavailableAll = true
    current.ledger.unavailableRetryAt = current.now() + 25
    await current.goals.completeGoal('goal-3', { status: 'succeeded', code: 'held' })
    await waitFor(() => current.coordinator.status().aiAvailability === 'unavailable')
    assert.equal(current.goals.getGoal('goal-3')?.status, 'succeeded')
    assert.equal(current.transport.attempts.length, recoveryAttemptStart)

    await current.events.publish({
      type: 'inventory_changed', at: 51, items: [{ name: 'bread', count: 3 }]
    })
    current.ledger.unavailableAll = false
    current.setNow(current.ledger.unavailableRetryAt ?? current.now())
    current.transport.enqueue(successComplete())
    await waitFor(() => current.transport.attempts.length === recoveryAttemptStart + 1)
    await waitForNoTask(current)
    assert.deepEqual(current.transport.attempts.at(-1)?.context.inventory, [
      { name: 'bread', count: 3 }
    ])

    // Every real provider attempt is settled exactly once in the fake durable boundary.
    assert.equal(current.ledger.settlements.length, current.transport.attempts.length)
  } finally {
    current.coordinator.dispose()
  }
})
