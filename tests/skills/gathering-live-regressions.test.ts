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

class DropRegressionWorld implements ResourceGatheringAdapter, ResourceNavigationAdapter {
  readonly inventory = new Map<string, number>()
  readonly blocks = new Map<string, ResourceCandidate>()
  readonly navigationAttempts: Position[] = []
  readonly harvestAttempts: ResourceCandidate[] = []
  readonly navigationCanDig: boolean[] = []
  position: Position = { x: 0, y: 64, z: 0 }
  recoveryCollectsDrop = false
  alwaysMissPickup = false
  private pendingDrop: ResourceCandidate | null = null

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
    this.harvestAttempts.push({ blockName: target.blockName, position: { ...target.position } })
    if (!isResourceMutationPermit(permit) || !permit.allowedBlockNames.includes(target.blockName)) {
      return { status: 'failed', code: 'mutation_not_permitted' }
    }
    this.blocks.delete(key(target.position))
    this.pendingDrop = { blockName: target.blockName, position: { ...target.position } }
    return { status: 'failed', code: 'item_not_collected' }
  }

  async goTo(
    position: Position,
    options: { readonly range: number; readonly canDig: false },
    signal: AbortSignal
  ): Promise<SkillResult> {
    if (signal.aborted) return { status: 'cancelled', code: 'cancelled' }
    this.navigationAttempts.push({ ...position })
    this.navigationCanDig.push(options.canDig)
    this.position = { ...position }

    if (
      this.recoveryCollectsDrop &&
      !this.alwaysMissPickup &&
      this.pendingDrop &&
      samePosition(position, this.pendingDrop.position)
    ) {
      const item = this.pendingDrop.blockName
      this.inventory.set(item, this.inventoryCount(item) + 1)
      this.pendingDrop = null
    }

    return { status: 'succeeded', code: 'reached' }
  }
}

function state(world: DropRegressionWorld): WorldStateSnapshot {
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

function createSkill(world: DropRegressionWorld, maxRetries = 2) {
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
      maxRetries,
      maxCandidatesPerSearch: 8
    }
  })
}

test('item_not_collected performs one safe pickup recovery at the harvested block', async () => {
  const world = new DropRegressionWorld([
    { blockName: 'spruce_log', position: { x: 4, y: 64, z: 0 } }
  ])
  world.recoveryCollectsDrop = true

  const result = await createSkill(world).execute(
    { signal: new AbortController().signal },
    { resource: 'spruce_log', quantity: 1 }
  )

  assert.deepEqual(result, { status: 'succeeded', code: 'gathered' })
  assert.equal(world.inventoryCount('spruce_log'), 1)
  assert.deepEqual(world.navigationAttempts, [
    { x: 4, y: 64, z: 0 },
    { x: 4, y: 64, z: 0 }
  ])
  assert.equal(world.navigationCanDig.every(value => value === false), true)
})

test('persistent pickup failure preserves item_not_collected instead of reporting stuck', async () => {
  const world = new DropRegressionWorld([
    { blockName: 'spruce_log', position: { x: 4, y: 64, z: 0 } },
    { blockName: 'spruce_log', position: { x: 6, y: 64, z: 0 } }
  ])
  world.recoveryCollectsDrop = false
  world.alwaysMissPickup = true

  const result = await createSkill(world, 2).execute(
    { signal: new AbortController().signal },
    { resource: 'spruce_log', quantity: 1 }
  )

  assert.deepEqual(result, { status: 'failed', code: 'item_not_collected' })
})

function key(position: Position): string {
  return `${position.x},${position.y},${position.z}`
}

function distance(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function samePosition(a: Position, b: Position): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z
}
