import assert from 'node:assert/strict'
import test from 'node:test'
import type { DecisionContext } from '../../../src/agent/context-builder.js'
import type { AttemptLease, RoutePlan } from '../../../src/agent/routing/contracts.js'
import { RoutedDecisionExecutor } from '../../../src/agent/routing/routed-executor.js'
import type { GeminiAttemptResult, PreparedGeminiPayload } from '../../../src/agent/providers/gemini.js'

const NOW = Date.parse('2026-09-12T12:00:00Z')

function plan(): RoutePlan {
  return Object.freeze({
    decisionId: 'decision-1',
    policy: 'balanced-v1',
    routeClass: 'complex',
    thinking: 'medium',
    reserveAuthorized: false,
    reasons: Object.freeze(['multi_step']),
    highReason: null
  })
}

function lease(id: string, projectKey: string, projectLabel: string): AttemptLease {
  return Object.freeze({
    attemptId: id,
    decisionId: 'decision-1',
    configGeneration: 7,
    projectKey,
    projectLabel,
    credentialHandle: `credential-${projectKey}`,
    model: 'gemini-3.8-flash',
    thinking: 'medium',
    budgetClass: 'normal',
    reservationId: id
  })
}

function success(): GeminiAttemptResult {
  return {
    kind: 'success',
    providerResult: {
      kind: 'structured',
      provider: 'gemini',
      mode: 'function_call',
      value: { version: 2, outcome: 'complete' }
    },
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      thoughtTokens: 3,
      toolTokens: 1,
      totalTokens: 16
    }
  }
}

class FakePool {
  readonly requests: Array<{ decisionId: string; utf8Bytes: number }> = []
  constructor(
    private readonly results: Array<
      | { kind: 'leased'; lease: AttemptLease }
      | { kind: 'unavailable'; retryAt: number | null }
    >,
    private readonly projectCount = 2
  ) {}

  configuredProjectCount(): number {
    return this.projectCount
  }

  nextLease(routePlan: RoutePlan, prepared: { utf8Bytes: number }) {
    this.requests.push({ decisionId: routePlan.decisionId, utf8Bytes: prepared.utf8Bytes })
    return this.results.shift() ?? { kind: 'unavailable' as const, retryAt: null }
  }
}

class FakeLedger {
  readonly calls: string[] = []
  markDispatched(id: string, _at: number): void { this.calls.push(`dispatch:${id}`) }
  settleAttempt(id: string, settlement: { resultClass: string }): void {
    this.calls.push(`settle:${id}:${settlement.resultClass}`)
  }
  recordTransientFailure(projectKey: string, model: string, _now: number, retryAfterMs?: number): number {
    this.calls.push(`transient:${projectKey}:${model}:${retryAfterMs ?? 0}`)
    return retryAfterMs ?? 5_000
  }
  recordDomainSuccess(projectKey: string, model: string): void {
    this.calls.push(`success:${projectKey}:${model}`)
  }
  markQuotaUnavailable(projectKey: string, model: string, until: number, code: string): void {
    this.calls.push(`quota:${projectKey}:${model}:${until}:${code}`)
  }
  disableCredentialForProcess(projectKey: string, processId: string, code: string, _now: number): void {
    this.calls.push(`disable:${projectKey}:${processId}:${code}`)
  }
}

class FakeTransport {
  readonly executed: string[] = []
  constructor(private readonly results: GeminiAttemptResult[]) {}
  prepare(_context: DecisionContext): PreparedGeminiPayload {
    return Object.freeze({
      input: '{}',
      systemInstruction: 'safe',
      tools: Object.freeze([]),
      utf8Bytes: 2
    })
  }
  async execute(_prepared: PreparedGeminiPayload, selected: AttemptLease, _signal: AbortSignal) {
    this.executed.push(selected.attemptId)
    const result = this.results.shift()
    if (!result) throw new Error('missing fake attempt result')
    return result
  }
}

function harness(
  poolResults: ConstructorParameters<typeof FakePool>[0],
  transportResults: GeminiAttemptResult[],
  projectCount = 2
) {
  const pool = new FakePool(poolResults, projectCount)
  const ledger = new FakeLedger()
  const transport = new FakeTransport(transportResults)
  const executor = new RoutedDecisionExecutor({
    pool,
    ledger,
    transport,
    processInstanceId: 'process-1',
    now: () => NOW
  })
  return { pool, ledger, transport, executor }
}

const request = { context: {} as DecisionContext, routePlan: plan() }

test('transient primary failure settles and fails over to the next JIT lease', async () => {
  const a = lease('attempt-a', 'pool-a', 'primary')
  const b = lease('attempt-b', 'pool-b', 'backup-1')
  const current = harness(
    [{ kind: 'leased', lease: a }, { kind: 'leased', lease: b }],
    [{ kind: 'api_error', httpStatus: 503, providerCode: null }, success()]
  )

  const result = await current.executor.execute(request, new AbortController().signal)

  assert.equal(result.kind, 'success')
  assert.deepEqual(current.transport.executed, ['attempt-a', 'attempt-b'])
  assert.deepEqual(current.ledger.calls.slice(0, 4), [
    'dispatch:attempt-a',
    'settle:attempt-a:transient',
    'transient:pool-a:gemini-3.8-flash:0',
    'dispatch:attempt-b'
  ])
  assert.equal(current.ledger.calls.includes('success:pool-b:gemini-3.8-flash'), true)
})

test('credential-fatal primary failure disables only that project then fails over', async () => {
  const current = harness(
    [
      { kind: 'leased', lease: lease('attempt-a', 'pool-a', 'primary') },
      { kind: 'leased', lease: lease('attempt-b', 'pool-b', 'backup-1') }
    ],
    [
      { kind: 'api_error', httpStatus: 401, providerCode: 'authentication' },
      success()
    ]
  )

  const result = await current.executor.execute(request, new AbortController().signal)
  assert.equal(result.kind, 'success')
  assert.equal(current.ledger.calls.includes('disable:pool-a:process-1:authentication'), true)
  assert.deepEqual(current.transport.executed, ['attempt-a', 'attempt-b'])
})

test('provider content block is terminal and never consumes a failover lease', async () => {
  const current = harness(
    [
      { kind: 'leased', lease: lease('attempt-a', 'pool-a', 'primary') },
      { kind: 'leased', lease: lease('attempt-b', 'pool-b', 'backup-1') }
    ],
    [{ kind: 'content_blocked', code: 'content_blocked' }]
  )

  assert.deepEqual(
    await current.executor.execute(request, new AbortController().signal),
    { kind: 'safety_blocked', code: 'content_blocked' }
  )
  assert.deepEqual(current.transport.executed, ['attempt-a'])
})

test('generation repair is allowed once and a second invalid generation terminates', async () => {
  const current = harness(
    [
      { kind: 'leased', lease: lease('attempt-a', 'pool-a', 'primary') },
      { kind: 'leased', lease: lease('attempt-b', 'pool-a', 'primary') },
      { kind: 'leased', lease: lease('attempt-c', 'pool-a', 'primary') }
    ],
    [
      { kind: 'generation_error', code: 'malformed_tool_call' },
      { kind: 'generation_error', code: 'malformed_tool_call' }
    ]
  )

  assert.deepEqual(
    await current.executor.execute(request, new AbortController().signal),
    { kind: 'invalid_response', code: 'malformed_tool_call' }
  )
  assert.deepEqual(current.transport.executed, ['attempt-a', 'attempt-b'])
})

test('pool unavailability returns retryAt without issuing a provider request', async () => {
  const current = harness(
    [{ kind: 'unavailable', retryAt: NOW + 15_000 }],
    []
  )
  assert.deepEqual(
    await current.executor.execute(request, new AbortController().signal),
    { kind: 'unavailable', retryAt: NOW + 15_000 }
  )
  assert.deepEqual(current.transport.executed, [])
})

test('local cancellation settles the dispatched attempt but does not damage provider health', async () => {
  const current = harness(
    [{ kind: 'leased', lease: lease('attempt-a', 'pool-a', 'primary') }],
    [{ kind: 'cancelled' }]
  )

  assert.deepEqual(
    await current.executor.execute(request, new AbortController().signal),
    { kind: 'cancelled' }
  )
  assert.deepEqual(current.ledger.calls, [
    'dispatch:attempt-a',
    'settle:attempt-a:cancelled'
  ])
})

test('actual provider attempts are bounded by configured project count plus four', async () => {
  const leases = Array.from({ length: 8 }, (_, index) => ({
    kind: 'leased' as const,
    lease: lease(`attempt-${index + 1}`, 'pool-a', 'primary')
  }))
  const failures = Array.from({ length: 8 }, () => ({
    kind: 'network_error' as const
  }))
  const current = harness(leases, failures, 1)

  assert.deepEqual(
    await current.executor.execute(request, new AbortController().signal),
    { kind: 'unavailable', retryAt: null }
  )
  assert.equal(current.transport.executed.length, 5)
})
