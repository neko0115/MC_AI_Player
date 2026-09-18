import assert from 'node:assert/strict'
import test from 'node:test'
import type { GoalRecord, GoalRequest, GoalSource } from '../../src/contracts/goals.js'
import type { RuntimeEvent } from '../../src/contracts/events.js'
import type { MemorySearchQuery, MinecraftMemory, MinecraftMemoryRepository } from '../../src/memory/repository.js'
import type { WorldStateSnapshot } from '../../src/state/world-state.js'
import {
  ControlServer,
  type ControlGoalPort,
  type RuntimeEventSource
} from '../../src/api/control-server.js'

class FakeGoals implements ControlGoalPort {
  readonly submissions: Array<{ request: GoalRequest; source: GoalSource }> = []
  readonly stopReasons: string[] = []
  active: GoalRecord | null = null
  queued: GoalRecord[] = []

  async submit(request: GoalRequest, source: GoalSource): Promise<GoalRecord> {
    this.submissions.push({ request: structuredClone(request), source })
    const record: GoalRecord = {
      goalId: `goal-${this.submissions.length}`,
      request: structuredClone(request),
      status: 'running',
      source,
      createdAt: 1,
      updatedAt: 1
    }
    this.active = record
    return structuredClone(record)
  }

  activeGoal(): GoalRecord | null {
    return this.active ? structuredClone(this.active) : null
  }

  queuedGoals(): readonly GoalRecord[] {
    return this.queued.map(record => structuredClone(record))
  }

  async emergencyStop(reason: string): Promise<void> {
    this.stopReasons.push(reason)
    this.active = null
    this.queued = []
  }
}

class FakeMemory implements Pick<MinecraftMemoryRepository, 'search'> {
  readonly queries: MemorySearchQuery[] = []
  results: MinecraftMemory[] = []

  search(query: MemorySearchQuery): MinecraftMemory[] {
    this.queries.push(structuredClone(query))
    return this.results.map(memory => structuredClone(memory))
  }
}

class FakeEvents implements RuntimeEventSource {
  private readonly listeners = new Set<(event: RuntimeEvent) => void | Promise<void>>()

  subscribe(listener: (event: RuntimeEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  listenerCount(): number {
    return this.listeners.size
  }

  async emit(event: unknown): Promise<void> {
    for (const listener of [...this.listeners]) {
      await listener(event as RuntimeEvent)
    }
  }
}

function state(): WorldStateSnapshot {
  return {
    connected: true,
    spawned: true,
    health: 20,
    food: 18,
    dimension: 'overworld',
    position: { x: 1, y: 64, z: 2 },
    nearbyPlayers: [{ name: 'Boss', position: { x: 2, y: 64, z: 2 } }],
    inventory: [{ name: 'bread', count: 3 }],
    recentEvents: []
  }
}

function dependencies(overrides: Partial<ConstructorParameters<typeof ControlServer>[0]> = {}) {
  const goals = new FakeGoals()
  const memory = new FakeMemory()
  const events = new FakeEvents()
  const options: ConstructorParameters<typeof ControlServer>[0] = {
    host: '127.0.0.1',
    port: 0,
    goals,
    state: { snapshot: () => state() },
    memory,
    events,
    ...overrides
  }
  return { server: new ControlServer(options), goals, memory, events }
}

async function started(overrides: Partial<ConstructorParameters<typeof ControlServer>[0]> = {}) {
  const current = dependencies(overrides)
  const address = await current.server.start()
  return { ...current, address }
}

async function json(response: Response): Promise<unknown> {
  return response.json()
}

test('loopback starts without a token and exposes bounded health/status', async () => {
  const current = await started()
  try {
    const health = await fetch(`${current.address.baseUrl}/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await json(health), { ok: true })

    const status = await fetch(`${current.address.baseUrl}/v1/status`)
    assert.equal(status.status, 200)
    const body = await json(status) as {
      minecraft?: unknown
      active_goal?: unknown
      queued_goals?: unknown[]
    }
    assert.deepEqual(body.minecraft, {
      connected: true,
      spawned: true,
      health: 20,
      food: 18,
      dimension: 'overworld',
      position: { x: 1, y: 64, z: 2 },
      nearby_players: [{ name: 'Boss', position: { x: 2, y: 64, z: 2 } }],
      inventory: [{ name: 'bread', count: 3 }]
    })
    assert.equal(body.active_goal, null)
    assert.deepEqual(body.queued_goals, [])
  } finally {
    await current.server.close()
  }
})


test('status exposes only sanitized capability sync state and semantic details', async () => {
  const current = await started({
    capabilityStatus: {
      snapshot: () => ({
        state: 'current',
        ids: ['vein_mining', 'tree_felling', 'vein_mining'],
        details: [
          {
            id: 'vein_mining',
            trigger: 'sneak_and_break',
            constraints: {
              max_chain: 100,
              correct_tool_required: true,
              must_sneak: true,
              same_block_only: false,
              internal_plugin_path: '/secret/path',
              nested: { should_not_leak: true }
            }
          },
          {
            id: 'tree_felling',
            trigger: 'break',
            constraints: {
              max_chain: 4,
              tool_kind: 'axe'
            }
          }
        ]
      })
    }
  })
  try {
    const response = await fetch(`${current.address.baseUrl}/v1/status`)
    assert.equal(response.status, 200)
    const body = await json(response) as {
      server_capabilities?: {
        sync_state?: string
        ids?: string[]
        details?: unknown[]
      }
    }
    assert.deepEqual(body.server_capabilities, {
      sync_state: 'current',
      ids: ['tree_felling', 'vein_mining'],
      details: [
        {
          id: 'tree_felling',
          trigger: 'break',
          constraints: {
            max_chain: 4,
            tool_kind: 'axe'
          }
        },
        {
          id: 'vein_mining',
          trigger: 'sneak_and_break',
          constraints: {
            correct_tool_required: true,
            max_chain: 100,
            must_sneak: true,
            same_block_only: false
          }
        }
      ]
    })
  } finally {
    await current.server.close()
  }
})

test('non-loopback bind requires a bearer token and rejects invalid authorization', async () => {
  const missing = dependencies({ host: '0.0.0.0' })
  await assert.rejects(() => missing.server.start(), /bearer token/i)

  const current = await started({ host: '0.0.0.0', bearerToken: 'correct-horse-battery-staple' })
  try {
    const without = await fetch(`${current.address.baseUrl}/health`)
    assert.equal(without.status, 401)

    const wrong = await fetch(`${current.address.baseUrl}/health`, {
      headers: { authorization: 'Bearer wrong' }
    })
    assert.equal(wrong.status, 401)

    const valid = await fetch(`${current.address.baseUrl}/health`, {
      headers: { authorization: 'Bearer correct-horse-battery-staple' }
    })
    assert.equal(valid.status, 200)
  } finally {
    await current.server.close()
  }
})

test('POST /v1/goals validates strict GoalRequest and returns immediately with goal_id', async () => {
  const current = await started({ maxBodyBytes: 512 })
  try {
    const invalid = await fetch(`${current.address.baseUrl}/v1/goals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'stay', args: {}, raw_command: '/kill @e' })
    })
    assert.equal(invalid.status, 400)
    assert.equal(current.goals.submissions.length, 0)

    const valid = await fetch(`${current.address.baseUrl}/v1/goals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'gather_resource',
        args: { resource: 'oak_log', quantity: 16 }
      })
    })
    assert.equal(valid.status, 202)
    assert.deepEqual(await json(valid), { accepted: true, goal_id: 'goal-1' })
    assert.deepEqual(current.goals.submissions, [{
      request: { kind: 'gather_resource', args: { resource: 'oak_log', quantity: 16 } },
      source: 'player'
    }])

    const oversized = await fetch(`${current.address.baseUrl}/v1/goals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'stay', args: {}, padding: 'x'.repeat(800) })
    })
    assert.equal(oversized.status, 413)
    assert.equal(current.goals.submissions.length, 1)
  } finally {
    await current.server.close()
  }
})

test('POST /v1/stop invokes emergency stop without echoing arbitrary details', async () => {
  const current = await started()
  try {
    const response = await fetch(`${current.address.baseUrl}/v1/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'operator requested stop' })
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await json(response), { stopped: true })
    assert.deepEqual(current.goals.stopReasons, ['operator requested stop'])
  } finally {
    await current.server.close()
  }
})

test('GET /v1/memory/search requires world scope and maps bounded query parameters', async () => {
  const current = await started()
  current.memory.results = [{
    id: 'm-1',
    worldKey: 'srv-a',
    type: 'storage',
    content: 'Main chest',
    dimension: 'overworld',
    position: { x: 3, y: 64, z: 4 },
    tags: ['base'],
    importance: 0.9,
    observedAt: 10,
    createdAt: 10,
    updatedAt: 10,
    reinforcementCount: 0
  }]
  try {
    const missingScope = await fetch(`${current.address.baseUrl}/v1/memory/search?text=chest`)
    assert.equal(missingScope.status, 400)
    assert.equal(current.memory.queries.length, 0)

    const response = await fetch(
      `${current.address.baseUrl}/v1/memory/search?world_key=srv-a&text=chest&types=storage,landmark&dimension=overworld&tags=base,food&x=0&y=64&z=0&radius=20&limit=5`
    )
    assert.equal(response.status, 200)
    assert.deepEqual(current.memory.queries, [{
      worldKey: 'srv-a',
      text: 'chest',
      types: ['storage', 'landmark'],
      dimension: 'overworld',
      tags: ['base', 'food'],
      near: { position: { x: 0, y: 64, z: 0 }, radius: 20 },
      limit: 5
    }])
    assert.deepEqual(await json(response), { memories: current.memory.results })
  } finally {
    await current.server.close()
  }
})

test('SSE emits only validated RuntimeEvents and client disconnect unsubscribes without touching gameplay', async () => {
  const current = await started()
  try {
    const response = await fetch(`${current.address.baseUrl}/v1/events`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
    assert.ok(response.body)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    const first = await readChunk(reader, decoder)
    assert.equal(first.includes(': connected'), true)
    assert.equal(current.events.listenerCount(), 1)

    await current.events.emit({
      type: 'decision_rejected',
      at: 1,
      code: 'invalid',
      reasoning: 'PRIVATE_REASONING_SENTINEL'
    })
    await current.events.emit({ type: 'connected', at: 2 })

    const eventChunk = await readUntil(reader, decoder, '"type":"connected"')
    assert.equal(eventChunk.includes('PRIVATE_REASONING_SENTINEL'), false)
    assert.equal(eventChunk.includes('data: {"type":"connected","at":2}'), true)

    await reader.cancel()
    await waitFor(() => current.events.listenerCount() === 0)
    assert.equal(current.goals.stopReasons.length, 0)
  } finally {
    await current.server.close()
  }
})

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder
): Promise<string> {
  const result = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSE read timeout')), 2_000))
  ])
  assert.equal(result.done, false)
  return decoder.decode(result.value, { stream: true })
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  needle: string
): Promise<string> {
  let text = ''
  for (let index = 0; index < 8; index += 1) {
    text += await readChunk(reader, decoder)
    if (text.includes(needle)) return text
  }
  throw new Error(`SSE payload did not contain ${needle}`)
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition did not become true')
}
