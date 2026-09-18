import assert from 'node:assert/strict'
import test from 'node:test'
import type { Position } from '../../src/contracts/events.js'
import type { SkillResult } from '../../src/contracts/skills.js'
import type {
  ServerCapability,
  ServerCapabilityStatusSource
} from '../../src/minecraft/moxuebridge-capabilities.js'
import type { WorldStateSnapshot } from '../../src/state/world-state.js'
import type {
  DroppedResource,
  DroppedResourceStatus,
  ResourceCandidate,
  ResourceGatheringAdapter,
  ResourceHarvestOptions,
  ResourceNavigationAdapter,
  ResourceSearchRequest
} from '../../src/minecraft/gathering.js'
import {
  FindResourceSkill,
  GatherResourceSkill,
  RegionProtectionPolicy
} from '../../src/skills/gathering.js'
import {
  SafetyPolicy,
  isResourceMutationPermit,
  type ResourceMutationPermit
} from '../../src/safety/policy.js'

interface FakeBlock extends ResourceCandidate {}

class FakeGatheringWorld implements ResourceGatheringAdapter, ResourceNavigationAdapter {
  readonly searchRequests: ResourceSearchRequest[] = []
  readonly harvestAttempts: ResourceCandidate[] = []
  readonly harvestOptions: Array<ResourceHarvestOptions | undefined> = []
  readonly toolPreparationAttempts: ResourceCandidate[] = []
  readonly toolPreparationKinds: Array<'axe' | 'pickaxe' | undefined> = []
  readonly navigationAttempts: Position[] = []
  readonly dropped: DroppedResource[] = []
  chainBreakCount = 1
  readonly navigationCanDig: boolean[] = []
  readonly inventory = new Map<string, number>()
  readonly blocks = new Map<string, FakeBlock>()
  failNavigation = false
  position: Position = { x: 0, y: 64, z: 0 }

  constructor(blocks: readonly FakeBlock[]) {
    for (const block of blocks) this.blocks.set(key(block.position), block)
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
    this.searchRequests.push({ ...request, blockNames: [...request.blockNames], origin: { ...request.origin } })
    return [...this.blocks.values()]
      .filter(block => request.blockNames.includes(block.blockName))
      .filter(block => distance(block.position, request.origin) <= request.radius)
      .slice(0, request.limit)
      .map(block => ({ blockName: block.blockName, position: { ...block.position } }))
  }

  async prepareResourceTool(
    target: ResourceCandidate,
    signal: AbortSignal,
    toolKind?: 'axe' | 'pickaxe'
  ): Promise<SkillResult> {
    if (signal.aborted) return { status: 'cancelled', code: 'cancelled' }
    this.toolPreparationAttempts.push({
      blockName: target.blockName,
      position: { ...target.position }
    })
    this.toolPreparationKinds.push(toolKind)
    return { status: 'succeeded', code: 'correct_tool_equipped' }
  }

  async harvestResourceBlock(
    target: ResourceCandidate,
    permit: ResourceMutationPermit,
    signal: AbortSignal,
    options?: ResourceHarvestOptions
  ): Promise<SkillResult> {
    if (signal.aborted) return { status: 'cancelled', code: 'cancelled' }
    this.harvestAttempts.push({ blockName: target.blockName, position: { ...target.position } })
    this.harvestOptions.push(options ? { ...options } : undefined)
    if (!isResourceMutationPermit(permit) || !permit.allowedBlockNames.includes(target.blockName)) {
      return { status: 'failed', code: 'mutation_not_permitted' }
    }
    const stored = this.blocks.get(key(target.position))
    if (!stored || stored.blockName !== target.blockName) {
      return { status: 'failed', code: 'resource_changed' }
    }
    const matching = [...this.blocks.values()]
      .filter(block => block.blockName === target.blockName)
      .sort((a, b) => distance(a.position, target.position) - distance(b.position, target.position))
      .slice(0, options ? this.chainBreakCount : 1)

    for (const [index, block] of matching.entries()) {
      this.blocks.delete(key(block.position))
      if (index === 0) {
        this.inventory.set(target.blockName, this.inventoryCount(target.blockName) + 1)
      } else {
        this.dropped.push({
          entityId: 100 + this.dropped.length,
          itemName: target.blockName,
          count: 1,
          position: { ...block.position }
        })
      }
    }
    return { status: 'succeeded', code: 'collected' }
  }


  async findDroppedResource(
    itemName: string,
    origin: Position,
    radius: number,
    signal: AbortSignal
  ): Promise<DroppedResource | null> {
    if (signal.aborted) return null
    return this.dropped
      .filter(drop => drop.itemName === itemName)
      .filter(drop => distance(drop.position, origin) <= radius)
      .sort((a, b) => distance(a.position, origin) - distance(b.position, origin))[0] ?? null
  }

  droppedResourceStatus(entityId: number): DroppedResourceStatus {
    const drop = this.dropped.find(candidate => candidate.entityId === entityId)
    return drop
      ? { kind: 'present', drop: { ...drop, position: { ...drop.position } } }
      : { kind: 'collected_by_bot', count: 1 }
  }

  async goTo(
    position: Position,
    options: { readonly range: number; readonly canDig: false },
    signal: AbortSignal
  ): Promise<SkillResult> {
    if (signal.aborted) return { status: 'cancelled', code: 'cancelled' }
    this.navigationAttempts.push({ ...position })
    this.navigationCanDig.push(options.canDig)
    if (this.failNavigation) return { status: 'failed', code: 'no_path' }
    this.position = { ...position }
    const dropIndex = this.dropped.findIndex(drop => distance(drop.position, position) < 0.01)
    if (dropIndex >= 0) {
      const [drop] = this.dropped.splice(dropIndex, 1)
      if (drop) {
        this.inventory.set(drop.itemName, this.inventoryCount(drop.itemName) + drop.count)
      }
    }
    return { status: 'succeeded', code: 'reached' }
  }
}

function worldState(world: FakeGatheringWorld): WorldStateSnapshot {
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


function capabilitySource(
  capability: ServerCapability,
  state: 'current' | 'stale' | 'unavailable' = 'current'
): ServerCapabilityStatusSource {
  return {
    snapshot: () => [structuredClone(capability)],
    has: id => id === capability.id,
    get: id => id === capability.id ? structuredClone(capability) : undefined,
    status: () => ({
      state,
      lastSuccessAt: state === 'unavailable' ? null : 1234,
      lastErrorCode: state === 'current' ? null : 'request_failed'
    })
  }
}

const veinMiningCapability: ServerCapability = {
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
    max_chain: 2,
    same_block_only: true,
    correct_tool_required: true,
    must_sneak: true
  }
}


const treeFellingCapability: ServerCapability = {
  ...veinMiningCapability,
  id: 'tree_felling',
  name: '連鎖伐木',
  description: '一次砍伐相連的原木方塊',
  usage: {
    trigger: 'sneak_and_break',
    human: '蹲下並使用斧頭砍伐相連原木'
  },
  constraints: {
    max_chain: 2,
    same_block_only: true,
    correct_tool_required: true,
    must_sneak: true,
    tool_kind: 'axe',
    merge_item_drops: false
  }
}

const blocks: FakeBlock[] = [
  { blockName: 'oak_log', position: { x: 4, y: 64, z: 0 } },
  { blockName: 'oak_log', position: { x: 6, y: 64, z: 0 } },
  { blockName: 'oak_log', position: { x: 12, y: 64, z: 0 } }
]

test('find_resource performs one bounded search and does not mutate blocks', async () => {
  const world = new FakeGatheringWorld(blocks)
  const skill = new FindResourceSkill(world, new RegionProtectionPolicy([]), {
    maxSearchRadius: 32,
    maxCandidatesPerSearch: 8
  })

  const result = await skill.execute({ signal: new AbortController().signal }, {
    resource: 'oak_log',
    radius: 12
  })

  assert.equal(result.status, 'succeeded')
  assert.equal(result.code, 'resource_found')
  assert.equal(world.searchRequests.length, 1)
  assert.equal(world.searchRequests[0]?.radius, 12)
  assert.equal(world.searchRequests[0]?.limit, 8)
  assert.deepEqual(world.harvestAttempts, [])
})

test('gather_resource skips protected candidates and only navigates with canDig=false', async () => {
  const world = new FakeGatheringWorld(blocks)
  const protection = new RegionProtectionPolicy([
    { min: { x: 5, y: 63, z: -1 }, max: { x: 7, y: 65, z: 1 } }
  ])
  const skill = new GatherResourceSkill({
    resources: world,
    navigation: world,
    safety: new SafetyPolicy(),
    state: () => worldState(world),
    protection,
    options: {
      initialSearchRadius: 8,
      maxSearchRadius: 24,
      searchStep: 8,
      maxRetries: 3,
      maxCandidatesPerSearch: 8
    }
  })

  const result = await skill.execute({ signal: new AbortController().signal }, {
    resource: 'oak_log',
    quantity: 2
  })

  assert.deepEqual(result, { status: 'succeeded', code: 'gathered' })
  assert.equal(world.inventoryCount('oak_log'), 2)
  assert.deepEqual(
    world.harvestAttempts.map(candidate => candidate.position.x),
    [4, 12]
  )
  assert.equal(world.harvestAttempts.some(candidate => candidate.position.x === 6), false)
  assert.equal(world.navigationCanDig.every(value => value === false), true)
  assert.equal(world.searchRequests.every(request => request.radius <= 24), true)
})


test('gather_resource activates bounded tree-felling hints with semantic axe preparation', async () => {
  const logBlocks: FakeBlock[] = [
    { blockName: 'oak_log', position: { x: 4, y: 64, z: 0 } },
    { blockName: 'oak_log', position: { x: 6, y: 64, z: 0 } }
  ]
  const world = new FakeGatheringWorld(logBlocks)
  const skill = new GatherResourceSkill({
    resources: world,
    navigation: world,
    safety: new SafetyPolicy(),
    state: () => worldState(world),
    protection: new RegionProtectionPolicy([]),
    capabilities: capabilitySource(treeFellingCapability),
    options: {
      initialSearchRadius: 16,
      maxSearchRadius: 16,
      searchStep: 8,
      maxRetries: 2,
      maxCandidatesPerSearch: 8
    }
  })

  const result = await skill.execute({ signal: new AbortController().signal }, {
    resource: 'oak_log',
    quantity: 2
  })

  assert.deepEqual(result, { status: 'succeeded', code: 'gathered' })
  assert.equal(world.toolPreparationAttempts.length, 1)
  assert.deepEqual(world.toolPreparationKinds, ['axe'])
  assert.deepEqual(world.harvestOptions, [{ sneak: true }, undefined])
})




test('gather_resource collects bounded extra drops after one chained tree harvest', async () => {
  const world = new FakeGatheringWorld([
    { blockName: 'oak_log', position: { x: 4, y: 64, z: 0 } },
    { blockName: 'oak_log', position: { x: 5, y: 64, z: 0 } },
    { blockName: 'oak_log', position: { x: 6, y: 64, z: 0 } },
    { blockName: 'oak_log', position: { x: 7, y: 64, z: 0 } }
  ])
  world.chainBreakCount = 4

  const skill = new GatherResourceSkill({
    resources: world,
    navigation: world,
    safety: new SafetyPolicy(),
    state: () => worldState(world),
    protection: new RegionProtectionPolicy([]),
    capabilities: capabilitySource({
      ...treeFellingCapability,
      constraints: {
        ...treeFellingCapability.constraints,
        max_chain: 4
      }
    }),
    options: {
      initialSearchRadius: 16,
      maxSearchRadius: 16,
      searchStep: 8,
      maxRetries: 2,
      maxCandidatesPerSearch: 8
    }
  })

  const result = await skill.execute({ signal: new AbortController().signal }, {
    resource: 'oak_log',
    quantity: 4
  })

  assert.deepEqual(result, { status: 'succeeded', code: 'gathered' })
  assert.equal(world.harvestAttempts.length, 1)
  assert.equal(world.inventoryCount('oak_log'), 4)
  assert.equal(world.dropped.length, 0)
  assert.deepEqual(world.toolPreparationKinds, ['axe'])
  assert.deepEqual(world.harvestOptions, [{ sneak: true }])
})

test('vein_mining remains discoverable but does not actuate before resource-profile accounting exists', async () => {
  const world = new FakeGatheringWorld([
    { blockName: 'iron_ore', position: { x: 4, y: 64, z: 0 } },
    { blockName: 'iron_ore', position: { x: 6, y: 64, z: 0 } }
  ])
  const capability = {
    ...veinMiningCapability,
    constraints: {
      ...veinMiningCapability.constraints,
      tool_kind: 'pickaxe'
    }
  }
  const skill = new GatherResourceSkill({
    resources: world,
    navigation: world,
    safety: new SafetyPolicy(),
    state: () => worldState(world),
    protection: new RegionProtectionPolicy([]),
    capabilities: capabilitySource(capability),
    options: {
      initialSearchRadius: 16,
      maxSearchRadius: 16,
      searchStep: 8,
      maxRetries: 2,
      maxCandidatesPerSearch: 8
    }
  })

  const result = await skill.execute({ signal: new AbortController().signal }, {
    resource: 'iron_ore',
    quantity: 2
  })

  assert.deepEqual(result, { status: 'succeeded', code: 'gathered' })
  assert.deepEqual(world.toolPreparationKinds, [])
  assert.deepEqual(world.harvestOptions, [undefined, undefined])
})

test('gather_resource never uses stale capability data for multi-block mutation', async () => {
  const world = new FakeGatheringWorld([
    { blockName: 'oak_log', position: { x: 4, y: 64, z: 0 } },
    { blockName: 'oak_log', position: { x: 6, y: 64, z: 0 } }
  ])
  const skill = new GatherResourceSkill({
    resources: world,
    navigation: world,
    safety: new SafetyPolicy(),
    state: () => worldState(world),
    protection: new RegionProtectionPolicy([]),
    capabilities: capabilitySource(treeFellingCapability, 'stale'),
    options: {
      initialSearchRadius: 16,
      maxSearchRadius: 16,
      searchStep: 8,
      maxRetries: 2,
      maxCandidatesPerSearch: 8
    }
  })

  const result = await skill.execute({ signal: new AbortController().signal }, {
    resource: 'oak_log',
    quantity: 2
  })

  assert.deepEqual(result, { status: 'succeeded', code: 'gathered' })
  assert.deepEqual(world.toolPreparationAttempts, [])
  assert.deepEqual(world.harvestOptions, [undefined, undefined])
})

test('gather_resource refuses chain acceleration when the bridge cannot guarantee same-block scope', async () => {
  const world = new FakeGatheringWorld([
    { blockName: 'oak_log', position: { x: 4, y: 64, z: 0 } },
    { blockName: 'oak_log', position: { x: 6, y: 64, z: 0 } }
  ])
  const unsafeScope = {
    ...treeFellingCapability,
    constraints: {
      max_chain: 2,
      correct_tool_required: true,
      must_sneak: true,
      tool_kind: 'axe'
    }
  }
  const skill = new GatherResourceSkill({
    resources: world,
    navigation: world,
    safety: new SafetyPolicy(),
    state: () => worldState(world),
    protection: new RegionProtectionPolicy([]),
    capabilities: capabilitySource(unsafeScope),
    options: {
      initialSearchRadius: 16,
      maxSearchRadius: 16,
      searchStep: 8,
      maxRetries: 2,
      maxCandidatesPerSearch: 8
    }
  })

  const result = await skill.execute({ signal: new AbortController().signal }, {
    resource: 'oak_log',
    quantity: 2
  })

  assert.deepEqual(result, { status: 'succeeded', code: 'gathered' })
  assert.deepEqual(world.toolPreparationAttempts, [])
  assert.deepEqual(world.harvestOptions, [undefined, undefined])
})

test('gather_resource does not activate an accelerator whose advertised chain can exceed the request', async () => {
  const world = new FakeGatheringWorld([
    { blockName: 'oak_log', position: { x: 4, y: 64, z: 0 } }
  ])
  const skill = new GatherResourceSkill({
    resources: world,
    navigation: world,
    safety: new SafetyPolicy(),
    state: () => worldState(world),
    protection: new RegionProtectionPolicy([]),
    capabilities: capabilitySource({
      ...treeFellingCapability,
      constraints: {
        ...treeFellingCapability.constraints,
        max_chain: 100
      }
    }),
    options: {
      initialSearchRadius: 16,
      maxSearchRadius: 16,
      searchStep: 8,
      maxRetries: 2,
      maxCandidatesPerSearch: 8
    }
  })

  const result = await skill.execute({ signal: new AbortController().signal }, {
    resource: 'oak_log',
    quantity: 1
  })

  assert.deepEqual(result, { status: 'succeeded', code: 'gathered' })
  assert.deepEqual(world.toolPreparationAttempts, [])
  assert.deepEqual(world.harvestOptions, [undefined])
})

test('search expansion is bounded and reports resource_not_found instead of scanning forever', async () => {
  const world = new FakeGatheringWorld([])
  const skill = new GatherResourceSkill({
    resources: world,
    navigation: world,
    safety: new SafetyPolicy(),
    state: () => worldState(world),
    protection: new RegionProtectionPolicy([]),
    options: {
      initialSearchRadius: 8,
      maxSearchRadius: 24,
      searchStep: 8,
      maxRetries: 2,
      maxCandidatesPerSearch: 8
    }
  })

  const result = await skill.execute({ signal: new AbortController().signal }, {
    resource: 'oak_log',
    quantity: 1
  })

  assert.deepEqual(result, { status: 'failed', code: 'resource_not_found' })
  assert.deepEqual(world.searchRequests.map(request => request.radius), [8, 16, 24])
})

test('unreachable candidates are exhausted before preserving the real no_path failure', async () => {
  const world = new FakeGatheringWorld(blocks)
  world.failNavigation = true
  const skill = new GatherResourceSkill({
    resources: world,
    navigation: world,
    safety: new SafetyPolicy(),
    state: () => worldState(world),
    protection: new RegionProtectionPolicy([]),
    options: {
      initialSearchRadius: 16,
      maxSearchRadius: 16,
      searchStep: 8,
      maxRetries: 2,
      maxCandidatesPerSearch: 8
    }
  })

  const result = await skill.execute({ signal: new AbortController().signal }, {
    resource: 'oak_log',
    quantity: 1
  })

  assert.deepEqual(result, { status: 'failed', code: 'no_path' })
  assert.equal(world.navigationAttempts.length, 3)
  assert.deepEqual(world.harvestAttempts, [])
})

function key(position: Position): string {
  return `${position.x},${position.y},${position.z}`
}

function distance(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}
