import assert from 'node:assert/strict'
import test from 'node:test'
import type { WorldStateSnapshot } from '../../src/state/world-state.js'
import {
  SafetyPolicy,
  isResourceMutationPermit
} from '../../src/safety/policy.js'

function readyState(overrides: Partial<WorldStateSnapshot> = {}): WorldStateSnapshot {
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

test('only scoped mutation skills may receive a block-mutation permit', () => {
  const policy = new SafetyPolicy()

  const allowed = policy.issueResourceMutationPermit(
    'gather_resource',
    ['oak_log'],
    { capabilities: ['break_blocks'] },
    readyState()
  )
  assert.equal(allowed.kind, 'allow')
  if (allowed.kind !== 'allow') return
  assert.deepEqual(allowed.permit.allowedBlockNames, ['oak_log'])
  assert.equal(isResourceMutationPermit(allowed.permit), true)

  const excavation = policy.issueResourceMutationPermit(
    'excavate_resource',
    ['stone', 'deepslate'],
    { capabilities: ['break_blocks'] },
    readyState()
  )
  assert.equal(excavation.kind, 'allow')
  if (excavation.kind === 'allow') {
    assert.deepEqual(
      excavation.permit.allowedBlockNames,
      ['stone', 'deepslate']
    )
  }

  const denied = policy.issueResourceMutationPermit(
    'go_to',
    ['oak_log'],
    { capabilities: ['break_blocks'] },
    readyState()
  )
  assert.deepEqual(denied, { kind: 'deny', code: 'mutation_skill_not_allowed' })
})

test('resource mutation permit requires declared break_blocks capability and ready Minecraft state', () => {
  const policy = new SafetyPolicy()

  assert.deepEqual(
    policy.issueResourceMutationPermit('gather_resource', ['oak_log'], {}, readyState()),
    { kind: 'deny', code: 'capability_not_declared' }
  )
  assert.deepEqual(
    policy.issueResourceMutationPermit(
      'gather_resource',
      ['oak_log'],
      { capabilities: ['break_blocks'] },
      readyState({ connected: false, spawned: false })
    ),
    { kind: 'deny', code: 'minecraft_not_ready' }
  )
})

test('empty or wildcard mutation scopes are rejected', () => {
  const policy = new SafetyPolicy()

  assert.deepEqual(
    policy.issueResourceMutationPermit(
      'gather_resource',
      [],
      { capabilities: ['break_blocks'] },
      readyState()
    ),
    { kind: 'deny', code: 'invalid_mutation_scope' }
  )
  assert.deepEqual(
    policy.issueResourceMutationPermit(
      'gather_resource',
      ['*'],
      { capabilities: ['break_blocks'] },
      readyState()
    ),
    { kind: 'deny', code: 'invalid_mutation_scope' }
  )
})

test('plain objects cannot forge a resource mutation permit', () => {
  assert.equal(
    isResourceMutationPermit({ mutateBlocks: true, allowedBlockNames: ['oak_log'] }),
    false
  )
})
