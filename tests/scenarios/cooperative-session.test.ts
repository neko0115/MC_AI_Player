import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ContextBuilder } from '../../src/agent/context-builder.js'
import { DecisionGate } from '../../src/agent/decision-gate.js'
import { FakeDecisionProvider } from '../../src/agent/fake-provider.js'
import type { Position, RuntimeEvent } from '../../src/contracts/events.js'
import type { SkillResult } from '../../src/contracts/skills.js'
import { GoalManager } from '../../src/goals/goal-manager.js'
import { SqliteMemoryRepository } from '../../src/memory/sqlite-repository.js'
import type {
  MinecraftAdapter,
  MinecraftEventListener,
  NavigationOptions
} from '../../src/minecraft/adapter.js'
import type {
  ResourceCandidate,
  ResourceGatheringAdapter,
  ResourceSearchRequest
} from '../../src/minecraft/gathering.js'
import { wireGoalExecution } from '../../src/runtime/goal-execution-loop.js'
import {
  SafetyPolicy,
  isResourceMutationPermit,
  type ResourceMutationPermit
} from '../../src/safety/policy.js'
import { GatherResourceSkill, RegionProtectionPolicy } from '../../src/skills/gathering.js'
import { createNavigationSkills } from '../../src/skills/navigation.js'
import { SkillExecutor } from '../../src/skills/executor.js'
import { SkillRegistry } from '../../src/skills/registry.js'
import { WorldStateCache } from '../../src/state/world-state-cache.js'
import { RuntimeEventBus } from '../../src/telemetry/event-bus.js'
import { JsonlEventRecorder } from '../../src/telemetry/recorder.js'
import { ReplayReader } from '../../src/telemetry/replay.js'

const WORLD_KEY = 'acceptance-server:survival-v1'
const BASE: Position = { x: 0, y: 64, z: 0 }
const REASONING_SENTINEL = 'PRIVATE_REASONING_SENTINEL'

class CooperativeWorld implements MinecraftAdapter, ResourceGatheringAdapter {
  private readonly listeners = new Set<MinecraftEventListener>()
  private readonly blocks = new Map<string, ResourceCandidate>()
  private readonly inventory = new Map<string, number>()
  readonly harvested: ResourceCandidate[] = []
  readonly navigationTargets: Position[] = []
  readonly followTargets: string[] = []
  readonly handoffs: Array<{ player: string; item: string; quantity: number }> = []
  pvpAttempts = 0
  position: Position = { ...BASE }

  constructor(
    blocks: readonly ResourceCandidate[],
    private readonly events: RuntimeEventBus
  ) {
    for (const block of blocks) {
      this.blocks.set(positionKey(block.position), cloneCandidate(block))
    }
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  onEvent(listener: MinecraftEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async goTo(
    position: Position,
    options: NavigationOptions,
    signal: AbortSignal
  ): Promise<SkillResult> {
    if (signal.aborted) return cancelled(signal)
    assert.equal(options.canDig, false)
    this.navigationTargets.push({ ...position })
    this.position = { ...position }
    return { status: 'succeeded', code: 'reached' }
  }

  async followPlayer(
    player: string,
    _range: number,
    signal: AbortSignal
  ): Promise<SkillResult> {
    if (signal.aborted) return cancelled(signal)
    this.followTargets.push(player)
    return { status: 'succeeded', code: 'following' }
  }

  async holdPosition(signal: AbortSignal): Promise<SkillResult> {
    return signal.aborted
      ? cancelled(signal)
      : { status: 'succeeded', code: 'holding' }
  }

  async stopMotion(): Promise<void> {}

  currentPosition(): Position | null {
    return { ...this.position }
  }

  inventoryCount(itemName: string): number {
    return this.inventory.get(itemName) ?? 0
  }

  async findResourceBlocks(
    request: ResourceSearchRequest,
    signal: AbortSignal
  ): Promise<readonly ResourceCandidate[]> {
    if (signal.aborted) return []
    return [...this.blocks.values()]
      .filter(candidate => request.blockNames.includes(candidate.blockName))
      .filter(candidate => distance(candidate.position, request.origin) <= request.radius)
      .sort((a, b) => distance(a.position, request.origin) - distance(b.position, request.origin))
      .slice(0, request.limit)
      .map(cloneCandidate)
  }

  async harvestResourceBlock(
    target: ResourceCandidate,
    permit: ResourceMutationPermit,
    signal: AbortSignal
  ): Promise<SkillResult> {
    if (signal.aborted) return cancelled(signal)
    if (!isResourceMutationPermit(permit)) {
      return { status: 'failed', code: 'mutation_not_permitted' }
    }
    if (!permit.allowedBlockNames.includes(target.blockName)) {
      return { status: 'failed', code: 'mutation_not_permitted' }
    }

    const key = positionKey(target.position)
    const existing = this.blocks.get(key)
    if (!existing || existing.blockName !== target.blockName) {
      return { status: 'failed', code: 'resource_changed' }
    }

    this.blocks.delete(key)
    this.harvested.push(cloneCandidate(target))
    this.inventory.set(target.blockName, this.inventoryCount(target.blockName) + 1)
    await this.publishInventory()
    return { status: 'succeeded', code: 'collected' }
  }

  async handoffSurrogate(player: string, item: string, quantity: number): Promise<boolean> {
    if (player !== 'Boss' || !Number.isInteger(quantity) || quantity < 1) return false
    const available = this.inventoryCount(item)
    if (available < quantity) return false
    this.inventory.set(item, available - quantity)
    this.handoffs.push({ player, item, quantity })
    await this.publishInventory()
    return true
  }

  private async publishInventory(): Promise<void> {
    const items = [...this.inventory.entries()]
      .filter(([, count]) => count > 0)
      .map(([name, count]) => ({ name, count }))
    await this.events.publish({
      type: 'inventory_changed',
      at: 2_000 + this.harvested.length + this.handoffs.length,
      items
    })
  }
}

test('replay-backed cooperative session completes gather, return, handoff, memory, and resume-follow without reasoning leakage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mc-ai-player-coop-'))
  const memoryPath = join(directory, 'mc_memory.sqlite3')
  const eventLogPath = join(directory, 'runtime-events.jsonl')
  const events = new RuntimeEventBus()
  const state = new WorldStateCache({ maxRecentEvents: 64 })
  const observed: RuntimeEvent[] = []
  let recordedCount = 0
  const recorder = new JsonlEventRecorder(eventLogPath, {
    maxFileBytes: 1024 * 1024,
    logger: { error() {} }
  })
  const memory = new SqliteMemoryRepository(memoryPath, { now: () => 5_000 })
  const safety = new SafetyPolicy()
  const world = new CooperativeWorld(resourceBlocks(16), events)

  events.subscribe(event => state.apply(event))
  events.subscribe(async event => {
    observed.push(structuredClone(event))
    const result = await recorder.record(event)
    assert.equal(result.ok, true)
    recordedCount += 1
  })

  const registry = new SkillRegistry()
  const navigation = createNavigationSkills(world)
  registry.register(navigation.followPlayer)
  registry.register(navigation.goTo)
  registry.register(navigation.stay)
  registry.register(new GatherResourceSkill({
    resources: world,
    navigation: world,
    safety,
    state: () => state.snapshot(),
    protection: new RegionProtectionPolicy([]),
    options: {
      initialSearchRadius: 8,
      maxSearchRadius: 32,
      searchStep: 8,
      maxRetries: 3,
      maxCandidatesPerSearch: 32
    }
  }))

  const executor = new SkillExecutor(registry, { events })
  let goalSequence = 0
  const goals = new GoalManager({
    skillController: executor,
    events,
    nextGoalId: () => `goal-${++goalSequence}`,
    now: () => 4_000 + goalSequence
  })
  const binding = wireGoalExecution({ events, goals, executor })
  const gate = new DecisionGate({ safety, events, now: () => 3_000 })
  const provider = new FakeDecisionProvider([
    {
      kind: 'structured',
      mode: 'function_call',
      reasoning: REASONING_SENTINEL,
      value: {
        version: 2,
        outcome: 'action',
        action: {
          intent: 'gather_resource',
          args: { resource: 'oak_log', quantity: 16 }
        }
      }
    },
    {
      kind: 'raw_text',
      text: `${REASONING_SENTINEL} {"version":1,"intent":"stay","args":{}}`
    }
  ])

  try {
    const replay = await ReplayReader.readAll('fixtures/replay/cooperative-session.jsonl')
    for (const event of replay) await events.publish(event)

    assert.equal(state.snapshot().nearbyPlayers[0]?.name, 'Boss')
    assert.equal(
      state.snapshot().recentEvents.some(event =>
        event.type === 'player_chat' && event.message.includes('16')
      ),
      true
    )

    const firstFollow = await goals.submit({
      kind: 'follow_player',
      args: { player: 'Boss', range: 3 }
    }, 'player')
    assert.equal(firstFollow.goalId, 'goal-1')
    await waitForGoal(goals, 'goal-1', 'succeeded')

    const context = new ContextBuilder().build({
      worldKey: WORLD_KEY,
      state: state.snapshot(),
      currentGoal: goals.activeGoal(),
      memories: memory.search({ worldKey: WORLD_KEY, limit: 8 }),
      skills: [
        { name: 'follow_player', description: 'Follow the named player safely.' },
        { name: 'gather_resource', description: 'Gather an exact bounded resource quantity.' },
        { name: 'go_to', description: 'Navigate to a bounded coordinate without digging.' }
      ],
      safetyConstraints: [
        'PvP is disabled.',
        'Generic navigation cannot dig.',
        'Only gather_resource may receive a scoped block-mutation permit.'
      ]
    })
    const providerResult = await provider.decide({ context })
    assert.equal(JSON.stringify(providerResult).includes(REASONING_SENTINEL), false)

    const accepted = await gate.accept(
      providerResult,
      state.snapshot(),
      name => registry.has(name)
    )
    assert.equal(accepted.kind, 'action')
    assert.equal(accepted.kind === 'action' ? accepted.goal.kind : null, 'gather_resource')
    if (accepted.kind === 'action') {
      await goals.submit(accepted.goal, 'ai')
    }
    await waitForGoal(goals, 'goal-2', 'succeeded')
    assert.equal(world.inventoryCount('oak_log'), 16)
    assert.equal(world.harvested.length, 16)
    assert.equal(world.harvested.every(candidate => candidate.blockName === 'oak_log'), true)

    const invalidResult = await provider.decide({ context })
    const rejected = await gate.accept(
      invalidResult,
      state.snapshot(),
      name => registry.has(name)
    )
    assert.equal(rejected.kind, 'rejected')

    const returnGoal = await goals.submit({
      kind: 'go_to',
      args: { ...BASE, radius: 1 }
    }, 'player')
    assert.equal(returnGoal.goalId, 'goal-3')
    await waitForGoal(goals, 'goal-3', 'succeeded')
    assert.deepEqual(world.position, BASE)

    assert.equal(await world.handoffSurrogate('Boss', 'oak_log', 16), true)
    assert.equal(world.inventoryCount('oak_log'), 0)
    assert.deepEqual(world.handoffs, [{ player: 'Boss', item: 'oak_log', quantity: 16 }])

    const written = [
      memory.remember({
        worldKey: WORLD_KEY,
        type: 'landmark',
        content: 'Boss base and handoff point',
        dimension: 'overworld',
        position: BASE,
        tags: ['home', 'boss'],
        importance: 1,
        observedAt: 3_100
      }),
      memory.remember({
        worldKey: WORLD_KEY,
        type: 'resource',
        content: 'Oak resource area used for the cooperative gather task',
        dimension: 'overworld',
        position: { x: 8, y: 64, z: 4 },
        tags: ['oak_log', 'forest'],
        importance: 0.8,
        observedAt: 3_200
      }),
      memory.remember({
        worldKey: WORLD_KEY,
        type: 'task_history',
        content: 'Gathered and handed off 16 oak_log to Boss successfully',
        dimension: 'overworld',
        tags: ['gather_resource', 'boss', 'success'],
        importance: 0.9,
        observedAt: 3_300
      })
    ]
    for (const item of written) {
      await events.publish({ type: 'memory_written', at: 3_400, memoryId: item.id })
    }

    const finalFollow = await goals.submit({
      kind: 'follow_player',
      args: { player: 'Boss', range: 3 }
    }, 'player')
    assert.equal(finalFollow.goalId, 'goal-4')
    await waitForGoal(goals, 'goal-4', 'succeeded')

    const memories = memory.search({ worldKey: WORLD_KEY, limit: 10 })
    assert.deepEqual(
      new Set(memories.map(item => item.type)),
      new Set(['landmark', 'resource', 'task_history'])
    )
    assert.deepEqual(world.followTargets, ['Boss', 'Boss'])
    assert.equal(world.pvpAttempts, 0)
    assert.equal(observed.some(event => event.type === 'goal_failed'), false)
    assert.equal(observed.some(event => event.type === 'skill_failed'), false)
    assert.equal(observed.some(event => event.type === 'stuck'), false)
    assert.equal(observed.some(event => event.type === 'emergency_stop'), false)
    assert.equal(observed.filter(event => event.type === 'decision_accepted').length, 1)
    assert.equal(observed.filter(event => event.type === 'decision_rejected').length, 1)
    assert.equal(observed.filter(event => event.type === 'memory_written').length, 3)

    await waitFor(() => recordedCount === observed.length)
    const telemetry = await readFile(eventLogPath, 'utf8')
    assert.equal(telemetry.includes(REASONING_SENTINEL), false)
    assert.equal(telemetry.includes('"reasoning"'), false)
    assert.equal(telemetry.includes('"thought"'), false)
    assert.equal(telemetry.includes('"analysis"'), false)
  } finally {
    binding.dispose()
    memory.close()
    await rm(directory, { recursive: true, force: true })
  }
})

function resourceBlocks(count: number): ResourceCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    blockName: 'oak_log',
    position: { x: 4 + index, y: 64, z: 4 }
  }))
}

function cloneCandidate(candidate: ResourceCandidate): ResourceCandidate {
  return {
    blockName: candidate.blockName,
    position: { ...candidate.position }
  }
}

function positionKey(position: Position): string {
  return `${position.x},${position.y},${position.z}`
}

function distance(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function cancelled(signal: AbortSignal): SkillResult {
  const reason = typeof signal.reason === 'string' ? signal.reason.trim() : ''
  return {
    status: 'cancelled',
    code: reason ? reason.replace(/\s+/g, '_').slice(0, 128) : 'cancelled'
  }
}

async function waitForGoal(
  goals: GoalManager,
  goalId: string,
  status: 'succeeded' | 'failed' | 'cancelled'
): Promise<void> {
  await waitFor(() => goals.getGoal(goalId)?.status === status)
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition did not become true')
}
