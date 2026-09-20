import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  AttemptLease,
  RoutePlan
} from '../../src/agent/routing/contracts.js'
import type {
  ProjectPoolLeaseResult
} from '../../src/agent/routing/project-pool.js'
import type {
  AttemptSettlement
} from '../../src/agent/routing/quota-ledger.js'
import type {
  GeminiAttemptResult,
  GeminiInteractionRequest
} from '../../src/agent/providers/gemini.js'
import {
  GeminiWorkspaceIntentTransport,
  RoutedGeminiWorkspaceIntentInterpreter,
  WorkspaceSemanticProviderError,
  type WorkspaceIntentPoolPort,
  type WorkspaceIntentTransportPort
} from '../../src/workspace/gemini-intent-interpreter.js'
import type {
  WorkspaceSemanticContext
} from '../../src/workspace/chat-intent.js'

function context(): WorkspaceSemanticContext {
  return {
    utterance:
      '這塊以後我自己慢慢種，你知道就好不要拿',
    actorPrincipal:
      'player-1',
    dimension:
      'overworld',
    selection: {
      available: true,
      id: 'selection-1',
      dimension:
        'overworld'
    },
    conversationWorkspaceId:
      null,
    recentWorkspaceId:
      null,
    workspaces: []
  }
}

function lease(
  overrides:
    Partial<AttemptLease> = {}
): AttemptLease {
  return {
    attemptId: 'attempt-1',
    decisionId: 'decision-1',
    configGeneration: 1,
    projectKey: 'project-1',
    projectLabel: 'primary',
    credentialHandle:
      'credential-1',
    model: 'gemini-test',
    thinking: 'low',
    budgetClass: 'normal',
    reservationId:
      'reservation-1',
    ...overrides
  }
}

class FakePool
implements WorkspaceIntentPoolPort {
  readonly plans: RoutePlan[] = []
  readonly prepared:
    Array<{ utf8Bytes: number }> = []
  queue:
    ProjectPoolLeaseResult[] = [
      {
        kind: 'leased',
        lease: lease()
      }
    ]

  configuredProjectCount(): number {
    return 2
  }

  nextLease(
    plan: RoutePlan,
    prepared: {
      readonly utf8Bytes: number
    }
  ): ProjectPoolLeaseResult {
    this.plans.push(
      structuredClone(plan)
    )
    this.prepared.push(
      structuredClone(prepared)
    )
    const next =
      this.queue.shift()
    if (!next) {
      return {
        kind: 'unavailable',
        retryAt: null
      }
    }
    return next
  }
}

class FakeLedger {
  readonly dispatched: string[] = []
  readonly settlements:
    AttemptSettlement[] = []
  readonly successes:
    Array<{
      project: string
      model: string
    }> = []
  readonly disabled:
    string[] = []
  readonly transient:
    string[] = []
  readonly quota:
    string[] = []

  markDispatched(
    reservationId: string
  ): void {
    this.dispatched.push(
      reservationId
    )
  }

  settleAttempt(
    _reservationId: string,
    settlement: AttemptSettlement
  ): void {
    this.settlements.push(
      structuredClone(settlement)
    )
  }

  recordTransientFailure(
    projectKey: string
  ): number {
    this.transient.push(
      projectKey
    )
    return 0
  }

  recordDomainSuccess(
    projectKey: string,
    model: string
  ): void {
    this.successes.push({
      project: projectKey,
      model
    })
  }

  markQuotaUnavailable(
    projectKey: string
  ): void {
    this.quota.push(
      projectKey
    )
  }

  disableCredentialForProcess(
    projectKey: string
  ): void {
    this.disabled.push(
      projectKey
    )
  }
}

class FakeTransport
implements WorkspaceIntentTransportPort {
  readonly contexts:
    WorkspaceSemanticContext[] = []
  readonly leases:
    AttemptLease[] = []
  queue:
    GeminiAttemptResult[] = []

  prepare(
    semanticContext:
      WorkspaceSemanticContext
  ) {
    this.contexts.push(
      structuredClone(
        semanticContext
      )
    )
    return {
      input:
        JSON.stringify(
          semanticContext
        ),
      systemInstruction:
        'test',
      tools: [],
      utf8Bytes: 123
    }
  }

  async execute(
    _prepared:
      ReturnType<FakeTransport['prepare']>,
    currentLease: AttemptLease
  ): Promise<GeminiAttemptResult> {
    this.leases.push(
      structuredClone(
        currentLease
      )
    )
    const next =
      this.queue.shift()
    if (!next) {
      throw new Error(
        'missing fake attempt'
      )
    }
    return next
  }
}

function success(
  value: unknown
): GeminiAttemptResult {
  return {
    kind: 'success',
    providerResult: {
      kind: 'structured',
      provider: 'gemini',
      mode: 'function_call',
      value
    }
  }
}

test('routed workspace interpreter uses routine low ProjectPool route and returns validated semantic intent', async () => {
  const pool =
    new FakePool()
  const ledger =
    new FakeLedger()
  const transport =
    new FakeTransport()
  transport.queue.push(
    success({
      kind: 'create',
      label: '我的田',
      purpose: 'farm',
      moxueUsePolicy:
        'owner_only'
    })
  )

  const interpreter =
    new RoutedGeminiWorkspaceIntentInterpreter({
      pool,
      ledger,
      transport,
      processInstanceId:
        'process-1',
      nextDecisionId:
        () => 'semantic-1',
      now: () => 100
    })

  const result =
    await interpreter.interpret(
      context(),
      new AbortController().signal
    )

  assert.equal(
    pool.plans[0]?.routeClass,
    'routine'
  )
  assert.equal(
    pool.plans[0]?.thinking,
    'low'
  )
  assert.deepEqual(
    pool.plans[0]?.reasons,
    [
      'workspace_semantic_interpretation'
    ]
  )
  assert.equal(
    pool.prepared[0]
      ?.utf8Bytes,
    123
  )
  assert.deepEqual(
    result,
    {
      kind: 'create',
      label: '我的田',
      purpose: 'farm',
      moxueUsePolicy:
        'owner_only'
    }
  )
  assert.deepEqual(
    ledger.successes,
    [{
      project: 'project-1',
      model: 'gemini-test'
    }]
  )
})

test('one malformed semantic generation is retried then a valid result succeeds', async () => {
  const pool =
    new FakePool()
  pool.queue.push({
    kind: 'leased',
    lease: lease({
      attemptId: 'attempt-2',
      reservationId:
        'reservation-2'
    })
  })
  const ledger =
    new FakeLedger()
  const transport =
    new FakeTransport()
  transport.queue.push(
    {
      kind: 'generation_error',
      code:
        'workspace_intent_schema_invalid'
    },
    success({
      kind: 'not_workspace'
    })
  )

  const interpreter =
    new RoutedGeminiWorkspaceIntentInterpreter({
      pool,
      ledger,
      transport,
      processInstanceId:
        'process-1',
      nextDecisionId:
        () => 'semantic-1',
      now: () => 100
    })

  assert.deepEqual(
    await interpreter.interpret(
      context(),
      new AbortController().signal
    ),
    {
      kind: 'not_workspace'
    }
  )
  assert.equal(
    ledger.settlements.length,
    2
  )
})

test('credential-fatal attempt disables that project and falls through to another lease', async () => {
  const pool =
    new FakePool()
  pool.queue.push({
    kind: 'leased',
    lease: lease({
      attemptId: 'attempt-2',
      reservationId:
        'reservation-2',
      projectKey:
        'project-2',
      projectLabel:
        'backup-1',
      credentialHandle:
        'credential-2'
    })
  })
  const ledger =
    new FakeLedger()
  const transport =
    new FakeTransport()
  transport.queue.push(
    {
      kind: 'api_error',
      httpStatus: 401,
      providerCode:
        'authentication'
    },
    success({
      kind: 'show',
      target: {
        kind: 'recent'
      }
    })
  )

  const interpreter =
    new RoutedGeminiWorkspaceIntentInterpreter({
      pool,
      ledger,
      transport,
      processInstanceId:
        'process-1',
      nextDecisionId:
        () => 'semantic-1',
      now: () => 100
    })

  const result =
    await interpreter.interpret(
      context(),
      new AbortController().signal
    )

  assert.equal(
    result.kind,
    'show'
  )
  assert.deepEqual(
    ledger.disabled,
    ['project-1']
  )
  assert.equal(
    transport.leases[1]
      ?.projectKey,
    'project-2'
  )
})

test('pool exhaustion becomes a bounded semantic provider error', async () => {
  const pool =
    new FakePool()
  pool.queue = [{
    kind: 'unavailable',
    retryAt: 500
  }]
  const ledger =
    new FakeLedger()
  const transport =
    new FakeTransport()

  const interpreter =
    new RoutedGeminiWorkspaceIntentInterpreter({
      pool,
      ledger,
      transport,
      processInstanceId:
        'process-1',
      nextDecisionId:
        () => 'semantic-1'
    })

  await assert.rejects(
    () =>
      interpreter.interpret(
        context(),
        new AbortController().signal
      ),
    error =>
      error instanceof
        WorkspaceSemanticProviderError &&
      error.code ===
        'workspace_semantic_unavailable'
  )
})

test('Gemini workspace transport sends one semantic function tool and validates its arguments', async () => {
  const requests:
    GeminiInteractionRequest[] = []

  const transport =
    new GeminiWorkspaceIntentTransport({
      resolveCredential:
        handle =>
          handle === 'credential-1'
            ? 'test-key'
            : '',
      createClient: () => ({
        async create(request) {
          requests.push(
            structuredClone(
              request
            )
          )
          return {
            status:
              'requires_action',
            steps: [{
              type:
                'function_call',
              name:
                'submit_workspace_intent',
              arguments: {
                kind: 'create',
                label: '農田',
                purpose: 'farm',
                moxueUsePolicy:
                  'shared'
              }
            }]
          }
        }
      })
    })

  const prepared =
    transport.prepare(
      context()
    )
  const result =
    await transport.execute(
      prepared,
      lease(),
      new AbortController().signal
    )

  assert.equal(
    result.kind,
    'success'
  )
  assert.equal(
    requests.length,
    1
  )
  assert.equal(
    requests[0]?.tools.length,
    1
  )
  assert.equal(
    requests[0]
      ?.generation_config
      .thinking_level,
    'low'
  )

  const input =
    JSON.parse(
      requests[0]?.input ?? '{}'
    ) as {
      context?: {
        utterance?: string
      }
    }
  assert.equal(
    input.context?.utterance,
    context().utterance
  )
})

test('Gemini workspace transport rejects malformed function arguments as generation error', async () => {
  const transport =
    new GeminiWorkspaceIntentTransport({
      resolveCredential:
        () => 'test-key',
      createClient: () => ({
        async create() {
          return {
            status:
              'requires_action',
            steps: [{
              type:
                'function_call',
              name:
                'submit_workspace_intent',
              arguments: {
                kind: 'create',
                label: '農田',
                purpose: 'farm',
                moxueUsePolicy:
                  'invented_policy'
              }
            }]
          }
        }
      })
    })

  const result =
    await transport.execute(
      transport.prepare(
        context()
      ),
      lease(),
      new AbortController().signal
    )

  assert.deepEqual(
    result,
    {
      kind: 'generation_error',
      code:
        'workspace_intent_schema_invalid'
    }
  )
})
