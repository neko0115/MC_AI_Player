import assert from 'node:assert/strict'
import test from 'node:test'
import { SafetyPolicy } from '../../src/safety/policy.js'
import type { WorldStateSnapshot } from '../../src/state/world-state.js'
import { RuntimeEventBus } from '../../src/telemetry/event-bus.js'
import { DecisionGate } from '../../src/agent/decision-gate.js'
import type { ProviderResult } from '../../src/agent/provider.js'
import type { SkillName } from '../../src/contracts/skills.js'

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

function structured(value: unknown, mode: 'schema' | 'function_call' = 'function_call'): ProviderResult {
  return { kind: 'structured', provider: 'fake', mode, value }
}

const registered = (_name: SkillName): boolean => true

test('V2 action passes strict schema, registered-skill check, and latest safety without submitting a goal', async () => {
  const events = new RuntimeEventBus()
  const emitted: string[] = []
  events.subscribe(event => { emitted.push(event.type) })
  const gate = new DecisionGate({ safety: new SafetyPolicy(), events, now: () => 123 })

  const gated = await gate.accept(structured({
    version: 2,
    outcome: 'action',
    action: {
      intent: 'gather_resource',
      args: { resource: 'oak_log', quantity: 16 }
    }
  }), state(), registered)

  assert.deepEqual(gated, {
    kind: 'action',
    provider: 'fake',
    mode: 'function_call',
    intent: 'gather_resource',
    goal: {
      kind: 'gather_resource',
      args: { resource: 'oak_log', quantity: 16 }
    }
  })
  assert.deepEqual(emitted, ['decision_accepted'])
})

test('complete is a valid terminal outcome and creates no GoalRequest', async () => {
  const gate = new DecisionGate({ safety: new SafetyPolicy() })
  assert.deepEqual(
    await gate.accept(structured({ version: 2, outcome: 'complete' }), state(), registered),
    { kind: 'complete', provider: 'fake', mode: 'function_call' }
  )
})

test('blocked is a valid terminal outcome with only a bounded reason', async () => {
  const gate = new DecisionGate({ safety: new SafetyPolicy() })
  assert.deepEqual(
    await gate.accept(structured({
      version: 2,
      outcome: 'blocked',
      reason: 'missing_information'
    }, 'schema'), state(), registered),
    {
      kind: 'blocked',
      provider: 'fake',
      mode: 'schema',
      reason: 'missing_information'
    }
  )
})

test('schema-known but unregistered action is rejected before SafetyPolicy execution', async () => {
  const gate = new DecisionGate({ safety: new SafetyPolicy() })
  const onlyGather = (name: SkillName): boolean => name === 'gather_resource'

  assert.deepEqual(await gate.accept(structured({
    version: 2,
    outcome: 'action',
    action: { intent: 'deposit_item', args: { item: 'oak_log', quantity: 1, storage: 'home' } }
  }), state(), onlyGather), {
    kind: 'rejected',
    provider: 'fake',
    code: 'skill_not_registered'
  })
})

test('reasoning-like or unknown fields are rejected by the V2 outcome schema', async () => {
  const gate = new DecisionGate({ safety: new SafetyPolicy() })
  const rejected = await gate.accept(structured({
    version: 2,
    outcome: 'complete',
    reasoning: 'this must never cross the boundary'
  }, 'schema'), state(), registered)

  assert.deepEqual(rejected, {
    kind: 'rejected',
    provider: 'fake',
    code: 'decision_schema_invalid'
  })
})

test('provider invalid and timeout results still fail closed', async () => {
  const gate = new DecisionGate({ safety: new SafetyPolicy() })
  assert.deepEqual(await gate.accept({
    kind: 'invalid', provider: 'fake', code: 'unstructured_response'
  }, state(), registered), {
    kind: 'rejected', provider: 'fake', code: 'unstructured_response'
  })
  assert.deepEqual(await gate.accept({
    kind: 'timeout', provider: 'fake'
  }, state(), registered), {
    kind: 'rejected', provider: 'fake', code: 'provider_timeout'
  })
})

test('SafetyPolicy rejection blocks a syntactically valid registered action', async () => {
  const gate = new DecisionGate({
    safety: new SafetyPolicy({ minHealthForNonCritical: 8 })
  })

  assert.deepEqual(await gate.accept(structured({
    version: 2,
    outcome: 'action',
    action: { intent: 'gather_resource', args: { resource: 'oak_log', quantity: 1 } }
  }), state({ health: 7 }), registered), {
    kind: 'rejected', provider: 'fake', code: 'low_health'
  })
})

test('not-ready Minecraft state rejects even an otherwise valid registered stay action', async () => {
  const gate = new DecisionGate({ safety: new SafetyPolicy() })
  assert.deepEqual(await gate.accept(structured({
    version: 2,
    outcome: 'action',
    action: { intent: 'stay', args: {} }
  }, 'schema'), state({ connected: false, spawned: false }), registered), {
    kind: 'rejected', provider: 'fake', code: 'minecraft_not_ready'
  })
})

test('unknown provider envelope and unsupported structured mode cannot masquerade as outcomes', async () => {
  const gate = new DecisionGate({ safety: new SafetyPolicy() })

  const forgedKind = {
    kind: 'raw_text', provider: 'rogue-provider', mode: 'schema', value: { version: 2, outcome: 'complete' }
  } as unknown as ProviderResult
  assert.deepEqual(await gate.accept(forgedKind, state(), registered), {
    kind: 'rejected', provider: 'rogue-provider', code: 'provider_result_invalid'
  })

  const forgedMode = {
    kind: 'structured', provider: 'rogue-provider', mode: 'text', value: { version: 2, outcome: 'complete' }
  } as unknown as ProviderResult
  assert.deepEqual(await gate.accept(forgedMode, state(), registered), {
    kind: 'rejected', provider: 'rogue-provider', code: 'provider_result_invalid'
  })
})

test('structured provider envelope rejects extra raw-text or reasoning fields', async () => {
  const gate = new DecisionGate({ safety: new SafetyPolicy() })
  for (const extra of [
    { rawText: '{"version":2,"outcome":"complete"}' },
    { reasoning: 'private thought' }
  ]) {
    const malformed = {
      kind: 'structured', provider: 'rogue-provider', mode: 'schema',
      value: { version: 2, outcome: 'complete' }, ...extra
    } as unknown as ProviderResult
    assert.deepEqual(await gate.accept(malformed, state(), registered), {
      kind: 'rejected', provider: 'rogue-provider', code: 'provider_result_invalid'
    })
  }
})
