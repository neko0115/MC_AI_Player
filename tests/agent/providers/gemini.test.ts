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
