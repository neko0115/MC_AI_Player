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
  ResourceSearchRequest,
  ResourceToolPreparationOptions
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
  readonly toolPreparationForbidden: string[][] = []
  readonly navigationAttempts: Position[] = []
  readonly dropped: DroppedResource[] = []
  chainBreakCount = 1
  collectFirstImmediately = true
  onHarvest: (() => void) | null = null
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
    options: ResourceToolPreparationOptions = {}
  ): Promise<SkillResult> {
    if (signal.aborted) return { status: 'cancelled', code: 'cancelled' }
    this.toolPreparationAttempts.push({
      blockName: target.blockName,
      position: { ...target.position }
    })
    this.toolPreparationKinds.push(options.toolKind)
    this.toolPreparationForbidden.push([...(options.forbiddenEnchantments ?? [])])
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
    if (options?.requireCollection === false) {
      this.blocks.delete(key(target.position))
      return { status: 'succeeded', code: 'removed' }
    }
    const matching = [...this.blocks.values()]
      .filter(block => block.blockName === target.blockName)
      .sort((a, b) => distance(a.position, target.position) - distance(b.position, target.position))
      .slice(0, options?.sneak ? this.chainBreakCount : 1)

    const collectedItem =
      options?.expectedItemNames?.[0] ?? target.blockName

    for (const [index, block] of matching.entries()) {
      this.blocks.delete(key(block.position))
      if (index === 0 && this.collectFirstImmediately) {
        this.inventory.set(collectedItem, this.inventoryCount(collectedItem) + 1)
      } else {
        this.dropped.push({
          entityId: 100 + this.dropped.length,
          itemName: collectedItem,
          count: 1,
          position: { ...block.position }
        })
      }
    }
    this.onHarvest?.()
    return this.collectFirstImmediately
      ? { status: 'succeeded', code: 'collected' }
      : { status: 'failed', code: 'item_not_collected' }
  }


  async findDecayingLeafBlocks(
    leafNames: readonly string[],
    origin: Position,
    radius: number,
    limit: number,
    signal: AbortSignal
  ): Promise<readonly ResourceCandidate[]> {
    if (signal.aborted) return []
    return [...this.blocks.values()]
      .filter(block => leafNames.includes(block.blockName))
      .filter(block => distance(block.position, origin) <= radius)
      .slice(0, limit)
      .map(block => ({
        blockName: block.blockName,
        position: { ...block.position }
      }))
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
    must_sneak: true,
    tool_kind: 'pickaxe',
    exact_block: 'minecraft:iron_ore'
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
    merge_item_drops: false,
    exact_block: 'minecraft:oak_log'
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

test('gather_resource resumes the original minimum target after threat suspension', async () => {
  const world = new FakeGatheringWorld([
    { blockName: 'oak_log', position: { x: 4, y: 64, z: 0 } }
  ])
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

  const firstController = new AbortController()
  world.onHarvest = () => {
    firstController.abort('threat_suspended')
  }

  const first = await skill.execute(
    {
      signal: firstController.signal,
      executionId: 'goal-resume-1'
    },
    {
      resource: 'oak_log',
      quantity: 2
    }
  )

  assert.deepEqual(first, {
    status: 'cancelled',
    code: 'threat_suspended'
  })
  assert.equal(world.inventoryCount('oak_log'), 1)

  world.onHarvest = null
  world.blocks.set(
    key({ x: 6, y: 64, z: 0 }),
    { blockName: 'oak_log', position: { x: 6, y: 64, z: 0 } }
  )

  const resumed = await skill.execute(
    {
      signal: new AbortController().signal,
      executionId: 'goal-resume-1'
    },
    {
      resource: 'oak_log',
      quantity: 2
    }
  )

  assert.deepEqual(resumed, {
    status: 'succeeded',
    code: 'gathered'
  })
  assert.equal(world.inventoryCount('oak_log'), 2)
  assert.equal(world.harvestAttempts.length, 2)
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
  world.chainBreakCount = 2
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
  assert.deepEqual(world.harvestOptions, [{ sneak: true }])
})




test('gather_resource collects bounded extra drops after one chained tree harvest', async () => {
  const capabilityNotices: Array<{ capability: string; resource: string; maxChain: number }> = []
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
    onCapabilityUsed: notice => capabilityNotices.push({ ...notice }),
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
  assert.deepEqual(capabilityNotices, [{
    capability: 'tree_felling',
    resource: 'oak_log',
    maxChain: 4
  }])
})


test('gather_resource recovers every chained drop when the first pickup is delayed', async () => {
  const capabilityNotices: Array<{ capability: string; resource: string; maxChain: number }> = []
  const world = new FakeGatheringWorld([
    { blockName: 'oak_log', position: { x: 4, y: 64, z: 0 } },
    { blockName: 'oak_log', position: { x: 5, y: 64, z: 0 } },
    { blockName: 'oak_log', position: { x: 6, y: 64, z: 0 } },
    { blockName: 'oak_log', position: { x: 7, y: 64, z: 0 } }
  ])
  world.chainBreakCount = 4
  world.collectFirstImmediately = false

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
    onCapabilityUsed: notice => capabilityNotices.push({ ...notice }),
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
  assert.deepEqual(capabilityNotices, [{
    capability: 'tree_felling',
    resource: 'oak_log',
    maxChain: 4
  }])
})

test('remove_after_felling cleans bounded decaying leaves without requiring leaf drops', async () => {
  const world = new FakeGatheringWorld([
    { blockName: 'oak_log', position: { x: 4, y: 64, z: 0 } },
    { blockName: 'oak_log', position: { x: 4, y: 65, z: 0 } },
    { blockName: 'oak_log', position: { x: 4, y: 66, z: 0 } },
    { blockName: 'oak_log', position: { x: 4, y: 67, z: 0 } },
    { blockName: 'oak_leaves', position: { x: 3, y: 67, z: 0 } },
    { blockName: 'oak_leaves', position: { x: 5, y: 67, z: 0 } }
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
      maxCandidatesPerSearch: 8,
      leafCleanupPolicyOverride: 'remove_after_felling'
    }
  })

  const result = await skill.execute({ signal: new AbortController().signal }, {
    resource: 'oak_log',
    quantity: 1
  })

  assert.deepEqual(result, { status: 'succeeded', code: 'gathered' })
  assert.equal(world.inventoryCount('oak_log'), 4)
  assert.equal(world.inventoryCount('oak_leaves'), 0)
  assert.equal(
    [...world.blocks.values()].some(block => block.blockName === 'oak_leaves'),
    false
  )
  assert.deepEqual(
    world.harvestAttempts.map(attempt => attempt.blockName),
    ['oak_log', 'oak_leaves', 'oak_leaves']
  )
  assert.deepEqual(
    world.harvestOptions.slice(-2),
    [
      { requireCollection: false },
      { requireCollection: false }
    ]
  )
})

test('vein_mining counts raw iron while allowing Fortune under minimum fulfillment', async () => {
  const world = new FakeGatheringWorld([
    { blockName: 'iron_ore', position: { x: 4, y: 64, z: 0 } },
    { blockName: 'iron_ore', position: { x: 5, y: 64, z: 0 } }
  ])
  world.chainBreakCount = 2

  const skill = new GatherResourceSkill({
    resources: world,
    navigation: world,
    safety: new SafetyPolicy(),
    state: () => worldState(world),
    protection: new RegionProtectionPolicy([]),
    capabilities: capabilitySource(veinMiningCapability),
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
  assert.equal(world.inventoryCount('iron_ore'), 0)
  assert.equal(world.inventoryCount('raw_iron'), 2)
  assert.deepEqual(world.toolPreparationKinds, ['pickaxe'])
  assert.deepEqual(world.toolPreparationForbidden, [['silk_touch']])
  assert.deepEqual(world.harvestOptions, [{
    expectedItemNames: ['raw_iron'],
    sneak: true
  }])
})

test('exact block scope prevents iron-ore acceleration from being applied to deepslate iron ore', async () => {
  const world = new FakeGatheringWorld([
    { blockName: 'deepslate_iron_ore', position: { x: 4, y: 64, z: 0 } }
  ])

  const skill = new GatherResourceSkill({
    resources: world,
    navigation: world,
    safety: new SafetyPolicy(),
    state: () => worldState(world),
    protection: new RegionProtectionPolicy([]),
    capabilities: capabilitySource(veinMiningCapability),
    options: {
      initialSearchRadius: 16,
      maxSearchRadius: 16,
      searchStep: 8,
      maxRetries: 2,
      maxCandidatesPerSearch: 8
    }
  })

  const result = await skill.execute({ signal: new AbortController().signal }, {
    resource: 'raw_iron',
    quantity: 1
  })

  assert.deepEqual(result, { status: 'succeeded', code: 'gathered' })
  assert.equal(world.inventoryCount('raw_iron'), 1)
  assert.deepEqual(world.toolPreparationKinds, ['pickaxe'])
  assert.deepEqual(world.harvestOptions, [{
    expectedItemNames: ['raw_iron']
  }])
})

test('unsafe vein capability falls back to one-block raw-iron gathering with a non-Silk pickaxe', async () => {
  const world = new FakeGatheringWorld([
    { blockName: 'iron_ore', position: { x: 4, y: 64, z: 0 } },
    { blockName: 'iron_ore', position: { x: 6, y: 64, z: 0 } }
  ])
  const unsafe = {
    ...veinMiningCapability,
    constraints: {
      ...veinMiningCapability.constraints,
      same_block_only: false
    }
  }
  const skill = new GatherResourceSkill({
    resources: world,
    navigation: world,
    safety: new SafetyPolicy(),
    state: () => worldState(world),
    protection: new RegionProtectionPolicy([]),
    capabilities: capabilitySource(unsafe),
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
  assert.equal(world.inventoryCount('raw_iron'), 2)
  assert.deepEqual(world.toolPreparationKinds, ['pickaxe', 'pickaxe'])
  assert.deepEqual(world.toolPreparationForbidden, [
    ['silk_touch'],
    ['silk_touch']
  ])
  assert.deepEqual(world.harvestOptions, [
    { expectedItemNames: ['raw_iron'] },
    { expectedItemNames: ['raw_iron'] }
  ])
})

test('find_resource accepts the canonical raw-iron alias and searches both iron ore variants', async () => {
  const world = new FakeGatheringWorld([
    { blockName: 'deepslate_iron_ore', position: { x: 4, y: 64, z: 0 } }
  ])
  const skill = new FindResourceSkill(world, new RegionProtectionPolicy([]), {
    maxSearchRadius: 16,
    maxCandidatesPerSearch: 8
  })

  const result = await skill.execute({ signal: new AbortController().signal }, {
    resource: 'raw_iron',
    radius: 16
  })

  assert.equal(result.status, 'succeeded')
  assert.deepEqual(world.searchRequests[0]?.blockNames, [
    'iron_ore',
    'deepslate_iron_ore'
  ])
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

test('gather_resource may over-collect a bounded natural chain and cleans up every produced drop', async () => {
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
    quantity: 1
  })

  assert.deepEqual(result, { status: 'succeeded', code: 'gathered' })
  assert.equal(world.harvestAttempts.length, 1)
  assert.equal(world.inventoryCount('oak_log'), 4)
  assert.equal(world.dropped.length, 0)
  assert.deepEqual(world.toolPreparationKinds, ['axe'])
  assert.deepEqual(world.harvestOptions, [{ sneak: true }])
})

test('search expansion is bounded and reports resource_not_visible instead of scanning forever', async () => {
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

  assert.deepEqual(result, { status: 'failed', code: 'resource_not_visible' })
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
