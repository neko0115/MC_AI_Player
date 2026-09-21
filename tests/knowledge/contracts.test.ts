import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseGameKnowledgePack,
  resolveItemQuantity,
  type GameKnowledgePack
} from '../../src/knowledge/contracts.js'

function basePack(): GameKnowledgePack {
  return {
    schemaVersion: 1,
    edition: 'java',
    minecraftVersion: 'test-1.0',
    items: [
      { id: 'minecraft:stone', stackSize: 64 },
      { id: 'minecraft:cobblestone', stackSize: 64 },
      { id: 'minecraft:ender_pearl', stackSize: 16 },
      { id: 'minecraft:diamond_pickaxe', stackSize: 1 },
      { id: 'minecraft:coal', stackSize: 64 }
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

test('one stack resolves from authoritative item stack size instead of fixed 64', () => {
  const pack = basePack()

  assert.equal(
    resolveItemQuantity(pack, 'minecraft:stone', {
      kind: 'stacks',
      stacks: 1
    }),
    64
  )
  assert.equal(
    resolveItemQuantity(pack, 'ender_pearl', {
      kind: 'stacks',
      stacks: 1
    }),
    16
  )
  assert.equal(
    resolveItemQuantity(pack, 'minecraft:diamond_pickaxe', {
      kind: 'stacks',
      stacks: 1
    }),
    1
  )
})

test('unknown stack-size knowledge fails closed', () => {
  assert.throws(
    () => resolveItemQuantity(basePack(), 'minecraft:unknown_item', {
      kind: 'stacks',
      stacks: 1
    }),
    /item_fact_missing:minecraft:unknown_item/
  )
})

test('knowledge validation rejects unknown item references', () => {
  const pack = basePack()
  assert.throws(
    () => parseGameKnowledgePack({
      ...pack,
      processing: [{
        ...pack.processing[0],
        output: {
          item: 'minecraft:not_in_items',
          count: 1
        }
      }]
    }),
    /knowledge_unknown_item/
  )
})

test('knowledge validation rejects duplicate authoritative route ids', () => {
  const pack = basePack()
  assert.throws(
    () => parseGameKnowledgePack({
      ...pack,
      worldAcquisition: [
        ...pack.worldAcquisition,
        pack.worldAcquisition[0]
      ]
    }),
    /knowledge_duplicate_world_acquisition/
  )
})

test('knowledge validation requires namespaced authoritative ids', () => {
  const pack = basePack()
  assert.throws(
    () => parseGameKnowledgePack({
      ...pack,
      items: [
        ...pack.items,
        { id: 'bare_item', stackSize: 64 }
      ]
    })
  )
})
