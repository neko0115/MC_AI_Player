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
import { DecisionGate, type GatedOutcome } from '../../src/agent/decision-gate.js'
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
  events.subscribe(event => {
    emitted.push(structuredClone(event))
  })
  const gate = new DecisionGate({ safety: new SafetyPolicy(), events })
  return { executor, goals, emitted, gate, registry }
}

async function applyGatedAction(
  current: ReturnType<typeof runtime>,
  outcome: GatedOutcome
): Promise<void> {
  if (outcome.kind === 'action') {
    await current.goals.submit(outcome.goal, 'ai')
  }
}

function routedContext() {
  return {
    worldKey: 'reasoning-isolation',
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
    skills: [{ name: 'stay' as const, description: 'Hold position.' }],
    safetyConstraints: []
  }
}

function routedLease() {
  return {
    attemptId: 'attempt-safe-error',
    decisionId: 'decision-safe-error',
    configGeneration: 1,
    projectKey: 'pool-a',
    projectLabel: 'primary',
    credentialHandle: 'cred-a',
    model: 'gemini-3.5-flash-lite',
    thinking: 'low' as const,
    budgetClass: 'normal' as const,
    reservationId: 'attempt-safe-error'
  }
}

async function executeRoutedGemini(
  outcome: { error: unknown } | { response: unknown },
  signal = new AbortController().signal
) {
  const { GeminiTransport } = await import('../../src/agent/providers/gemini.js')
  const transport = new GeminiTransport({
    resolveCredential: () => 'TEST_KEY_DO_NOT_LEAK',
    createClient: () => ({
      async create() {
        if ('error' in outcome) throw outcome.error
        return outcome.response as never
      }
    })
  })
  return transport.execute(transport.prepare(routedContext()), routedLease(), signal)
}

test('every mixed or raw-text reasoning fixture has zero GoalManager and SkillExecutor reachability', async () => {
  for (const fixture of await fixtures()) {
    if (fixture.expected !== 'rejected') continue
    const current = runtime()
    const providerResult = adaptFakeSdkResponse(fixture.response, 'fixture-provider')

    const result = await current.gate.accept(
      providerResult,
      readyState(),
      name => current.registry.has(name)
    )
    await applyGatedAction(current, result)

    assert.equal(result.kind, 'rejected', fixture.name)
    assert.equal(current.goals.submitCalls, 0, `${fixture.name}: GoalManager.submit reached`)
    assert.equal(current.executor.executeCalls, 0, `${fixture.name}: SkillExecutor.execute reached`)
  }
})

test('provider-separated reasoning is discarded before a valid structured action reaches actuators', async () => {
  const fixture = (await fixtures()).find(item => item.expected === 'accepted')
  assert.ok(fixture)
  const current = runtime()
  const providerResult = adaptFakeSdkResponse(fixture.response, 'fixture-provider')
  const sentinel = 'PRIVATE_REASONING_SENTINEL_DO_NOT_LEAK'

  assert.equal(providerResult.kind, 'structured')
  assert.equal(JSON.stringify(providerResult).includes(sentinel), false)

  const result = await current.gate.accept(
    providerResult,
    readyState(),
    name => current.registry.has(name)
  )
  await applyGatedAction(current, result)

  assert.equal(result.kind, 'action')
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

test('routed Gemini transport turns connection failures into safe facts without leaking raw error text', async () => {
  const raw = new Error('PRIVATE_NETWORK_SENTINEL_DO_NOT_LEAK')
  raw.name = 'APIConnectionError'

  const result = await executeRoutedGemini({ error: raw })

  assert.deepEqual(result, { kind: 'network_error' })
  assert.equal(JSON.stringify(result).includes('PRIVATE_NETWORK_SENTINEL_DO_NOT_LEAK'), false)
})

test('routed Gemini transport normalizes timeout and local cancellation without leaking details', async () => {
  const timeout = new Error('PRIVATE_TIMEOUT_SENTINEL_DO_NOT_LEAK')
  timeout.name = 'APIConnectionTimeoutError'
  assert.deepEqual(await executeRoutedGemini({ error: timeout }), { kind: 'timeout' })

  const cancelled = new Error('PRIVATE_CANCEL_SENTINEL_DO_NOT_LEAK')
  cancelled.name = 'APIUserAbortError'
  assert.deepEqual(await executeRoutedGemini({ error: cancelled }), { kind: 'cancelled' })
})

test('routed Gemini transport exposes only bounded provider API facts and Retry-After', async () => {
  const rateLimited = Object.assign(new Error('PRIVATE_RATE_LIMIT_SENTINEL_DO_NOT_LEAK'), {
    name: 'RateLimitError',
    status: 429,
    statusCode: 429,
    error: { code: 'rate_limit_exceeded' },
    headers: new Headers({ 'retry-after': '2' })
  })
  assert.deepEqual(await executeRoutedGemini({ error: rateLimited }), {
    kind: 'api_error',
    httpStatus: 429,
    providerCode: 'rate_limit_exceeded',
    retryAfterMs: 2000
  })

  const blocked = Object.assign(new Error('PRIVATE_BLOCK_SENTINEL_DO_NOT_LEAK'), {
    name: 'BadRequestError',
    status: 400,
    statusCode: 400,
    error: { code: 'content_blocked' },
    headers: new Headers()
  })
  assert.deepEqual(await executeRoutedGemini({ error: blocked }), {
    kind: 'content_blocked',
    code: 'content_blocked'
  })
})

test('routed Gemini transport reports malformed final output as generation_error with safe usage', async () => {
  const result = await executeRoutedGemini({
    response: {
      status: 'requires_action',
      steps: [{ type: 'thought', summary: [{ type: 'text', text: 'PRIVATE_THOUGHT_SENTINEL' }] }],
      usage: {
        total_input_tokens: 11,
        total_output_tokens: 1,
        total_thought_tokens: 4,
        total_tool_use_tokens: 0,
        total_tokens: 16
      }
    }
  })

  assert.deepEqual(result, {
    kind: 'generation_error',
    code: 'function_call_missing',
    usage: {
      inputTokens: 11,
      outputTokens: 1,
      thoughtTokens: 4,
      toolTokens: 0,
      totalTokens: 16
    }
  })
  assert.equal(JSON.stringify(result).includes('PRIVATE_THOUGHT_SENTINEL'), false)
  assert.equal(JSON.stringify(result).includes('TEST_KEY_DO_NOT_LEAK'), false)
})
