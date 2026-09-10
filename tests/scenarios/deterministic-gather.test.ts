import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { GoalRequest } from '../../src/contracts/goals.js'
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
  type ProtectedRegion
} from '../../src/skills/gathering.js'
import { ReturnHomeSkill } from '../../src/skills/navigation.js'
import {
  SafetyPolicy,
  isResourceMutationPermit,
  type ResourceMutationPermit
} from '../../src/safety/policy.js'

interface Fixture {
  home: Position
  inventoryCapacity: number
  clusters: ResourceCandidate[][]
  protectedBlocks: ResourceCandidate[]
  protectedRegions: ProtectedRegion[]
}

class ScenarioWorld implements ResourceGatheringAdapter, ResourceNavigationAdapter {
  readonly blocks = new Map<string, ResourceCandidate>()
  readonly inventory = new Map<string, number>()
  readonly harvested: ResourceCandidate[] = []
  readonly navigationTargets: Position[] = []
  readonly searchRadii: number[] = []
  position: Position

  constructor(
    home: Position,
    blocks: readonly ResourceCandidate[],
    private readonly inventoryCapacity: number
  ) {
    this.position = { ...home }
    for (const block of blocks) this.blocks.set(key(block.position), cloneCandidate(block))
  }

  currentPosition(): Position | null {
    return { ...this.position }
  }

  inventoryCount(item: string): number {
    return this.inventory.get(item) ?? 0
  }

  async findResourceBlocks(
    request: ResourceSearchRequest,
    signal: AbortSignal
  ): Promise<readonly ResourceCandidate[]> {
    if (signal.aborted) return []
    this.searchRadii.push(request.radius)
    return [...this.blocks.values()]
      .filter(block => request.blockNames.includes(block.blockName))
      .filter(block => distance(block.position, request.origin) <= request.radius)
      .sort((a, b) => distance(a.position, request.origin) - distance(b.position, request.origin))
      .slice(0, request.limit)
      .map(cloneCandidate)
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
    const total = [...this.inventory.values()].reduce((sum, count) => sum + count, 0)
    if (total >= this.inventoryCapacity) {
      return { status: 'failed', code: 'inventory_full' }
    }
    const existing = this.blocks.get(key(target.position))
    if (!existing || existing.blockName !== target.blockName) {
      return { status: 'failed', code: 'resource_changed' }
    }
    this.blocks.delete(key(target.position))
    this.harvested.push(cloneCandidate(target))
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
    this.navigationTargets.push({ ...position })
    this.position = { ...position }
    return { status: 'succeeded', code: 'reached' }
  }
}

test('direct gather GoalRequest collects allowed logs and returns home without any AI provider', async () => {
  const fixture = JSON.parse(
    await readFile('fixtures/worlds/deterministic-gather.json', 'utf8')
  ) as Fixture
  const blocks = [...fixture.clusters.flat(), ...fixture.protectedBlocks]
  const world = new ScenarioWorld(fixture.home, blocks, fixture.inventoryCapacity)
  const protection = new RegionProtectionPolicy(fixture.protectedRegions)
  const safety = new SafetyPolicy()

  const gatherGoal: GoalRequest = {
    kind: 'gather_resource',
    args: { resource: 'oak_log', quantity: 4 }
  }
  const returnGoal: GoalRequest = { kind: 'return_home', args: {} }

  const gather = new GatherResourceSkill({
    resources: world,
    navigation: world,
    safety,
    state: () => state(world),
    protection,
    options: {
      initialSearchRadius: 8,
      maxSearchRadius: 24,
      searchStep: 8,
      maxRetries: 3,
      maxCandidatesPerSearch: 8
    }
  })
  const returnHome = new ReturnHomeSkill(world, {
    resolveHome: () => fixture.home
  })
  const context = { signal: new AbortController().signal }

  const gatherResult = await gather.execute(context, gatherGoal.args)
  const returnResult = await returnHome.execute(context, returnGoal.args)

  assert.deepEqual(gatherResult, { status: 'succeeded', code: 'gathered' })
  assert.deepEqual(returnResult, { status: 'succeeded', code: 'reached' })
  assert.equal(world.inventoryCount('oak_log'), 4)
  assert.equal(
    world.harvested.some(candidate => protection.isProtected(candidate.position)),
    false
  )
  assert.deepEqual(world.position, fixture.home)
  assert.deepEqual(world.navigationTargets.at(-1), fixture.home)
  assert.equal(Math.max(...world.searchRadii), 24)
})

function state(world: ScenarioWorld): WorldStateSnapshot {
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

function key(position: Position): string {
  return `${position.x},${position.y},${position.z}`
}

function cloneCandidate(candidate: ResourceCandidate): ResourceCandidate {
  return { blockName: candidate.blockName, position: { ...candidate.position } }
}

function distance(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}
