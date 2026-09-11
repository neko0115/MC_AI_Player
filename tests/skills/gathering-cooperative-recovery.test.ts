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
  RegionProtectionPolicy,
  type CooperativePickupNotice
} from '../../src/skills/gathering.js'
import {
  SafetyPolicy,
  isResourceMutationPermit,
  type ResourceMutationPermit
} from '../../src/safety/policy.js'

interface DropView {
  entityId: number
  itemName: string
  count: number
  position: Position
}

interface PlayerCollectionView extends DropView {
  sequence: number
  player: string
}

class CooperativeWorld implements ResourceGatheringAdapter, ResourceNavigationAdapter {
  readonly inventory = new Map<string, number>()
  readonly blocks = new Map<string, ResourceCandidate>()
  readonly navigationAttempts: Position[] = []
  readonly playerCollections: PlayerCollectionView[] = []
  position: Position = { x: 0, y: 64, z: 0 }
  nextEntityId = 100
  collectionSequence = 0
  interceptFirst = 0
  harvested = 0
  activeDrop: DropView | null = null

  constructor(blocks: readonly ResourceCandidate[]) {
    for (const block of blocks) this.blocks.set(key(block.position), block)
  }

  currentPosition(): Position | null {
    return { ...this.position }
  }

  inventoryCount(item: string): number {
    return this.inventory.get(item) ?? 0
  }

  resourceCollectionCursor(): number {
    return this.collectionSequence
  }

  findPlayerResourceCollectionAfter(
    cursor: number,
    itemName: string,
    origin: Position,
    radius: number
  ): PlayerCollectionView | null {
    return this.playerCollections.find(collection =>
      collection.sequence > cursor &&
      collection.itemName === itemName &&
      distance(collection.position, origin) <= radius
    ) ?? null
  }

  async findResourceBlocks(request: ResourceSearchRequest, signal: AbortSignal) {
    if (signal.aborted) return []
    return [...this.blocks.values()]
      .filter(block => request.blockNames.includes(block.blockName))
      .slice(0, request.limit)
      .map(block => structuredClone(block))
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
    this.blocks.delete(key(target.position))
    this.harvested += 1

    if (this.harvested <= this.interceptFirst) {
      const drop: DropView = {
        entityId: this.nextEntityId++,
        itemName: target.blockName,
        count: 1,
        position: {
          x: target.position.x + 1.2,
          y: target.position.y,
          z: target.position.z + 0.4
        }
      }
      this.collectionSequence += 1
      this.playerCollections.push({
        ...drop,
        sequence: this.collectionSequence,
        player: 'Neko0115'
      })
      // Model the real race: the player collects immediately, so the entity
      // is already gone by the time harvestResourceBlock reports the miss.
      this.activeDrop = null
      return { status: 'failed', code: 'item_not_collected' }
    }

    this.inventory.set(target.blockName, this.inventoryCount(target.blockName) + 1)
    return { status: 'succeeded', code: 'collected' }
  }

  async goTo(
    position: Position,
    _options: { readonly range: number; readonly canDig: false },
    signal: AbortSignal
  ): Promise<SkillResult> {
    if (signal.aborted) return { status: 'cancelled', code: 'cancelled' }
    this.navigationAttempts.push({ ...position })
    this.position = { ...position }
    return { status: 'succeeded', code: 'reached' }
  }

  async findDroppedResource(
    itemName: string,
    _origin: Position,
    _radius: number,
    signal: AbortSignal
  ): Promise<DropView | null> {
    if (signal.aborted || !this.activeDrop || this.activeDrop.itemName !== itemName) return null
    return structuredClone(this.activeDrop)
  }

  droppedResourceStatus(entityId: number) {
    if (this.activeDrop?.entityId === entityId) {
      return { kind: 'present' as const, drop: structuredClone(this.activeDrop) }
    }
    return { kind: 'gone' as const }
  }
}

function state(world: CooperativeWorld): WorldStateSnapshot {
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

test('player-collected drops are non-fatal and gather continues until the bot owns the requested quantity', async () => {
  const blocks = [4, 6, 8, 10, 12].map(x => ({
    blockName: 'spruce_log',
    position: { x, y: 64, z: 0 },
    approachPosition: { x: x - 1, y: 64, z: 0 }
  }))
  const world = new CooperativeWorld(blocks)
  world.interceptFirst = 4
  const notices: CooperativePickupNotice[] = []

  const skill = new GatherResourceSkill({
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
    },
    onCooperativePickup: (notice: CooperativePickupNotice) => notices.push(notice)
  })

  const result = await skill.execute(
    { signal: new AbortController().signal },
    { resource: 'spruce_log', quantity: 1 }
  )

  assert.deepEqual(result, { status: 'succeeded', code: 'gathered' })
  assert.equal(world.harvested, 5)
  assert.equal(world.inventoryCount('spruce_log'), 1)
  assert.equal(notices.length, 1)
  assert.deepEqual(notices[0], {
    resource: 'spruce_log',
    player: 'Neko0115',
    interceptedCount: 3,
    remaining: 1
  })
})

function key(position: Position): string {
  return `${position.x},${position.y},${position.z}`
}

function distance(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}
