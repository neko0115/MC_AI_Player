import assert from 'node:assert/strict'
import test from 'node:test'
import {
  expandProductionRequirement,
  productionRoutesFor,
  type ProductionRoute
} from '../../src/knowledge/graph.js'
import type { GameKnowledgePack } from '../../src/knowledge/contracts.js'

function pack(): GameKnowledgePack {
  return {
    schemaVersion: 1,
    edition: 'java',
    minecraftVersion: 'test-1.0',
    items: [
      { id: 'minecraft:stone', stackSize: 64 },
      { id: 'minecraft:cobblestone', stackSize: 64 },
      { id: 'minecraft:coal', stackSize: 64 },
      { id: 'minecraft:smooth_stone', stackSize: 64 }
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
          minimumTierRank: null,
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
          minimumTierRank: null,
          requiredEnchantments: ['silk_touch'],
          forbiddenEnchantments: []
        }
      }
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
      },
      {
        id: 'minecraft:smelt_smooth_stone',
        kind: 'smelting',
        input: { item: 'minecraft:stone', count: 1 },
        output: { item: 'minecraft:smooth_stone', count: 1 },
        workstation: 'minecraft:furnace',
        cookTimeTicks: 200
      }
    ],
    fuels: [
      { item: 'minecraft:coal', burnTimeTicks: 1600 }
    ],
    tools: [],
    workstations: [
      {
        id: 'minecraft:furnace',
        blockIds: ['minecraft:furnace'],
        supportedKinds: ['smelting']
      }
    ]
  }
}

test('stone routes preserve exact output identity', () => {
  const routes = productionRoutesFor(pack(), 'minecraft:stone')

  assert.deepEqual(
    routes.map(route => [route.kind, route.fact.id]),
    [
      ['world', 'minecraft:mine_stone_silk_touch'],
      ['process', 'minecraft:smelt_stone']
    ]
  )

  assert.equal(
    routes.some(route =>
      route.kind === 'world' &&
      route.fact.id === 'minecraft:mine_cobblestone'
    ),
    false
  )
})

test('planner can choose cobblestone -> smelting -> exact stone when silk touch route is unavailable', () => {
  const selectRoute = (
    item: string,
    _quantity: number,
    routes: readonly ProductionRoute[]
  ): ProductionRoute | undefined => {
    if (item === 'minecraft:stone') {
      return routes.find(route => route.kind === 'process')
    }
    return routes[0]
  }

  const result = expandProductionRequirement(
    pack(),
    'minecraft:stone',
    64,
    { selectRoute }
  )

  assert.equal(result.item, 'minecraft:stone')
  assert.equal(result.route.kind, 'process')
  assert.equal(result.batches, 64)
  assert.equal(result.children.length, 1)
  assert.equal(result.children[0]?.item, 'minecraft:cobblestone')
  assert.equal(result.children[0]?.route.kind, 'world')
})

test('multi-stage processing remains generic', () => {
  const result = expandProductionRequirement(
    pack(),
    'minecraft:smooth_stone',
    8,
    {
      selectRoute(item, _quantity, routes) {
        if (item === 'minecraft:stone') {
          return routes.find(route => route.kind === 'process')
        }
        return routes[0]
      }
    }
  )

  assert.equal(result.route.kind, 'process')
  assert.equal(result.children[0]?.item, 'minecraft:stone')
  assert.equal(
    result.children[0]?.children[0]?.item,
    'minecraft:cobblestone'
  )
})

test('missing authoritative route fails closed instead of inventing direct gathering', () => {
  assert.throws(
    () => expandProductionRequirement(
      pack(),
      'minecraft:coal',
      1
    ),
    /production_route_missing:minecraft:coal/
  )
})

test('production graph detects cycles', () => {
  const cyclic: GameKnowledgePack = {
    ...pack(),
    items: [
      ...pack().items,
      { id: 'test:a', stackSize: 64 },
      { id: 'test:b', stackSize: 64 }
    ],
    recipes: [
      {
        id: 'test:a_from_b',
        output: { item: 'test:a', count: 1 },
        inputs: [{ item: 'test:b', count: 1 }],
        workstation: 'minecraft:furnace'
      },
      {
        id: 'test:b_from_a',
        output: { item: 'test:b', count: 1 },
        inputs: [{ item: 'test:a', count: 1 }],
        workstation: 'minecraft:furnace'
      }
    ]
  }

  assert.throws(
    () => expandProductionRequirement(cyclic, 'test:a', 1),
    /production_cycle_detected:test:a/
  )
})
