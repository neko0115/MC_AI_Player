import assert from 'node:assert/strict'
import test from 'node:test'
import type { SkillResult } from '../../src/contracts/skills.js'
import type {
  GameKnowledgePack,
  WorkstationFact
} from '../../src/knowledge/contracts.js'
import type {
  CraftItemRequest,
  ProcessItemRequest,
  ProductionRuntime,
  ResolvedWorkstation
} from '../../src/minecraft/production.js'
import {
  executeSupplyPlan,
  type SupplyExecutionPorts
} from '../../src/supply/executor.js'
import type { SupplyPlan } from '../../src/supply/planner.js'

function pack(): GameKnowledgePack {
  return {
    schemaVersion: 1,
    edition: 'java',
    minecraftVersion: 'test-1.0',
    items: [
      { id: 'minecraft:stone', stackSize: 64 },
      { id: 'minecraft:cobblestone', stackSize: 64 },
      { id: 'minecraft:coal', stackSize: 64 }
    ],
    worldAcquisition: [
      {
        id: 'minecraft:mine_cobblestone',
        resource: 'minecraft:stone',
        output: {
          item: 'minecraft:cobblestone',
          count: 1
        },
        blockIds: ['minecraft:stone'],
        minimumOnePerBlock: true,
        tool: {
          class: 'pickaxe',
          minimumTier: null,
          minimumTierRank: null,
          requiredEnchantments: [],
          forbiddenEnchantments: ['silk_touch']
        }
      },
      {
        id: 'minecraft:mine_stone_silk_touch',
        resource: 'minecraft:stone',
        output: {
          item: 'minecraft:stone',
          count: 1
        },
        blockIds: ['minecraft:stone'],
        minimumOnePerBlock: true,
        tool: {
          class: 'pickaxe',
          minimumTier: null,
          minimumTierRank: null,
          requiredEnchantments: ['silk_touch'],
          forbiddenEnchantments: []
        }
      }
    ],
    recipes: [],
    processing: [{
      id: 'minecraft:smelt_stone',
      kind: 'smelting',
      input: {
        item: 'minecraft:cobblestone',
        count: 1
      },
      output: {
        item: 'minecraft:stone',
        count: 1
      },
      workstation: 'minecraft:furnace',
      cookTimeTicks: 200
    }],
    fuels: [{
      item: 'minecraft:coal',
      burnTimeTicks: 1600
    }],
    tools: [],
    workstations: [{
      id: 'minecraft:furnace',
      item: 'minecraft:furnace',
      blockIds: ['minecraft:furnace'],
      supportedKinds: ['smelting']
    }]
  }
}

class FakeProductionRuntime implements ProductionRuntime {
  readonly craftRequests: CraftItemRequest[] = []
  readonly processRequests: ProcessItemRequest[] = []

  constructor(
    private readonly inventory: Map<string, number>
  ) {}

  async craft(
    request: CraftItemRequest
  ): Promise<SkillResult> {
    this.craftRequests.push(request)
    this.inventory.set(
      request.item,
      (this.inventory.get(request.item) ?? 0) +
        request.outputCountPerBatch * request.batches
    )
    return { status: 'succeeded', code: 'crafted' }
  }

  async process(
    request: ProcessItemRequest
  ): Promise<SkillResult> {
    this.processRequests.push(request)
    this.inventory.set(
      request.output,
      (this.inventory.get(request.output) ?? 0) +
        request.outputCountPerBatch * request.batches
    )
    return { status: 'succeeded', code: 'processed' }
  }
}

function workstation(): ResolvedWorkstation {
  return {
    id: 'minecraft:furnace',
    kind: 'furnace',
    position: { x: 10, y: 64, z: 10 },
    expectedBlockNames: ['minecraft:furnace']
  }
}

function ports(
  inventory: Map<string, number>,
  overrides: Partial<SupplyExecutionPorts> = {}
): SupplyExecutionPorts {
  const production =
    new FakeProductionRuntime(inventory)

  return {
    inventoryCount(item) {
      return inventory.get(item) ?? 0
    },
    async withdrawStorage() {
      return { status: 'failed', code: 'unexpected_storage' }
    },
    async acquireResource(fact, quantity) {
      const item = fact.output.item
      inventory.set(
        item,
        (inventory.get(item) ?? 0) + quantity
      )
      return { status: 'succeeded', code: 'acquired' }
    },
    async equipTool() {
      return { status: 'succeeded', code: 'equipped' }
    },
    async resolveWorkstation(
      fact: WorkstationFact
    ) {
      return fact.id === 'minecraft:furnace'
        ? workstation()
        : null
    },
    production,
    ...overrides
  }
}

test('supply executor preserves exact stone identity through cobblestone then smelting', async () => {
  const inventory = new Map<string, number>([
    ['minecraft:coal', 8]
  ])
  const runtimePorts = ports(inventory)
  const plan: SupplyPlan = {
    requestedItem: 'minecraft:stone',
    requestedQuantity: 64,
    unresolved: [],
    steps: [
      {
        kind: 'gather',
        routeId: 'minecraft:mine_cobblestone',
        resource: 'minecraft:stone',
        item: 'minecraft:cobblestone',
        quantity: 64,
        minimumBlocks: 64
      },
      {
        kind: 'use_inventory',
        item: 'minecraft:coal',
        quantity: 8
      },
      {
        kind: 'process',
        processingId: 'minecraft:smelt_stone',
        batches: 64,
        fuelItem: 'minecraft:coal',
        fuelQuantity: 8
      }
    ]
  }

  assert.deepEqual(
    await executeSupplyPlan(
      pack(),
      plan,
      runtimePorts,
      new AbortController().signal
    ),
    {
      status: 'succeeded',
      code: 'item_acquired'
    }
  )
  assert.equal(
    inventory.get('minecraft:stone'),
    64
  )

  const production =
    runtimePorts.production as FakeProductionRuntime
  assert.deepEqual(production.processRequests, [{
    processingId: 'minecraft:smelt_stone',
    kind: 'smelting',
    input: 'minecraft:cobblestone',
    inputCountPerBatch: 1,
    output: 'minecraft:stone',
    outputCountPerBatch: 1,
    batches: 64,
    cookTimeTicks: 200,
    workstation: workstation(),
    fuel: 'minecraft:coal',
    fuelQuantity: 8
  }])
})

test('supply executor fails closed when direct world acquisition does not yield the planned exact item', async () => {
  const inventory = new Map<string, number>()
  const runtimePorts = ports(inventory, {
    async acquireResource() {
      inventory.set('minecraft:cobblestone', 1)
      return { status: 'succeeded', code: 'acquired' }
    }
  })

  const plan: SupplyPlan = {
    requestedItem: 'minecraft:stone',
    requestedQuantity: 1,
    unresolved: [],
    steps: [{
      kind: 'gather',
      routeId: 'minecraft:mine_stone_silk_touch',
      resource: 'minecraft:stone',
      item: 'minecraft:stone',
      quantity: 1,
      minimumBlocks: 1
    }]
  }

  assert.deepEqual(
    await executeSupplyPlan(
      pack(),
      plan,
      runtimePorts,
      new AbortController().signal
    ),
    {
      status: 'failed',
      code: 'world_acquisition_output_mismatch'
    }
  )
  assert.equal(
    inventory.get('minecraft:stone') ?? 0,
    0
  )
})

test('supply executor never invents or places a missing physical workstation', async () => {
  const inventory = new Map<string, number>([
    ['minecraft:cobblestone', 1],
    ['minecraft:coal', 1]
  ])
  const runtimePorts = ports(inventory, {
    async resolveWorkstation() {
      return null
    }
  })

  const plan: SupplyPlan = {
    requestedItem: 'minecraft:stone',
    requestedQuantity: 1,
    unresolved: [],
    steps: [{
      kind: 'process',
      processingId: 'minecraft:smelt_stone',
      batches: 1,
      fuelItem: 'minecraft:coal',
      fuelQuantity: 1
    }]
  }

  assert.deepEqual(
    await executeSupplyPlan(
      pack(),
      plan,
      runtimePorts,
      new AbortController().signal
    ),
    {
      status: 'failed',
      code: 'workstation_unavailable'
    }
  )

  const production =
    runtimePorts.production as FakeProductionRuntime
  assert.deepEqual(production.processRequests, [])
})

test('supply executor refuses unresolved plans before mutation', async () => {
  const inventory = new Map<string, number>()
  let gatherCalls = 0
  const runtimePorts = ports(inventory, {
    async acquireResource() {
      gatherCalls += 1
      return { status: 'succeeded', code: 'acquired' }
    }
  })

  assert.deepEqual(
    await executeSupplyPlan(
      pack(),
      {
        requestedItem: 'minecraft:stone',
        requestedQuantity: 1,
        steps: [],
        unresolved: [{
          item: 'minecraft:stone',
          quantity: 1,
          code: 'production_route_missing'
        }]
      },
      runtimePorts,
      new AbortController().signal
    ),
    {
      status: 'failed',
      code: 'production_route_missing'
    }
  )
  assert.equal(gatherCalls, 0)
})
