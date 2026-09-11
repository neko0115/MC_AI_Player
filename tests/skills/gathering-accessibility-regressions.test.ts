import assert from 'node:assert/strict'
import test from 'node:test'
import type { Position } from '../../src/contracts/events.js'
import type { SkillResult } from '../../src/contracts/skills.js'
import type { WorldStateSnapshot } from '../../src/state/world-state.js'
import type {
  ResourceCandidate,
  ResourceGatheringAdapter,
  ResourceNavigationAdapter,
  ResourceSearchRequest
} from '../../src/minecraft/gathering.js'
import {
  GatherResourceSkill,
  RegionProtectionPolicy
} from '../../src/skills/gathering.js'
import {
  SafetyPolicy,
  isResourceMutationPermit,
  type ResourceMutationPermit
} from '../../src/safety/policy.js'

class AccessibilityWorld implements ResourceGatheringAdapter, ResourceNavigationAdapter {
  readonly inventory = new Map<string, number>()
  readonly blocks = new Map<string, ResourceCandidate>()
  readonly navigationAttempts: Position[] = []
  readonly unreachableX = new Set<number>()
  position: Position = { x: 0, y: 64, z: 0 }

  constructor(blocks: readonly ResourceCandidate[]) {
    for (const block of blocks) this.blocks.set(key(block.position), block)
  }

  currentPosition(): Position | null {
    return { ...this.position }
  }

  inventoryCount(item: string): number {
    return this.inventory.get(item) ?? 0
  }

  async findResourceBlocks(request: ResourceSearchRequest, signal: AbortSignal) {
    if (signal.aborted) return []
    return [...this.blocks.values()]
      .filter(block => request.blockNames.includes(block.blockName))
      .filter(block => distance(block.position, request.origin) <= request.radius)
      .slice(0, request.limit)
      .map(block => ({ blockName: block.blockName, position: { ...block.position } }))
  }

  async harvestResourceBlock(
    target: ResourceCandidate,
    permit: ResourceMutationPermit,
    signal: AbortSignal
  ): Promise<SkillResult> {
    if (signal.aborted) return { status: 'cancelled', code: 'cancelled' }
    if (!isResourceMutationPermit(permit) || !permit.allowedBlockNames.includes(target.blockName)) {
      return { status: 'failed', code: 'mutation_not_permitted' }
    }
    const stored = this.blocks.get(key(target.position))
    if (!stored) return { status: 'failed', code: 'resource_missing' }
    this.blocks.delete(key(target.position))
    this.inventory.set(target.blockName, this.inventoryCount(target.blockName) + 1)
    return { status: 'succeeded', code: 'collected' }
  }

  async goTo(
    position: Position,
    options: { readonly range: number; readonly canDig: false },
    signal: AbortSignal
  ): Promise<SkillResult> {
    if (signal.aborted) return { status: 'cancelled', code: 'cancelled' }
    assert.equal(options.canDig, false)
    this.navigationAttempts.push({ ...position })
    if (this.unreachableX.has(position.x)) {
      return { status: 'failed', code: 'no_path' }
    }
    this.position = { ...position }
    return { status: 'succeeded', code: 'reached' }
  }
}

function state(world: AccessibilityWorld): WorldStateSnapshot {
  return {
    connected: true,
    spawned: true,
    health: 20,
    food: 20,
    dimension: 'overworld',
    position: world.currentPosition(),
    nearbyPlayers: [],
    inventory: [],
    recentEvents: []
  }
}

function skill(world: AccessibilityWorld) {
  return new GatherResourceSkill({
    resources: world,
    navigation: world,
    safety: new SafetyPolicy(),
    state: () => state(world),
    protection: new RegionProtectionPolicy([]),
    options: {
      initialSearchRadius: 16,
      maxSearchRadius: 16,
      searchStep: 8,
      maxRetries: 3,
      maxCandidatesPerSearch: 8
    }
  })
}

const candidates: ResourceCandidate[] = [
  { blockName: 'spruce_log', position: { x: 4, y: 68, z: 0 } },
  { blockName: 'spruce_log', position: { x: 5, y: 69, z: 0 } },
  { blockName: 'spruce_log', position: { x: 6, y: 70, z: 0 } },
  { blockName: 'spruce_log', position: { x: 12, y: 64, z: 0 } }
]

test('unreachable canopy candidates are skipped so a later reachable log can be gathered', async () => {
  const world = new AccessibilityWorld(candidates)
  world.unreachableX.add(4)
  world.unreachableX.add(5)
  world.unreachableX.add(6)

  const result = await skill(world).execute(
    { signal: new AbortController().signal },
    { resource: 'spruce_log', quantity: 1 }
  )

  assert.deepEqual(result, { status: 'succeeded', code: 'gathered' })
  assert.equal(world.inventoryCount('spruce_log'), 1)
  assert.deepEqual(world.navigationAttempts.map(position => position.x), [4, 5, 6, 12])
})

test('all unreachable candidates terminate as no_path after the bounded candidate set is exhausted', async () => {
  const world = new AccessibilityWorld(candidates)
  for (const candidate of candidates) world.unreachableX.add(candidate.position.x)

  const result = await skill(world).execute(
    { signal: new AbortController().signal },
    { resource: 'spruce_log', quantity: 1 }
  )

  assert.deepEqual(result, { status: 'failed', code: 'no_path' })
  assert.deepEqual(world.navigationAttempts.map(position => position.x), [4, 5, 6, 12])
})

function key(position: Position): string {
  return `${position.x},${position.y},${position.z}`
}

function distance(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}
