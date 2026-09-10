import assert from 'node:assert/strict'
import test from 'node:test'
import type { GoalRequest, GoalSource } from '../../src/contracts/goals.js'
import { SafetyPolicy } from '../../src/safety/policy.js'
import type { WorldStateSnapshot } from '../../src/state/world-state.js'
import { RuntimeEventBus } from '../../src/telemetry/event-bus.js'
import {
  DecisionGate,
  DecisionPipeline,
  type AiGoalSubmitter
} from '../../src/agent/decision-gate.js'
import type { ProviderResult } from '../../src/agent/provider.js'

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

class RecordingGoalSubmitter implements AiGoalSubmitter {
  readonly submissions: Array<{ request: GoalRequest; source: GoalSource }> = []

  async submit(request: GoalRequest, source: GoalSource): Promise<void> {
    this.submissions.push({ request, source })
  }
}

test('valid structured decision passes strict schema, safety, and becomes one AI GoalRequest', async () => {
  const events = new RuntimeEventBus()
  const emitted: string[] = []
  events.subscribe(event => {
    emitted.push(event.type)
  })
  const gate = new DecisionGate({
    safety: new SafetyPolicy(),
    events,
    now: () => 123
  })
  const goals = new RecordingGoalSubmitter()
  const pipeline = new DecisionPipeline(gate, goals)
  const result: ProviderResult = {
    kind: 'structured',
    provider: 'fake',
    mode: 'function_call',
    value: {
      version: 1,
      intent: 'gather_resource',
      args: { resource: 'oak_log', quantity: 16 }
    }
  }

  const accepted = await pipeline.handle(result, state())

  assert.equal(accepted.kind, 'accepted')
  assert.deepEqual(goals.submissions, [{
    request: {
      kind: 'gather_resource',
      args: { resource: 'oak_log', quantity: 16 }
    },
    source: 'ai'
  }])
  assert.deepEqual(emitted, ['decision_accepted'])
})

test('structured value with reasoning-like or unknown fields is rejected and starts no goal', async () => {
  const events = new RuntimeEventBus()
  const emitted: Array<{ type: string; code?: string }> = []
  events.subscribe(event => {
    const code = (event as { code?: unknown }).code
    if (typeof code === 'string') {
      emitted.push({ type: event.type, code })
    } else {
      emitted.push({ type: event.type })
    }
  })
  const gate = new DecisionGate({ safety: new SafetyPolicy(), events, now: () => 10 })
  const goals = new RecordingGoalSubmitter()
  const pipeline = new DecisionPipeline(gate, goals)

  const rejected = await pipeline.handle({
    kind: 'structured',
    provider: 'fake',
    mode: 'schema',
    value: {
      version: 1,
      intent: 'stay',
      args: {},
      reasoning: 'this field must never be accepted'
    }
  }, state())

  assert.deepEqual(rejected, {
    kind: 'rejected',
    provider: 'fake',
    code: 'decision_schema_invalid'
  })
  assert.deepEqual(goals.submissions, [])
  assert.deepEqual(emitted, [{ type: 'decision_rejected', code: 'decision_schema_invalid' }])
})

test('provider invalid and timeout results fail closed without goal submission', async () => {
  const gate = new DecisionGate({ safety: new SafetyPolicy() })
  const goals = new RecordingGoalSubmitter()
  const pipeline = new DecisionPipeline(gate, goals)

  const invalid = await pipeline.handle({
    kind: 'invalid',
    provider: 'fake',
    code: 'unstructured_response'
  }, state())
  const timeout = await pipeline.handle({ kind: 'timeout', provider: 'fake' }, state())

  assert.deepEqual(invalid, {
    kind: 'rejected',
    provider: 'fake',
    code: 'unstructured_response'
  })
  assert.deepEqual(timeout, {
    kind: 'rejected',
    provider: 'fake',
    code: 'provider_timeout'
  })
  assert.deepEqual(goals.submissions, [])
})

test('SafetyPolicy rejection blocks a syntactically valid AI decision', async () => {
  const gate = new DecisionGate({
    safety: new SafetyPolicy({ minHealthForNonCritical: 8 })
  })
  const goals = new RecordingGoalSubmitter()
  const pipeline = new DecisionPipeline(gate, goals)

  const result = await pipeline.handle({
    kind: 'structured',
    provider: 'fake',
    mode: 'function_call',
    value: {
      version: 1,
      intent: 'gather_resource',
      args: { resource: 'oak_log', quantity: 1 }
    }
  }, state({ health: 7 }))

  assert.deepEqual(result, {
    kind: 'rejected',
    provider: 'fake',
    code: 'low_health'
  })
  assert.deepEqual(goals.submissions, [])
})

test('not-ready Minecraft state rejects even an otherwise valid stay decision', async () => {
  const gate = new DecisionGate({ safety: new SafetyPolicy() })

  const result = await gate.accept({
    kind: 'structured',
    provider: 'fake',
    mode: 'schema',
    value: { version: 1, intent: 'stay', args: {} }
  }, state({ connected: false, spawned: false }))

  assert.deepEqual(result, {
    kind: 'rejected',
    provider: 'fake',
    code: 'minecraft_not_ready'
  })
})

test('unknown provider result kind cannot masquerade as a structured decision', async () => {
  const gate = new DecisionGate({ safety: new SafetyPolicy() })
  const goals = new RecordingGoalSubmitter()
  const pipeline = new DecisionPipeline(gate, goals)
  const forged = {
    kind: 'raw_text',
    provider: 'rogue-provider',
    mode: 'schema',
    text: '{"version":1,"intent":"stay","args":{}}',
    value: { version: 1, intent: 'stay', args: {} }
  } as unknown as ProviderResult

  const result = await pipeline.handle(forged, state())

  assert.deepEqual(result, {
    kind: 'rejected',
    provider: 'rogue-provider',
    code: 'provider_result_invalid'
  })
  assert.deepEqual(goals.submissions, [])
})

test('structured result with an unsupported mode fails closed before decision parsing', async () => {
  const gate = new DecisionGate({ safety: new SafetyPolicy() })
  const goals = new RecordingGoalSubmitter()
  const pipeline = new DecisionPipeline(gate, goals)
  const malformed = {
    kind: 'structured',
    provider: 'rogue-provider',
    mode: 'text',
    value: { version: 1, intent: 'stay', args: {} }
  } as unknown as ProviderResult

  const result = await pipeline.handle(malformed, state())

  assert.deepEqual(result, {
    kind: 'rejected',
    provider: 'rogue-provider',
    code: 'provider_result_invalid'
  })
  assert.deepEqual(goals.submissions, [])
})

test('structured provider envelope rejects extra raw-text or reasoning fields', async () => {
  const gate = new DecisionGate({ safety: new SafetyPolicy() })
  const goals = new RecordingGoalSubmitter()
  const pipeline = new DecisionPipeline(gate, goals)

  for (const extra of [
    { rawText: '{"version":1,"intent":"stay","args":{}}' },
    { reasoning: 'private thought must not cross the boundary' }
  ]) {
    const malformed = {
      kind: 'structured',
      provider: 'rogue-provider',
      mode: 'schema',
      value: { version: 1, intent: 'stay', args: {} },
      ...extra
    } as unknown as ProviderResult

    const result = await pipeline.handle(malformed, state())
    assert.deepEqual(result, {
      kind: 'rejected',
      provider: 'rogue-provider',
      code: 'provider_result_invalid'
    })
  }

  assert.deepEqual(goals.submissions, [])
})
