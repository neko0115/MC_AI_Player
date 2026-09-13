import assert from 'node:assert/strict'
import test from 'node:test'
import type { DecisionContext } from '../../../src/agent/context-builder.js'
import { GeminiTransport } from '../../../src/agent/providers/gemini.js'

function context(): DecisionContext {
  return {
    worldKey: 'live-regression',
    task: {
      taskId: 'task-stay',
      objective: '待在這裡',
      phase: 'active',
      consecutiveReplans: 0,
      previousAction: null
    },
    currentGoal: null,
    self: {
      connected: true,
      spawned: true,
      health: 20,
      food: 20,
      dimension: 'overworld',
      position: { x: 9.5, y: 76, z: -6.5 }
    },
    nearbyPlayers: [{
      name: 'Neko0115',
      id: 'b19a556a-0e50-40ec-88db-4e587dede94c',
      position: { x: 18.98, y: 71, z: -4.18 }
    }],
    inventory: [],
    recentEvents: [],
    memories: [],
    skills: [{ name: 'stay', description: 'Hold the current position safely.' }],
    safetyConstraints: ['PvP is disabled.']
  }
}

function lease(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    attemptId: 'attempt-stay',
    decisionId: 'decision-stay',
    configGeneration: 1,
    projectKey: 'pool-a',
    projectLabel: 'primary',
    credentialHandle: 'credential-a',
    model: 'gemini-3.5-flash-lite',
    thinking: 'low',
    budgetClass: 'normal',
    reservationId: 'attempt-stay',
    ...overrides
  } as any
}

const usage = {
  total_input_tokens: 10,
  total_output_tokens: 2,
  total_thought_tokens: 0,
  total_tool_use_tokens: 0,
  total_tokens: 12
}

test('routed Gemini projects known compatibility-superset fields into a strict stay outcome', async () => {
  const transport = new GeminiTransport({
    resolveCredential: () => 'TEST_KEY',
    createClient: () => ({
      async create() {
        return {
          status: 'requires_action',
          steps: [{
            type: 'function_call',
            name: 'submit_decision',
            arguments: {
              version: 2,
              outcome: 'action',
              reason: 'missing_information',
              action: {
                intent: 'stay',
                args: {
                  player: 'Neko0115',
                  range: 4,
                  x: 1,
                  y: 64,
                  z: 1,
                  radius: 2,
                  item: 'bread',
                  destination: 'hand',
                  resource: 'oak_log',
                  quantity: 1,
                  storage: 'home'
                }
              }
            }
          }],
          usage
        }
      }
    })
  })

  const prepared = transport.prepare(context())
  const result = await transport.execute(prepared, lease(), new AbortController().signal)

  assert.deepEqual(result, {
    kind: 'success',
    providerResult: {
      kind: 'structured',
      provider: 'gemini',
      mode: 'function_call',
      value: {
        version: 2,
        outcome: 'action',
        action: { intent: 'stay', args: {} }
      }
    },
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      thoughtTokens: 0,
      toolTokens: 0,
      totalTokens: 12
    }
  })
})

test('routed Gemini treats projected output that still violates strict V2 as generation error', async () => {
  const transport = new GeminiTransport({
    resolveCredential: () => 'TEST_KEY',
    createClient: () => ({
      async create() {
        return {
          status: 'requires_action',
          steps: [{
            type: 'function_call',
            name: 'submit_decision',
            arguments: {
              version: 2,
              outcome: 'action',
              action: {
                intent: 'follow_player',
                args: { range: 4 }
              }
            }
          }],
          usage
        }
      }
    })
  })

  const prepared = transport.prepare(context())
  const result = await transport.execute(
    prepared,
    lease({ attemptId: 'attempt-invalid', decisionId: 'decision-invalid', reservationId: 'attempt-invalid' }),
    new AbortController().signal
  )

  assert.deepEqual(result, {
    kind: 'generation_error',
    code: 'decision_schema_invalid',
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      thoughtTokens: 0,
      toolTokens: 0,
      totalTokens: 12
    }
  })
})
