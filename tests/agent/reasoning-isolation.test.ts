import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { GoalRequest, GoalSource } from '../../src/contracts/goals.js'
import type { SkillName, SkillResult } from '../../src/contracts/skills.js'
import { GoalManager } from '../../src/goals/goal-manager.js'
import { SafetyPolicy } from '../../src/safety/policy.js'
import { SkillExecutor } from '../../src/skills/executor.js'
import { SkillRegistry } from '../../src/skills/registry.js'
import type { WorldStateSnapshot } from '../../src/state/world-state.js'
import { RuntimeEventBus } from '../../src/telemetry/event-bus.js'
import { DecisionGate, DecisionPipeline } from '../../src/agent/decision-gate.js'
import {
  adaptFakeSdkResponse,
  type FakeSdkResponse
} from '../../src/agent/fake-provider.js'

interface Fixture {
  name: string
  response: FakeSdkResponse
  expected: 'accepted' | 'rejected'
}

class CountingSkillExecutor extends SkillExecutor {
  executeCalls = 0

  override execute(name: SkillName, args: unknown): Promise<SkillResult> {
    this.executeCalls += 1
    return super.execute(name, args)
  }
}

class ActuatingGoalManager extends GoalManager {
  submitCalls = 0

  constructor(private readonly executorForTest: CountingSkillExecutor) {
    super({ skillController: executorForTest })
  }

  override async submit(request: GoalRequest, source: GoalSource) {
    this.submitCalls += 1
    const record = await super.submit(request, source)
    if (record.status === 'running') {
      await this.executorForTest.execute(request.kind, request.args)
    }
    return record
  }
}

function readyState(): WorldStateSnapshot {
  return {
    connected: true,
    spawned: true,
    health: 20,
    food: 20,
    dimension: 'overworld',
    position: { x: 0, y: 64, z: 0 },
    nearbyPlayers: [],
    inventory: [],
    recentEvents: []
  }
}

async function fixtures(): Promise<Fixture[]> {
  return JSON.parse(
    await readFile('fixtures/provider/reasoning-isolation.json', 'utf8')
  ) as Fixture[]
}

function runtime() {
  const registry = new SkillRegistry()
  registry.register({
    name: 'gather_resource',
    async execute() {
      return { status: 'succeeded', code: 'test_gathered' }
    }
  })
  const executor = new CountingSkillExecutor(registry)
  const goals = new ActuatingGoalManager(executor)
  const events = new RuntimeEventBus()
  const emitted: unknown[] = []
  events.subscribe(event => emitted.push(structuredClone(event)))
  const gate = new DecisionGate({ safety: new SafetyPolicy(), events })
  return {
    executor,
    goals,
    emitted,
    pipeline: new DecisionPipeline(gate, goals)
  }
}

test('every mixed or raw-text reasoning fixture has zero GoalManager and SkillExecutor reachability', async () => {
  for (const fixture of await fixtures()) {
    if (fixture.expected !== 'rejected') continue
    const current = runtime()
    const providerResult = adaptFakeSdkResponse(fixture.response, 'fixture-provider')

    const result = await current.pipeline.handle(providerResult, readyState())

    assert.equal(result.kind, 'rejected', fixture.name)
    assert.equal(current.goals.submitCalls, 0, `${fixture.name}: GoalManager.submit reached`)
    assert.equal(current.executor.executeCalls, 0, `${fixture.name}: SkillExecutor.execute reached`)
  }
})

test('provider-separated reasoning is discarded before a valid structured decision reaches actuators', async () => {
  const fixture = (await fixtures()).find(item => item.expected === 'accepted')
  assert.ok(fixture)
  const current = runtime()
  const providerResult = adaptFakeSdkResponse(fixture.response, 'fixture-provider')
  const sentinel = 'PRIVATE_REASONING_SENTINEL_DO_NOT_LEAK'

  assert.equal(providerResult.kind, 'structured')
  assert.equal(JSON.stringify(providerResult).includes(sentinel), false)

  const result = await current.pipeline.handle(providerResult, readyState())

  assert.equal(result.kind, 'accepted')
  assert.equal(current.goals.submitCalls, 1)
  assert.equal(current.executor.executeCalls, 1)
  assert.equal(JSON.stringify(result).includes(sentinel), false)
  assert.equal(JSON.stringify(current.emitted).includes(sentinel), false)
})

test('ProviderResult never recovers JSON from raw text even when the text is pure JSON', async () => {
  const fixture = (await fixtures()).find(
    item => item.name === 'pure-json-returned-as-text-is-still-invalid'
  )
  assert.ok(fixture)

  assert.deepEqual(adaptFakeSdkResponse(fixture.response, 'fixture-provider'), {
    kind: 'invalid',
    provider: 'fixture-provider',
    code: 'unstructured_response'
  })
})
