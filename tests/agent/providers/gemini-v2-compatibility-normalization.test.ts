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
    skills: [
      { name: 'stay', description: 'Hold the current position safely.' },
      { name: 'follow_player', description: 'Follow one named player.' }
    ],
    safetyConstraints: ['PvP is disabled.']
  }
}

function lease(id: string) {
  return {
    attemptId: `attempt-${id}`,
    decisionId: `decision-${id}`,
    configGeneration: 1,
    projectKey: 'pool-a',
    projectLabel: 'primary' as const,
    credentialHandle: 'credential-a',
    model: 'gemini-3.5-flash-lite',
    thinking: 'low' as const,
    budgetClass: 'normal' as const,
    reservationId: `attempt-${id}`
  }
}

const USAGE = {
  total_input_tokens: 10,
  total_output_tokens: 2,
  total_thought_tokens: 0,
  total_tool_use_tokens: 0,
  total_tokens: 12
}

const EXPECTED_USAGE = {
  inputTokens: 10,
  outputTokens: 2,
  thoughtTokens: 0,
  toolTokens: 0,
  totalTokens: 12
}

function transportWithCall(name: string, args: unknown) {
  return new GeminiTransport({
    resolveCredential: () => 'TEST_KEY',
    createClient: () => ({
      async create() {
        return {
          status: 'requires_action',
          steps: [{
            type: 'function_call',
            name,
            arguments: args
          }],
          usage: USAGE
        }
      }
    })
  })
}

test('routed Gemini maps exact action_stay tool into strict DecisionOutcomeV2', async () => {
  const transport = transportWithCall('action_stay', {})

  const result = await transport.execute(
    transport.prepare(context()),
    lease('stay'),
    new AbortController().signal
  )

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
    usage: EXPECTED_USAGE
  })
})

test('routed Gemini maps exact follow tool arguments into strict DecisionOutcomeV2', async () => {
  const transport = transportWithCall('action_follow_player', {
    player: 'Neko0115',
    range: 4
  })

  const result = await transport.execute(
    transport.prepare(context()),
    lease('follow'),
    new AbortController().signal
  )

  assert.deepEqual(result, {
    kind: 'success',
    providerResult: {
      kind: 'structured',
      provider: 'gemini',
      mode: 'function_call',
      value: {
        version: 2,
        outcome: 'action',
        action: {
          intent: 'follow_player',
          args: { player: 'Neko0115', range: 4 }
        }
      }
    },
    usage: EXPECTED_USAGE
  })
})

test('routed Gemini fails closed when exact follow tool omits required player', async () => {
  const transport = transportWithCall('action_follow_player', { range: 4 })

  const result = await transport.execute(
    transport.prepare(context()),
    lease('invalid-follow'),
    new AbortController().signal
  )

  assert.deepEqual(result, {
    kind: 'generation_error',
    code: 'decision_schema_invalid',
    usage: EXPECTED_USAGE
  })
})

test('routed Gemini rejects unknown decision tool names', async () => {
  const transport = transportWithCall('action_do_anything', {})

  const result = await transport.execute(
    transport.prepare(context()),
    lease('unknown-tool'),
    new AbortController().signal
  )

  assert.deepEqual(result, {
    kind: 'generation_error',
    code: 'unexpected_function_call',
    usage: EXPECTED_USAGE
  })
})

test('routed Gemini maps exact terminal tools into strict terminal outcomes', async () => {
  const completeTransport = transportWithCall('decision_complete', {})
  const blockedTransport = transportWithCall('decision_blocked', {
    reason: 'missing_information'
  })

  const complete = await completeTransport.execute(
    completeTransport.prepare(context()),
    lease('complete'),
    new AbortController().signal
  )
  const blocked = await blockedTransport.execute(
    blockedTransport.prepare(context()),
    lease('blocked'),
    new AbortController().signal
  )

  assert.deepEqual(complete, {
    kind: 'success',
    providerResult: {
      kind: 'structured',
      provider: 'gemini',
      mode: 'function_call',
      value: { version: 2, outcome: 'complete' }
    },
    usage: EXPECTED_USAGE
  })
  assert.deepEqual(blocked, {
    kind: 'success',
    providerResult: {
      kind: 'structured',
      provider: 'gemini',
      mode: 'function_call',
      value: {
        version: 2,
        outcome: 'blocked',
        reason: 'missing_information'
      }
    },
    usage: EXPECTED_USAGE
  })
})
