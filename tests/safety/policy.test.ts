import assert from 'node:assert/strict'
import test from 'node:test'
import type { GoalRequest } from '../../src/contracts/goals.js'
import type { WorldStateSnapshot } from '../../src/state/world-state.js'
import {
  SafetyPolicy,
  type SkillSafetyMetadata
} from '../../src/safety/policy.js'

function state(overrides: Partial<WorldStateSnapshot> = {}): WorldStateSnapshot {
  return {
    connected: true,
    spawned: true,
    health: 20,
    food: 20,
    dimension: 'overworld',
    position: { x: 0, y: 64, z: 0 },
    nearbyPlayers: [],
    inventory: [],
    recentEvents: [],
    ...overrides
  }
}

const gatherGoal: GoalRequest = {
  kind: 'gather_resource',
  args: { resource: 'oak_log', quantity: 16 }
}

const followGoal: GoalRequest = {
  kind: 'follow_player',
  args: { player: 'Boss', range: 3 }
}

test('unknown skill is denied by default', () => {
  const policy = new SafetyPolicy()

  const decision = policy.authorizeSkill('raw_command', state())

  assert.equal(decision.kind, 'deny')
  assert.equal(decision.code, 'unknown_skill')
})

test('gameplay skills are denied while disconnected or not spawned', () => {
  const policy = new SafetyPolicy()

  assert.deepEqual(policy.authorizeSkill('go_to', state({ connected: false, spawned: false })), {
    kind: 'deny',
    code: 'minecraft_not_ready'
  })
  assert.deepEqual(policy.authorizeSkill('gather_resource', state({ spawned: false })), {
    kind: 'deny',
    code: 'minecraft_not_ready'
  })
})

test('generic navigation is hardened against digging, building and pvp', () => {
  const policy = new SafetyPolicy()

  assert.deepEqual(policy.navigationPolicy(), {
    canDig: false,
    canPlaceBlocks: false,
    allowPvp: false
  })
})

test('block mutation requires an explicit internal skill capability', () => {
  const policy = new SafetyPolicy()
  const noCapabilities: SkillSafetyMetadata = {}
  const gatherCapabilities: SkillSafetyMetadata = { capabilities: ['break_blocks'] }

  assert.deepEqual(
    policy.authorizeCapability('gather_resource', 'break_blocks', noCapabilities, state()),
    { kind: 'deny', code: 'capability_not_declared' }
  )
  assert.deepEqual(
    policy.authorizeCapability('gather_resource', 'break_blocks', gatherCapabilities, state()),
    { kind: 'allow', code: 'allowed' }
  )
})

test('pvp remains denied even when a skill claims the capability', () => {
  const policy = new SafetyPolicy()

  assert.deepEqual(
    policy.authorizeCapability(
      'gather_resource',
      'pvp',
      { capabilities: ['pvp'] },
      state()
    ),
    { kind: 'deny', code: 'pvp_disabled' }
  )
})

test('low health preempts a non-critical gather goal', () => {
  const policy = new SafetyPolicy({ minHealthForNonCritical: 8, minFoodForNonCritical: 6 })

  assert.deepEqual(policy.runtimeAction(state({ health: 7 }), gatherGoal), {
    kind: 'preempt',
    code: 'low_health'
  })
})

test('starvation risk preempts a non-critical follow goal', () => {
  const policy = new SafetyPolicy({ minHealthForNonCritical: 8, minFoodForNonCritical: 6 })

  assert.deepEqual(policy.runtimeAction(state({ food: 5 }), followGoal), {
    kind: 'preempt',
    code: 'low_food'
  })
})

test('healthy connected state allows an ordinary goal to continue', () => {
  const policy = new SafetyPolicy({ minHealthForNonCritical: 8, minFoodForNonCritical: 6 })

  assert.deepEqual(policy.runtimeAction(state(), gatherGoal), {
    kind: 'allow',
    code: 'allowed'
  })
})

test('emergency stop is always preemptive even when Minecraft is not ready', () => {
  const policy = new SafetyPolicy()

  assert.deepEqual(policy.emergencyStop(state({ connected: false, spawned: false })), {
    kind: 'preempt',
    code: 'emergency_stop'
  })
})
