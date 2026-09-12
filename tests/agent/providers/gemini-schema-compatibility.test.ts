import assert from 'node:assert/strict'
import test from 'node:test'
import type { DecisionContext } from '../../../src/agent/context-builder.js'
import { GeminiTransport } from '../../../src/agent/providers/gemini.js'

function context(): DecisionContext {
  return {
    worldKey: 'schema-compatibility',
    task: {
      taskId: 'schema-test',
      objective: 'Validate one Gemini-compatible structured outcome.',
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
      position: { x: 0, y: 64, z: 0 }
    },
    nearbyPlayers: [],
    inventory: [],
    recentEvents: [],
    memories: [],
    skills: [{ name: 'stay', description: 'Hold position.' }],
    safetyConstraints: ['Return one structured DecisionOutcomeV2.']
  }
}

function containsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some(item => containsKey(item, key))
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(record, key)) return true
  return Object.values(record).some(item => containsKey(item, key))
}

test('Gemini function parameters use an object-root schema without oneOf', () => {
  const prepared = new GeminiTransport().prepare(context())
  const parameters = prepared.tools[0]?.parameters as Record<string, unknown> | undefined

  assert.ok(parameters)
  assert.equal(parameters.type, 'object')
  assert.equal(parameters.additionalProperties, false)
  assert.equal(containsKey(parameters, 'oneOf'), false)

  const properties = parameters.properties as Record<string, unknown>
  assert.deepEqual(
    (properties.outcome as { enum?: unknown }).enum,
    ['action', 'complete', 'blocked']
  )
})
