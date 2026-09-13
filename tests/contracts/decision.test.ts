import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DecisionOutcomeV2Schema,
  DecisionV1Schema
} from '../../src/contracts/decision.js'

test('decision rejects reasoning fields and unknown properties', () => {
  const result = DecisionV1Schema.safeParse({
    version: 1,
    intent: 'gather_resource',
    args: { resource: 'oak_log', quantity: 32 },
    reasoning: 'hidden thought'
  })

  assert.equal(result.success, false)
})

test('decision accepts one allowlisted high-level intent', () => {
  const result = DecisionV1Schema.parse({
    version: 1,
    intent: 'gather_resource',
    args: { resource: 'oak_log', quantity: 32 }
  })

  assert.equal(result.intent, 'gather_resource')
  assert.equal(result.args.quantity, 32)
})

test('decision rejects arbitrary command intents', () => {
  const result = DecisionV1Schema.safeParse({
    version: 1,
    intent: 'raw_command',
    args: { command: '/kill @e' }
  })

  assert.equal(result.success, false)
})

test('decision rejects unknown fields inside args', () => {
  const result = DecisionV1Schema.safeParse({
    version: 1,
    intent: 'follow_player',
    args: { player: 'Boss', range: 3, thought: 'follow closely' }
  })

  assert.equal(result.success, false)
})

test('DecisionOutcomeV2 accepts one bounded action outcome', () => {
  const result = DecisionOutcomeV2Schema.parse({
    version: 2,
    outcome: 'action',
    action: {
      intent: 'gather_resource',
      args: { resource: 'oak_log', quantity: 4 }
    }
  })

  assert.equal(result.outcome, 'action')
  if (result.outcome !== 'action') return
  assert.equal(result.action.intent, 'gather_resource')
})

test('DecisionOutcomeV2 supports explicit complete and bounded blocked terminal outcomes', () => {
  assert.deepEqual(
    DecisionOutcomeV2Schema.parse({ version: 2, outcome: 'complete' }),
    { version: 2, outcome: 'complete' }
  )
  assert.deepEqual(
    DecisionOutcomeV2Schema.parse({
      version: 2,
      outcome: 'blocked',
      reason: 'capability_unavailable'
    }),
    {
      version: 2,
      outcome: 'blocked',
      reason: 'capability_unavailable'
    }
  )
})

test('DecisionOutcomeV2 rejects free-text blocked reasons and reasoning fields', () => {
  assert.equal(DecisionOutcomeV2Schema.safeParse({
    version: 2,
    outcome: 'blocked',
    reason: 'I cannot do this because I reasoned about it'
  }).success, false)

  assert.equal(DecisionOutcomeV2Schema.safeParse({
    version: 2,
    outcome: 'complete',
    reasoning: 'hidden reasoning'
  }).success, false)
})
