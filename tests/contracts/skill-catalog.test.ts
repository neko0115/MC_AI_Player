import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SKILL_CONTRACTS,
  aiExposedSkillContracts,
  skillContract
} from '../../src/contracts/skill-catalog.js'
import { SkillNameSchema } from '../../src/contracts/skills.js'

test('trusted skill catalog covers every canonical skill name exactly once', () => {
  assert.equal(
    new Set(SKILL_CONTRACTS.map(entry => entry.name)).size,
    SKILL_CONTRACTS.length
  )
  assert.deepEqual(
    [...SKILL_CONTRACTS.map(entry => entry.name)].sort(),
    [...SkillNameSchema.options].sort()
  )
})

test('AI exposure preserves the existing high-level decision catalog', () => {
  assert.deepEqual(
    aiExposedSkillContracts().map(entry => ({
      name: entry.name,
      description: entry.ai.description
    })),
    [
      {
        name: 'follow_player',
        description: 'Follow one named player at a bounded range.'
      },
      {
        name: 'stay',
        description: 'Hold the current position until safely superseded.'
      },
      {
        name: 'go_to',
        description: 'Navigate to one bounded coordinate target without generic digging.'
      },
      {
        name: 'return_home',
        description: 'Return to the configured home location.'
      },
      {
        name: 'eat',
        description: 'Eat one approved ordinary food item.'
      },
      {
        name: 'equip',
        description: 'Equip one exact inventory item to an approved destination.'
      },
      {
        name: 'acquire_resource',
        description: 'Acquire at least a bounded quantity of one resource through visible search, known resource memory, no-dig exploration, bounded excavation, and deterministic gathering.'
      },
      {
        name: 'deposit_item',
        description: 'Deposit an exact bounded quantity into one named storage target.'
      },
      {
        name: 'withdraw_item',
        description: 'Withdraw an exact bounded quantity from one named storage target.'
      }
    ]
  )
})

test('trusted catalog carries bounded argument schemas and safety authority metadata', () => {
  const acquire = skillContract('acquire_resource')
  assert.deepEqual(
    acquire.argsSchema?.parse({
      resource: 'some_mod:uranium_ore',
      quantity: 2,
      exploreRadius: 8
    }),
    {
      resource: 'some_mod:uranium_ore',
      quantity: 2,
      exploreRadius: 8
    }
  )

  const gather = skillContract('gather_resource')
  assert.deepEqual(gather.safety.capabilities, ['break_blocks'])
  assert.equal(gather.safety.mutationAuthority, 'resource_break')

  const excavate = skillContract('excavate_resource')
  assert.deepEqual(excavate.safety.capabilities, ['break_blocks'])
  assert.equal(excavate.safety.mutationAuthority, 'resource_break')

  assert.equal(skillContract('stop').argsSchema, null)
  assert.equal(skillContract('stop').ai.exposed, false)
})
