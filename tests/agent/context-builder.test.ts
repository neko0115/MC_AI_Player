import assert from 'node:assert/strict'
import test from 'node:test'
import type { GoalRecord } from '../../src/contracts/goals.js'
import type { RuntimeEvent } from '../../src/contracts/events.js'
import type { MinecraftMemory } from '../../src/memory/repository.js'
import type { WorldStateSnapshot } from '../../src/state/world-state.js'
import { ContextBuilder } from '../../src/agent/context-builder.js'

const WORLD_KEY = 'test-server:survival-v1'

function memory(id: string, worldKey = WORLD_KEY, content = `memory-${id}`): MinecraftMemory {
  return {
    id,
    worldKey,
    type: 'resource',
    content,
    dimension: 'overworld',
    position: { x: Number(id.replace(/\D/g, '') || '0'), y: 64, z: 0 },
    tags: ['wood', 'oak', 'nearby'],
    importance: 0.7,
    observedAt: 100,
    createdAt: 100,
    updatedAt: 100,
    reinforcementCount: 0
  }
}

function state(recentEvents: RuntimeEvent[]): WorldStateSnapshot {
  return {
    connected: true,
    spawned: true,
    health: 17,
    food: 8,
    dimension: 'overworld',
    position: { x: 0, y: 64, z: 0 },
    nearbyPlayers: [
      { name: 'Far', position: { x: 20, y: 64, z: 0 } },
      { name: 'Boss', position: { x: 2, y: 64, z: 0 } },
      { name: 'Near', position: { x: 4, y: 64, z: 0 } }
    ],
    inventory: [
      { name: 'bread', count: 2 },
      { name: 'bread', count: 3 },
      { name: 'oak_log', count: 8 },
      { name: 'stick', count: 4 }
    ],
    recentEvents
  }
}

const activeGoal: GoalRecord = {
  goalId: 'goal-1',
  request: { kind: 'gather_resource', args: { resource: 'oak_log', quantity: 16 } },
  status: 'running',
  source: 'player',
  createdAt: 10,
  updatedAt: 20
}

test('context builder keeps bounded task objective and decision-relevant state', () => {
  const events: RuntimeEvent[] = [
    { type: 'connected', at: 1 },
    { type: 'player_chat', at: 2, player: 'Boss', message: 'bring wood' },
    { type: 'health_changed', at: 3, health: 17, food: 8 },
    { type: 'goal_failed', at: 4, goalId: 'old-goal', code: 'stuck' }
  ]
  const builder = new ContextBuilder({
    maxNearbyPlayers: 2,
    maxInventoryItems: 2,
    maxRecentEvents: 2,
    maxMemories: 2,
    maxMemoryContentChars: 80,
    maxSkills: 2,
    maxSafetyConstraints: 2,
    maxTaskObjectiveChars: 80,
    maxTaskDirectiveChars: 40
  })

  const context = builder.build({
    worldKey: WORLD_KEY,
    task: {
      taskId: 'task-1',
      objective: `採 16 個橡木，回家後放進基地箱子${'。'.repeat(100)}`,
      phase: 'active',
      consecutiveReplans: 1,
      previousAction: 'gather_resource',
      ephemeralDirective: `再確認背包和箱子${'！'.repeat(100)}`
    },
    state: state(events),
    currentGoal: activeGoal,
    memories: [
      memory('1'),
      memory('2', 'other-server:world'),
      memory('3', WORLD_KEY, 'x'.repeat(400)),
      memory('4')
    ],
    skills: [
      { name: 'gather_resource', description: 'Gather an exact bounded quantity.' },
      { name: 'go_to', description: 'Navigate without generic digging.' },
      { name: 'eat', description: 'Eat approved ordinary food.' }
    ],
    safetyConstraints: [
      'PvP is disabled.',
      'Generic pathfinding cannot dig.',
      'Emergency stop always preempts.'
    ]
  })

  assert.equal(context.worldKey, WORLD_KEY)
  assert.equal(context.task?.taskId, 'task-1')
  assert.equal(context.task?.objective.length, 80)
  assert.equal(context.task?.ephemeralDirective?.length, 40)
  assert.equal(context.task?.consecutiveReplans, 1)
  assert.deepEqual(context.self, {
    connected: true,
    spawned: true,
    health: 17,
    food: 8,
    dimension: 'overworld',
    position: { x: 0, y: 64, z: 0 }
  })
  assert.equal(context.currentGoal?.kind, 'gather_resource')
  assert.deepEqual(context.nearbyPlayers.map(player => player.name), ['Boss', 'Near'])
  assert.deepEqual(context.inventory, [
    { name: 'bread', count: 5 },
    { name: 'oak_log', count: 8 }
  ])
  assert.deepEqual(context.recentEvents.map(event => event.type), ['health_changed', 'goal_failed'])
  assert.equal(context.memories.length, 2)
  assert.equal(context.memories.every(item => item.worldKey === undefined), true)
  assert.equal(context.memories.some(item => item.id === '2'), false)
  assert.equal(context.memories.every(item => item.content.length <= 80), true)
  assert.equal(context.skills.length, 2)
  assert.equal(context.safetyConstraints.length, 2)
  assert.equal('rawChunkData' in context, false)
  assert.equal('fullEventHistory' in context, false)
})

test('context builder does not mutate source snapshots or leak foreign-world memories', () => {
  const snapshot = state([{ type: 'player_chat', at: 1, player: 'Boss', message: 'stay here' }])
  const original = structuredClone(snapshot)
  const builder = new ContextBuilder()

  const context = builder.build({
    worldKey: WORLD_KEY,
    state: snapshot,
    currentGoal: null,
    memories: [memory('1', 'foreign-world')],
    skills: [],
    safetyConstraints: []
  })

  assert.deepEqual(snapshot, original)
  assert.deepEqual(context.memories, [])
  assert.equal(context.task, undefined)
})


test('context builder exposes stable server capability semantics without leaking plugin identity', () => {
  const builder = new ContextBuilder()
  const context = builder.build({
    worldKey: WORLD_KEY,
    state: state([]),
    currentGoal: null,
    memories: [],
    skills: [{ name: 'gather_resource', description: 'Gather a bounded resource quantity.' }],
    serverCapabilities: [{
      id: 'vein_mining',
      name: '連鎖挖礦',
      description: '一次挖掘相連的礦物方塊',
      available: true,
      source: {
        plugin: 'VeinMiner',
        version: '2.11.2',
        provenance: 'integration'
      },
      usage: {
        trigger: 'sneak_and_break',
        human: '蹲下並使用正確的十字鎬挖掘相連礦物'
      },
      constraints: {
        max_chain: 100,
        correct_tool_required: true,
        must_sneak: true,
        nested_internal_detail: { should_not_leak: true }
      }
    }],
    safetyConstraints: []
  })

  assert.deepEqual(context.serverCapabilities, [{
    id: 'vein_mining',
    name: '連鎖挖礦',
    description: '一次挖掘相連的礦物方塊',
    trigger: 'sneak_and_break',
    usage: '蹲下並使用正確的十字鎬挖掘相連礦物',
    constraints: {
      max_chain: 100,
      correct_tool_required: true,
      must_sneak: true
    }
  }])
  assert.equal(JSON.stringify(context).includes('VeinMiner'), false)
  assert.equal(JSON.stringify(context).includes('2.11.2'), false)
})



test('context builder exposes bounded resource semantics and ranks task-relevant resources first', () => {
  const builder = new ContextBuilder({
    maxServerResources: 2
  })

  const context = builder.build({
    worldKey: WORLD_KEY,
    task: {
      taskId: 'task-resource-1',
      objective: '幫我找 examplemod:titanium_ore 並取得 raw titanium',
      phase: 'active',
      consecutiveReplans: 0,
      previousAction: null
    },
    state: state([]),
    currentGoal: null,
    memories: [],
    skills: [],
    serverResources: [
      {
        id: 'examplemod:copper_ore',
        kind: 'ore',
        aliases: [],
        blockIds: ['examplemod:copper_ore'],
        collectedItemIds: ['examplemod:raw_copper'],
        minimumDropCount: 1,
        toolKind: 'pickaxe',
        capabilityId: 'vein_mining',
        relatedLeaves: [],
        cleanupPolicy: null,
        confidence: 'authoritative'
      },
      {
        id: 'examplemod:titanium_ore',
        kind: 'ore',
        aliases: ['examplemod:titanium'],
        blockIds: ['examplemod:titanium_ore'],
        collectedItemIds: ['examplemod:raw_titanium'],
        minimumDropCount: 1,
        toolKind: 'pickaxe',
        capabilityId: 'vein_mining',
        relatedLeaves: [],
        cleanupPolicy: null,
        confidence: 'authoritative'
      },
      {
        id: 'examplemod:rubber_log',
        kind: 'log',
        aliases: [],
        blockIds: ['examplemod:rubber_log'],
        collectedItemIds: ['examplemod:rubber_log'],
        minimumDropCount: 1,
        toolKind: 'axe',
        capabilityId: 'tree_felling',
        relatedLeaves: ['examplemod:rubber_leaves'],
        cleanupPolicy: 'natural_decay',
        confidence: 'inferred'
      }
    ],
    safetyConstraints: []
  })

  assert.equal(context.serverResources?.length, 2)
  assert.equal(context.serverResources?.[0]?.id, 'examplemod:titanium_ore')
  assert.deepEqual(context.serverResources?.[0]?.drops, ['examplemod:raw_titanium'])
  assert.equal(context.serverResources?.[0]?.toolKind, 'pickaxe')
  assert.equal(context.serverResources?.[1]?.id, 'examplemod:copper_ore')
})
