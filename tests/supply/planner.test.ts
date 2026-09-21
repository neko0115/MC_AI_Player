import assert from 'node:assert/strict'
import test from 'node:test'
import type { GameKnowledgePack } from '../../src/knowledge/contracts.js'
import {
  planItemAcquisition,
  type SupplyPlanningState
} from '../../src/supply/planner.js'

function pack(): GameKnowledgePack {
  return {
    schemaVersion: 1,
    edition: 'java',
    minecraftVersion: 'test-1.0',
    items: [
      { id: 'minecraft:stone', stackSize: 64 },
      { id: 'minecraft:cobblestone', stackSize: 64 },
      { id: 'minecraft:coal', stackSize: 64 },
      { id: 'minecraft:ender_pearl', stackSize: 16 },
      { id: 'minecraft:diamond_pickaxe', stackSize: 1 }
    ],
    worldAcquisition: [
      {
        id: 'minecraft:mine_cobblestone',
        resource: 'minecraft:stone',
        output: { item: 'minecraft:cobblestone', count: 1 },
        blockIds: ['minecraft:stone'],
        minimumOnePerBlock: true,
        tool: {
          class: 'pickaxe',
          minimumTier: null,
          minimumTierRank: 0,
          requiredEnchantments: [],
          forbiddenEnchantments: ['silk_touch']
        }
      },
      {
        id: 'minecraft:mine_stone_silk_touch',
        resource: 'minecraft:stone',
        output: { item: 'minecraft:stone', count: 1 },
        blockIds: ['minecraft:stone'],
        minimumOnePerBlock: true,
        tool: {
          class: 'pickaxe',
          minimumTier: null,
          minimumTierRank: 0,
          requiredEnchantments: ['silk_touch'],
          forbiddenEnchantments: []
        }
      },
      {
        id: 'minecraft:gather_coal',
        resource: 'minecraft:coal_ore',
        output: { item: 'minecraft:coal', count: 1 },
        blockIds: [
          'minecraft:coal_ore',
          'minecraft:deepslate_coal_ore'
        ],
        minimumOnePerBlock: true,
        tool: {
          class: 'pickaxe',
          minimumTier: null,
          minimumTierRank: 0,
          requiredEnchantments: [],
          forbiddenEnchantments: ['silk_touch']
        }
      },
    ],
    recipes: [],
    processing: [
      {
        id: 'minecraft:smelt_stone',
        kind: 'smelting',
        input: { item: 'minecraft:cobblestone', count: 1 },
        output: { item: 'minecraft:stone', count: 1 },
        workstation: 'minecraft:furnace',
        cookTimeTicks: 200
      }
    ],
    fuels: [
      { item: 'minecraft:coal', burnTimeTicks: 1600 }
    ],
    tools: [
      {
        item: 'minecraft:diamond_pickaxe',
        class: 'pickaxe',
        tier: 'diamond',
        tierRank: 3,
        maxDurability: 1561
      }
    ],
    workstations: [
      {
        id: 'minecraft:furnace',
        item: null,
        blockIds: ['minecraft:furnace'],
        supportedKinds: ['smelting']
      }
    ]
  }
}

function state(
  overrides: Partial<SupplyPlanningState> = {}
): SupplyPlanningState {
  return {
    inventory: { 'minecraft:coal': 64 },
    storages: [],
    tools: [{
      item: 'minecraft:diamond_pickaxe',
      enchantments: []
    }],
    workstations: ['minecraft:furnace'],
    ...overrides
  }
}

test('one stack uses item max stack size in the high-level acquisition plan', () => {
  const plan = planItemAcquisition(
    pack(),
    'minecraft:ender_pearl',
    { kind: 'stacks', stacks: 1 },
    state({
      inventory: {
        'minecraft:ender_pearl': 16,
        'minecraft:coal': 64
      }
    })
  )

  assert.equal(plan.requestedQuantity, 16)
  assert.equal(plan.unresolved.length, 0)
  assert.deepEqual(plan.steps, [{
    kind: 'use_inventory',
    item: 'minecraft:ender_pearl',
    quantity: 16
  }])
})

test('stone without Silk Touch plans cobblestone then smelting and never substitutes final identity', () => {
  const plan = planItemAcquisition(
    pack(),
    'minecraft:stone',
    { kind: 'stacks', stacks: 1 },
    state()
  )

  assert.equal(plan.requestedItem, 'minecraft:stone')
  assert.equal(plan.requestedQuantity, 64)
  assert.equal(plan.unresolved.length, 0)

  const gather = plan.steps.find(step => step.kind === 'gather')
  assert.deepEqual(gather, {
    kind: 'gather',
    routeId: 'minecraft:mine_cobblestone',
    resource: 'minecraft:stone',
    item: 'minecraft:cobblestone',
    quantity: 64,
    minimumBlocks: 64
  })

  assert.equal(
    plan.steps.some(step =>
      step.kind === 'gather' &&
      step.item === 'minecraft:stone'
    ),
    false
  )
  assert.deepEqual(
    plan.steps.at(-1),
    {
      kind: 'process',
      processingId: 'minecraft:smelt_stone',
      batches: 64,
      fuelItem: 'minecraft:coal',
      fuelQuantity: 8
    }
  )
})

test('stone with a Silk Touch tool can use the exact direct route', () => {
  const plan = planItemAcquisition(
    pack(),
    'minecraft:stone',
    { kind: 'exact', quantity: 8 },
    state({
      tools: [{
        item: 'minecraft:diamond_pickaxe',
        enchantments: ['silk_touch']
      }]
    })
  )

  assert.equal(plan.unresolved.length, 0)
  assert.deepEqual(
    plan.steps,
    [{
      kind: 'gather',
      routeId: 'minecraft:mine_stone_silk_touch',
      resource: 'minecraft:stone',
      item: 'minecraft:stone',
      quantity: 8,
      minimumBlocks: 8
    }]
  )
})

test('inventory and authorized storage are consumed before production routes', () => {
  const plan = planItemAcquisition(
    pack(),
    'minecraft:stone',
    { kind: 'exact', quantity: 10 },
    state({
      inventory: {
        'minecraft:stone': 3,
        'minecraft:coal': 64
      },
      storages: [{
        id: 'project-chest',
        items: { 'minecraft:stone': 7 }
      }]
    })
  )

  assert.deepEqual(plan.unresolved, [])
  assert.deepEqual(plan.steps, [
    {
      kind: 'use_inventory',
      item: 'minecraft:stone',
      quantity: 3
    },
    {
      kind: 'withdraw_storage',
      storageId: 'project-chest',
      item: 'minecraft:stone',
      quantity: 7
    }
  ])
})

test('unknown mutation-critical item fails closed instead of inventing a gather route', () => {
  const unknownPack: GameKnowledgePack = {
    ...pack(),
    items: [
      ...pack().items,
      { id: 'examplemod:mystery_ingot', stackSize: 64 }
    ]
  }

  const plan = planItemAcquisition(
    unknownPack,
    'examplemod:mystery_ingot',
    { kind: 'exact', quantity: 1 },
    state()
  )

  assert.deepEqual(plan.steps, [])
  assert.deepEqual(plan.unresolved, [{
    item: 'examplemod:mystery_ingot',
    quantity: 1,
    code: 'production_route_missing'
  }])
})
