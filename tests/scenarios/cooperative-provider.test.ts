import assert from 'node:assert/strict'
import test from 'node:test'
import { ContextBuilder } from '../../src/agent/context-builder.js'
import { DecisionGate } from '../../src/agent/decision-gate.js'
import {
  GeminiDecisionProvider,
  type GeminiInteractionClient,
  type GeminiInteractionRequest,
  type GeminiInteractionResponse
} from '../../src/agent/providers/gemini.js'
import { SafetyPolicy } from '../../src/safety/policy.js'
import { WorldStateCache } from '../../src/state/world-state-cache.js'
import { ReplayReader } from '../../src/telemetry/replay.js'

const WORLD_KEY = 'acceptance-server:survival-v1'
const REASONING_SENTINEL = 'PRIVATE_GEMINI_REASONING_SENTINEL'

class CooperativeGeminiInteractions implements GeminiInteractionClient {
  readonly requests: Array<{
    request: GeminiInteractionRequest
    options: { timeout: number }
  }> = []

  async create(
    request: GeminiInteractionRequest,
    options: { readonly timeout: number }
  ): Promise<GeminiInteractionResponse> {
    this.requests.push({
      request: structuredClone(request),
      options: { timeout: options.timeout }
    })
    return {
      status: 'requires_action',
      steps: [
        {
          type: 'thought',
          summary: [{ type: 'text', text: REASONING_SENTINEL }]
        },
        {
          type: 'function_call',
          id: 'cooperative-gather',
          name: 'submit_decision',
          arguments: {
            version: 1,
            intent: 'gather_resource',
            args: { resource: 'oak_log', quantity: 16 }
          }
        }
      ]
    }
  }
}

test('Gemini provider adapter maps the cooperative replay to the same allowlisted gather GoalRequest without exposing reasoning', async () => {
  const replay = await ReplayReader.readAll('fixtures/replay/cooperative-session.jsonl')
  const state = new WorldStateCache({ maxRecentEvents: 64 })
  for (const event of replay) state.apply(event)

  const context = new ContextBuilder().build({
    worldKey: WORLD_KEY,
    state: state.snapshot(),
    currentGoal: null,
    memories: [],
    skills: [
      {
        name: 'gather_resource',
        description: 'Gather an exact bounded resource quantity.'
      }
    ],
    safetyConstraints: [
      'PvP is disabled.',
      'Generic navigation cannot dig.',
      'Only gather_resource may receive a scoped block-mutation permit.'
    ]
  })

  const interactions = new CooperativeGeminiInteractions()
  const provider = new GeminiDecisionProvider({
    interactions,
    model: 'gemini-3.8-flash',
    thinkingLevel: 'high',
    timeoutMs: 30_000
  })

  const result = await provider.decide({ context })
  assert.equal(JSON.stringify(result).includes(REASONING_SENTINEL), false)

  const gated = await new DecisionGate({ safety: new SafetyPolicy() }).accept(
    result,
    state.snapshot()
  )

  assert.deepEqual(gated, {
    kind: 'accepted',
    provider: 'gemini',
    mode: 'function_call',
    intent: 'gather_resource',
    goal: {
      kind: 'gather_resource',
      args: { resource: 'oak_log', quantity: 16 }
    }
  })

  assert.equal(interactions.requests.length, 1)
  const sent = interactions.requests[0]
  assert.ok(sent)
  assert.equal(sent.request.generation_config.thinking_level, 'high')
  assert.equal(sent.request.generation_config.thinking_summaries, 'none')
  assert.equal(sent.request.generation_config.tool_choice, 'any')
  assert.equal(sent.options.timeout, 30_000)
  assert.equal(sent.request.input.includes('幫我找 16 個橡木'), true)
})
