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

test('routed Gemini exposes exact object-root tools for registered actions and terminal outcomes', () => {
  const prepared = new GeminiTransport().prepare(context())
  const names = prepared.tools.map(tool => tool.name).sort()

  assert.deepEqual(names, [
    'action_stay',
    'decision_blocked',
    'decision_complete'
  ])
  assert.equal(names.includes('submit_decision'), false)

  for (const tool of prepared.tools) {
    assert.equal(tool.parameters.type, 'object', tool.name)
    assert.equal(tool.parameters.additionalProperties, false, tool.name)
    assert.equal(containsKey(tool.parameters, 'oneOf'), false, tool.name)
  }

  const stay = prepared.tools.find(tool => tool.name === 'action_stay')
  assert.ok(stay)
  assert.deepEqual(stay.parameters.properties, {})

  const complete = prepared.tools.find(tool => tool.name === 'decision_complete')
  assert.ok(complete)
  assert.deepEqual(complete.parameters.properties, {})

  const blocked = prepared.tools.find(tool => tool.name === 'decision_blocked')
  assert.ok(blocked)
  const blockedProperties = blocked.parameters.properties as Record<string, any>
  assert.deepEqual(blockedProperties.reason?.enum, [
    'no_safe_action',
    'missing_information',
    'capability_unavailable'
  ])
  assert.deepEqual(blocked.parameters.required, ['reason'])
})
