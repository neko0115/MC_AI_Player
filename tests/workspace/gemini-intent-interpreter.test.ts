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
  GeminiInteractionResponse,
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

function containsAnyKey(
  value: unknown,
  forbidden: ReadonlySet<string>
): boolean {
  if (Array.isArray(value)) {
    return value.some(item =>
      containsAnyKey(item, forbidden)
    )
  }
  if (
    typeof value !== 'object' ||
    value === null
  ) {
    return false
  }
  const record =
    value as Record<string, unknown>
  return Object.entries(record).some(
    ([key, item]) =>
      forbidden.has(key) ||
      containsAnyKey(item, forbidden)
  )
}

async function executeResponse(
  response: GeminiInteractionResponse
): Promise<GeminiAttemptResult> {
  const transport =
    new GeminiWorkspaceIntentTransport({
      resolveCredential:
        () => 'test-key',
      createClient: () => ({
        async create() {
          return response
        }
      })
    })

  return transport.execute(
    transport.prepare(context()),
    lease(),
    new AbortController().signal
  )
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

test('Gemini workspace transport advertises only object-root intent tools with no unsupported combinators or const', () => {
  const prepared =
    new GeminiWorkspaceIntentTransport()
      .prepare(context())
  const names = prepared.tools
    .map(tool => tool.name)
    .sort()

  assert.deepEqual(names, [
    'workspace_archive',
    'workspace_change_constraints',
    'workspace_change_purpose',
    'workspace_change_use_policy',
    'workspace_clarify',
    'workspace_create',
    'workspace_list',
    'workspace_not_workspace',
    'workspace_rename',
    'workspace_replace_tags',
    'workspace_resize',
    'workspace_restore',
    'workspace_show'
  ])

  const forbidden = new Set([
    'oneOf',
    'anyOf',
    'allOf',
    'const'
  ])
  for (const tool of prepared.tools) {
    assert.equal(
      tool.parameters.type,
      'object',
      tool.name
    )
    assert.equal(
      tool.parameters.additionalProperties,
      false,
      tool.name
    )
    assert.equal(
      containsAnyKey(
        tool.parameters,
        forbidden
      ),
      false,
      tool.name
    )
  }

  const show = prepared.tools.find(
    tool => tool.name === 'workspace_show'
  )
  assert.ok(show)
  const properties =
    show.parameters.properties as
      Record<string, unknown>
  assert.deepEqual(
    properties.target,
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: {
          type: 'string',
          enum: [
            'explicit',
            'current_selection',
            'conversation',
            'nearby',
            'recent'
          ]
        },
        value: {
          type: 'string',
          minLength: 1,
          maxLength: 128
        }
      },
      required: ['kind']
    }
  )
})

test('Gemini workspace transport sends compatible tools and reconstructs exact create intent', async () => {
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
            steps: [
              { type: 'thought' },
              {
                type:
                  'function_call',
                name:
                  'workspace_create',
                arguments: {
                label: '農田',
                purpose: 'farm',
                moxueUsePolicy:
                  'shared'
                }
              }
            ]
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
    13
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
  assert.deepEqual(
    result.kind === 'success'
      ? result.providerResult
      : result,
    {
      kind: 'structured',
      provider: 'gemini',
      mode: 'function_call',
      value: {
        kind: 'create',
        label: '農田',
        purpose: 'farm',
        moxueUsePolicy:
          'shared'
      }
    }
  )
})

test('Gemini workspace transport reconstructs terminal and reference intents from tool names', async () => {
  const cases = [
    {
      name: 'workspace_not_workspace',
      arguments: {},
      intent: {
        kind: 'not_workspace'
      }
    },
    {
      name: 'workspace_clarify',
      arguments: {
        reason: 'missing_selection'
      },
      intent: {
        kind: 'clarify',
        reason: 'missing_selection'
      }
    },
    {
      name: 'workspace_show',
      arguments: {
        target: {
          kind: 'explicit',
          value: 'W5C-LiveFarm-A'
        }
      },
      intent: {
        kind: 'show',
        target: {
          kind: 'explicit',
          value: 'W5C-LiveFarm-A'
        }
      }
    },
    {
      name:
        'workspace_change_use_policy',
      arguments: {
        target: {
          kind: 'recent'
        },
        moxueUsePolicy:
          'owner_only'
      },
      intent: {
        kind:
          'change_use_policy',
        target: {
          kind: 'recent'
        },
        moxueUsePolicy:
          'owner_only'
      }
    },
    {
      name:
        'workspace_change_use_policy',
      arguments: {
        target: {
          kind: 'conversation'
        },
        moxueUsePolicy:
          'moxue_preferred'
      },
      intent: {
        kind:
          'change_use_policy',
        target: {
          kind: 'conversation'
        },
        moxueUsePolicy:
          'moxue_preferred'
      }
    }
  ] as const

  for (const current of cases) {
    const result = await executeResponse({
      status: 'requires_action',
      steps: [{
        type: 'function_call',
        name: current.name,
        arguments:
          current.arguments
      }]
    })

    if (
      result.kind !== 'success' ||
      result.providerResult.kind !==
        'structured'
    ) {
      assert.fail(
        `${current.name} did not return a structured success`
      )
    }
    assert.deepEqual(
      result.providerResult.value,
      current.intent,
      current.name
    )
  }
})

test('Gemini workspace transport rejects missing explicit value, unknown functions, and multiple calls', async () => {
  const cases = [
    {
      response: {
        status: 'requires_action',
        steps: [{
          type: 'function_call',
          name: 'workspace_show',
          arguments: {
            target: {
              kind: 'explicit'
            }
          }
        }]
      },
      code:
        'workspace_intent_schema_invalid'
    },
    {
      response: {
        status: 'requires_action',
        steps: [{
          type: 'function_call',
          name: 'workspace_unknown',
          arguments: {}
        }]
      },
      code:
        'unexpected_function_call'
    },
    {
      response: {
        status: 'requires_action',
        steps: [
          {
            type: 'function_call',
            name:
              'workspace_not_workspace',
            arguments: {}
          },
          {
            type: 'function_call',
            name: 'workspace_list',
            arguments: {}
          }
        ]
      },
      code:
        'function_call_count_invalid'
    }
  ] satisfies ReadonlyArray<{
    response: GeminiInteractionResponse
    code: string
  }>

  for (const current of cases) {
    assert.deepEqual(
      await executeResponse(
        current.response
      ),
      {
        kind: 'generation_error',
        code: current.code
      }
    )
  }
})
