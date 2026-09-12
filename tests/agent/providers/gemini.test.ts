import assert from 'node:assert/strict'
import test from 'node:test'
import type { DecisionContext } from '../../../src/agent/context-builder.js'
import {
  GeminiDecisionProvider,
  type GeminiInteractionClient,
  type GeminiInteractionRequest,
  type GeminiInteractionResponse
} from '../../../src/agent/providers/gemini.js'

class FakeInteractions implements GeminiInteractionClient {
  readonly requests: Array<{
    request: GeminiInteractionRequest
    options: { timeout: number }
  }> = []

  constructor(
    private readonly response: GeminiInteractionResponse | Error
  ) {}

  async create(
    request: GeminiInteractionRequest,
    options: { timeout: number }
  ): Promise<GeminiInteractionResponse> {
    this.requests.push({ request: structuredClone(request), options: { ...options } })
    if (this.response instanceof Error) throw this.response
    return structuredClone(this.response)
  }
}

function context(): DecisionContext {
  return {
    worldKey: 'test-server:survival-v1',
    currentGoal: null,
    self: {
      connected: true,
      spawned: true,
      health: 20,
      food: 18,
      dimension: 'overworld',
      position: { x: 0, y: 64, z: 0 }
    },
    nearbyPlayers: [{ name: 'Boss', position: { x: 2, y: 64, z: 0 } }],
    inventory: [{ name: 'bread', count: 2 }],
    recentEvents: [],
    memories: [],
    skills: [
      { name: 'gather_resource', description: 'Gather an exact bounded quantity.' },
      { name: 'stay', description: 'Hold position.' }
    ],
    safetyConstraints: ['PvP is disabled.', 'Generic pathfinding cannot dig.']
  }
}

function provider(
  response: GeminiInteractionResponse | Error,
  overrides: Partial<{
    model: string
    timeoutMs: number
    thinkingLevel: 'low' | 'medium' | 'high'
  }> = {}
) {
  const interactions = new FakeInteractions(response)
  return {
    interactions,
    provider: new GeminiDecisionProvider({
      interactions,
      model: overrides.model ?? 'gemini-3.8-flash',
      timeoutMs: overrides.timeoutMs ?? 30_000,
      thinkingLevel: overrides.thinkingLevel ?? 'high'
    })
  }
}

test('Gemini provider requests one forced decision function with high thinking and no thought summaries', async () => {
  const current = provider({
    status: 'requires_action',
    steps: [
      {
        type: 'thought',
        summary: [{ type: 'text', text: 'PRIVATE_REASONING_SENTINEL' }]
      },
      {
        type: 'function_call',
        id: 'fc-1',
        name: 'submit_decision',
        arguments: {
          version: 1,
          intent: 'gather_resource',
          args: { resource: 'oak_log', quantity: 16 }
        }
      }
    ]
  })

  const result = await current.provider.decide({ context: context() })

  assert.deepEqual(result, {
    kind: 'structured',
    provider: 'gemini',
    mode: 'function_call',
    value: {
      version: 1,
      intent: 'gather_resource',
      args: { resource: 'oak_log', quantity: 16 }
    }
  })
  assert.equal(JSON.stringify(result).includes('PRIVATE_REASONING_SENTINEL'), false)

  assert.equal(current.interactions.requests.length, 1)
  const sent = current.interactions.requests[0]
  assert.ok(sent)
  assert.equal(sent.request.model, 'gemini-3.8-flash')
  assert.equal(sent.request.store, false)
  assert.equal(sent.request.tools.length, 1)
  assert.equal(sent.request.tools[0]?.type, 'function')
  assert.equal(sent.request.tools[0]?.name, 'submit_decision')
  assert.equal(sent.request.generation_config.thinking_level, 'high')
  assert.equal(sent.request.generation_config.thinking_summaries, 'none')
  assert.equal(sent.request.generation_config.tool_choice, 'any')
  assert.equal(sent.options.timeout, 30_000)
  assert.equal(typeof sent.request.input, 'string')
  assert.equal(sent.request.input.includes('test-server:survival-v1'), true)
})

test('only requires_action interaction status may yield a gameplay function call', async () => {
  const validCall = {
    type: 'function_call',
    id: 'fc-status',
    name: 'submit_decision',
    arguments: { version: 1, intent: 'stay', args: {} }
  }

  for (const status of [
    'completed',
    'failed',
    'cancelled',
    'incomplete',
    'in_progress'
  ] as const) {
    const current = provider({ status, steps: [validCall] })

    assert.deepEqual(
      await current.provider.decide({ context: context() }),
      {
        kind: 'invalid',
        provider: 'gemini',
        code: 'interaction_status_invalid'
      },
      status
    )
  }
})

test('thought steps are ignored, but any model text step makes the provider fail closed', async () => {
  const current = provider({
    status: 'requires_action',
    steps: [
      { type: 'thought', summary: [{ type: 'text', text: 'private thought' }] },
      {
        type: 'model_output',
        content: [{
          type: 'text',
          text: '{"version":1,"intent":"stay","args":{}}'
        }]
      },
      {
        type: 'function_call',
        id: 'fc-1',
        name: 'submit_decision',
        arguments: { version: 1, intent: 'stay', args: {} }
      }
    ]
  })

  assert.deepEqual(await current.provider.decide({ context: context() }), {
    kind: 'invalid',
    provider: 'gemini',
    code: 'unexpected_provider_step'
  })
})

test('provider requires exactly one submit_decision function call', async () => {
  for (const [steps, code] of [
    [
      [{ type: 'thought' }],
      'function_call_missing'
    ],
    [
      [
        { type: 'function_call', id: '1', name: 'submit_decision', arguments: { version: 1, intent: 'stay', args: {} } },
        { type: 'function_call', id: '2', name: 'submit_decision', arguments: { version: 1, intent: 'stay', args: {} } }
      ],
      'function_call_count_invalid'
    ],
    [
      [{ type: 'function_call', id: '1', name: 'other_tool', arguments: { version: 1, intent: 'stay', args: {} } }],
      'unexpected_function_call'
    ]
  ] as const) {
    const current = provider({ status: 'requires_action', steps })
    assert.deepEqual(await current.provider.decide({ context: context() }), {
      kind: 'invalid',
      provider: 'gemini',
      code
    })
  }
})

test('missing function arguments fail closed instead of inventing an empty object', async () => {
  const current = provider({
    status: 'requires_action',
    steps: [{ type: 'function_call', id: '1', name: 'submit_decision' }]
  })

  assert.deepEqual(await current.provider.decide({ context: context() }), {
    kind: 'invalid',
    provider: 'gemini',
    code: 'function_arguments_missing'
  })
})

test('provider returns a detached arguments object rather than an SDK-owned reference', async () => {
  const argumentsObject = {
    version: 1,
    intent: 'gather_resource',
    args: { resource: 'oak_log', quantity: 2 }
  }
  const response: GeminiInteractionResponse = {
    status: 'requires_action',
    steps: [{
      type: 'function_call',
      id: '1',
      name: 'submit_decision',
      arguments: argumentsObject
    }]
  }
  const current = provider(response)

  const result = await current.provider.decide({ context: context() })
  argumentsObject.args.quantity = 999

  assert.equal(result.kind, 'structured')
  if (result.kind !== 'structured') return
  assert.deepEqual(result.value, {
    version: 1,
    intent: 'gather_resource',
    args: { resource: 'oak_log', quantity: 2 }
  })
})

test('SDK TimeoutError maps only to ProviderResult timeout; other failures stay generic', async () => {
  const timeout = new Error('request timeout with private transport details')
  timeout.name = 'TimeoutError'
  const timeoutProvider = provider(timeout).provider
  assert.deepEqual(await timeoutProvider.decide({ context: context() }), {
    kind: 'timeout',
    provider: 'gemini'
  })

  const failure = new Error('SECRET_NETWORK_DETAIL')
  const failedProvider = provider(failure).provider
  const result = await failedProvider.decide({ context: context() })
  assert.deepEqual(result, {
    kind: 'invalid',
    provider: 'gemini',
    code: 'provider_request_failed'
  })
  assert.equal(JSON.stringify(result).includes('SECRET_NETWORK_DETAIL'), false)
})

test('Gemini module exports the routed one-attempt transport', async () => {
  const module = await import('../../../src/agent/providers/gemini.js')
  assert.equal(typeof (module as Record<string, unknown>).GeminiTransport, 'function')
})

test('Gemini transport prepares one immutable V2 forced-function payload', async () => {
  const module = await import('../../../src/agent/providers/gemini.js')
  const Transport = (module as Record<string, unknown>).GeminiTransport as new () => {
    prepare(context: DecisionContext): {
      input: string
      systemInstruction: string
      tools: ReadonlyArray<{ name: string; parameters: Record<string, unknown> }>
      utf8Bytes: number
    }
  }
  const transport = new Transport()
  const prepared = transport.prepare(context())

  assert.equal(Object.isFrozen(prepared), true)
  assert.equal(prepared.tools.length, 1)
  assert.equal(prepared.tools[0]?.name, 'submit_decision')
  assert.equal(prepared.utf8Bytes, Buffer.byteLength(prepared.input, 'utf8'))
  assert.equal(prepared.input.includes('test-server:survival-v1'), true)

  const schema = JSON.stringify(prepared.tools[0]?.parameters)
  assert.equal(schema.includes('"version":{"const":2'), true)
  assert.equal(schema.includes('"outcome":{"const":"action"'), true)
  assert.equal(schema.includes('"outcome":{"const":"complete"'), true)
  assert.equal(schema.includes('"outcome":{"const":"blocked"'), true)
  assert.equal(schema.includes('"reasoning"'), false)
  assert.equal(schema.includes('"analysis"'), false)
  assert.equal(schema.includes('"thought"'), false)
})

test('Gemini transport executes one lease-selected attempt and normalizes usage without thought leakage', async () => {
  const module = await import('../../../src/agent/providers/gemini.js')
  const calls: Array<{ request: any; options: any }> = []
  const resolvedHandles: string[] = []
  const factoryKeys: string[] = []
  const Transport = (module as Record<string, unknown>).GeminiTransport as new (options: any) => {
    prepare(context: DecisionContext): any
    execute(prepared: any, lease: any, signal: AbortSignal): Promise<any>
  }
  const transport = new Transport({
    timeoutMs: 1234,
    resolveCredential(handle: string) {
      resolvedHandles.push(handle)
      return 'TEST_KEY_ONLY_INSIDE_TRANSPORT'
    },
    createClient(apiKey: string) {
      factoryKeys.push(apiKey)
      return {
        async create(request: any, options: any) {
          calls.push({ request: structuredClone(request), options })
          return {
            status: 'requires_action',
            steps: [
              { type: 'thought', summary: [{ type: 'text', text: 'PRIVATE_THOUGHT_SENTINEL' }] },
              {
                type: 'function_call',
                id: 'fc-v2',
                name: 'submit_decision',
                arguments: { version: 2, outcome: 'complete' }
              }
            ],
            usage: {
              total_input_tokens: 10,
              total_output_tokens: 2,
              total_thought_tokens: 3,
              total_tool_use_tokens: 1,
              total_tokens: 16
            }
          }
        }
      }
    }
  })
  const controller = new AbortController()
  const prepared = transport.prepare(context())
  const lease = {
    attemptId: 'attempt-1',
    decisionId: 'decision-1',
    configGeneration: 7,
    projectKey: 'pool-b',
    projectLabel: 'backup-1',
    credentialHandle: 'credential-7-b',
    model: 'gemini-3.8-flash',
    thinking: 'medium',
    budgetClass: 'normal',
    reservationId: 'attempt-1'
  }

  const result = await transport.execute(prepared, lease, controller.signal)

  assert.deepEqual(resolvedHandles, ['credential-7-b'])
  assert.deepEqual(factoryKeys, ['TEST_KEY_ONLY_INSIDE_TRANSPORT'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.request.model, 'gemini-3.8-flash')
  assert.equal(calls[0]?.request.generation_config.thinking_level, 'medium')
  assert.equal(calls[0]?.request.store, false)
  assert.equal(calls[0]?.request.stream, false)
  assert.equal(calls[0]?.options.timeout, 1234)
  assert.equal(calls[0]?.options.retryAttempts, 1)
  assert.equal(calls[0]?.options.signal, controller.signal)
  assert.deepEqual(result, {
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
  })
  assert.equal(JSON.stringify(result).includes('PRIVATE_THOUGHT_SENTINEL'), false)
  assert.equal(JSON.stringify(result).includes('TEST_KEY_ONLY_INSIDE_TRANSPORT'), false)
})

test('Gemini transport caches one client per opaque credential handle', async () => {
  const module = await import('../../../src/agent/providers/gemini.js')
  const Transport = (module as Record<string, unknown>).GeminiTransport as new (options: any) => {
    prepare(context: DecisionContext): any
    execute(prepared: any, lease: any, signal: AbortSignal): Promise<any>
  }
  const resolvedHandles: string[] = []
  const createdKeys: string[] = []
  const transport = new Transport({
    resolveCredential(handle: string) {
      resolvedHandles.push(handle)
      return `KEY:${handle}`
    },
    createClient(apiKey: string) {
      createdKeys.push(apiKey)
      return {
        async create() {
          return {
            status: 'requires_action',
            steps: [{
              type: 'function_call',
              name: 'submit_decision',
              arguments: { version: 2, outcome: 'complete' }
            }]
          }
        }
      }
    }
  })
  const prepared = transport.prepare(context())
  const baseLease = {
    attemptId: 'attempt-cache-1', decisionId: 'decision-cache', configGeneration: 1,
    projectKey: 'pool-a', projectLabel: 'primary', credentialHandle: 'credential-a',
    model: 'gemini-3.5-flash-lite', thinking: 'low', budgetClass: 'normal', reservationId: 'attempt-cache-1'
  }

  await transport.execute(prepared, baseLease, new AbortController().signal)
  await transport.execute(prepared, { ...baseLease, attemptId: 'attempt-cache-2', reservationId: 'attempt-cache-2' }, new AbortController().signal)
  await transport.execute(prepared, {
    ...baseLease,
    attemptId: 'attempt-cache-3',
    reservationId: 'attempt-cache-3',
    credentialHandle: 'credential-b',
    projectKey: 'pool-b',
    projectLabel: 'backup-1'
  }, new AbortController().signal)

  assert.deepEqual(resolvedHandles, ['credential-a', 'credential-b'])
  assert.deepEqual(createdKeys, ['KEY:credential-a', 'KEY:credential-b'])
})

test('Gemini SDK attempt adapter disables automatic retries and forwards AbortSignal', async () => {
  const module = await import('../../../src/agent/providers/gemini.js')
  const createAttemptClient = (module as Record<string, unknown>).createGeminiAttemptClient as
    | undefined
    | ((apiKey: string, factory: (apiKey: string) => any) => {
        create(request: GeminiInteractionRequest, options: {
          timeout: number
          retryAttempts: 1
          signal: AbortSignal
        }): Promise<GeminiInteractionResponse>
      })
  assert.equal(typeof createAttemptClient, 'function')
  if (!createAttemptClient) return

  const sdkCalls: Array<{ request: any; options: any }> = []
  const controller = new AbortController()
  const client = createAttemptClient('SDK_TEST_KEY', apiKey => {
    assert.equal(apiKey, 'SDK_TEST_KEY')
    return {
      interactions: {
        async create(request: any, options: any) {
          sdkCalls.push({ request, options })
          return {
            status: 'requires_action',
            steps: [{
              type: 'function_call',
              name: 'submit_decision',
              arguments: { version: 2, outcome: 'complete' }
            }],
            usage: {
              total_input_tokens: 3,
              total_output_tokens: 1,
              total_thought_tokens: 0,
              total_tool_use_tokens: 0,
              total_tokens: 4
            }
          }
        }
      }
    }
  })

  const response = await client.create({
    model: 'gemini-3.5-flash-lite',
    input: '{}',
    store: false,
    stream: false,
    system_instruction: 'test',
    tools: [],
    generation_config: {
      thinking_level: 'low',
      thinking_summaries: 'none',
      tool_choice: 'any'
    }
  }, {
    timeout: 321,
    retryAttempts: 1,
    signal: controller.signal
  })

  assert.equal(sdkCalls.length, 1)
  assert.equal(sdkCalls[0]?.options.timeout, 321)
  assert.equal(sdkCalls[0]?.options.maxRetries, 0)
  assert.equal(sdkCalls[0]?.options.signal, controller.signal)
  assert.deepEqual(response.usage, {
    total_input_tokens: 3,
    total_output_tokens: 1,
    total_thought_tokens: 0,
    total_tool_use_tokens: 0,
    total_tokens: 4
  })
})
