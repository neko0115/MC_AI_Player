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

test('context builder keeps only bounded decision-relevant state', () => {
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
    maxSafetyConstraints: 2
  })

  const context = builder.build({
    worldKey: WORLD_KEY,
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
})
