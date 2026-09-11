import assert from 'node:assert/strict'
import test from 'node:test'
import { DecisionV1Schema } from '../../src/contracts/decision.js'

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
