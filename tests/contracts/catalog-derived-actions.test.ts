import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decisionSkillContracts,
  goalSkillContracts
} from '../../src/contracts/skill-catalog.js'
import { DecisionOutcomeV2Schema } from '../../src/contracts/decision.js'
import { GoalRequestSchema } from '../../src/contracts/goals.js'

const expectedActionNames = [
  'follow_player',
  'stay',
  'go_to',
  'return_home',
  'eat',
  'equip',
  'gather_resource',
  'explore_resource',
  'excavate_resource',
  'acquire_resource',
  'deposit_item',
  'withdraw_item'
] as const

test('goal and provider action allowlists come from the trusted catalog', () => {
  assert.deepEqual(
    goalSkillContracts().map(entry => entry.name),
    expectedActionNames
  )
  assert.deepEqual(
    decisionSkillContracts().map(entry => entry.name),
    expectedActionNames
  )
})

test('catalog-derived schemas preserve strict bounded action behavior', () => {
  assert.deepEqual(
    GoalRequestSchema.parse({
      kind: 'acquire_resource',
      args: {
        resource: 'some_mod:uranium_ore',
        quantity: 2,
        exploreRadius: 8
      }
    }),
    {
      kind: 'acquire_resource',
      args: {
        resource: 'some_mod:uranium_ore',
        quantity: 2,
        exploreRadius: 8
      }
    }
  )

  assert.equal(
    GoalRequestSchema.safeParse({
      kind: 'acquire_resource',
      args: {
        resource: 'iron_ore',
        quantity: 1,
        hiddenCommand: '/op @a'
      }
    }).success,
    false
  )

  assert.equal(
    DecisionOutcomeV2Schema.safeParse({
      version: 2,
      outcome: 'action',
      action: {
        intent: 'stop',
        args: {}
      }
    }).success,
    false
  )

  assert.equal(
    DecisionOutcomeV2Schema.safeParse({
      version: 2,
      outcome: 'action',
      action: {
        intent: 'find_resource',
        args: { resource: 'diamond_ore' }
      }
    }).success,
    false
  )
})
