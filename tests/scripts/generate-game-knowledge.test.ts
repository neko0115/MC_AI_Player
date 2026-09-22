import assert from 'node:assert/strict'
import test from 'node:test'
import {
  generateProductionKnowledge,
  normalizeItems,
  normalizeRecipes,
  normalizeVanillaProcessingRecipes,
  normalizeWorldAcquisition,
  type ProductionMinecraftData
} from '../../scripts/generate-game-knowledge.js'

const data: ProductionMinecraftData = {
  itemsArray: [
    { id: 1, name: 'stone', stackSize: 64 },
    { id: 2, name: 'cobblestone', stackSize: 64 },
    {
      id: 3,
      name: 'ender_pearl',
      stackSize: 16
    },
    {
      id: 4,
      name: 'oak_log',
      stackSize: 64
    },
    {
      id: 5,
      name: 'oak_planks',
      stackSize: 64
    },
    {
      id: 6,
      name: 'crafting_table',
      stackSize: 64
    },
    {
      id: 7,
      name: 'wooden_pickaxe',
      stackSize: 1,
      maxDurability: 59
    }
  ],
  blocksArray: [
    {
      id: 1,
      name: 'stone',
      drops: [2],
      material: 'mineable/pickaxe',
      harvestTools: { '7': true }
    },
    {
      id: 2,
      name: 'chance_block',
      drops: [{
        drop: 3,
        minCount: 0.1,
        maxCount: 1
      }]
    }
  ],
  recipes: {
    5: [{
      result: { id: 5, count: 4 },
      inShape: [[4]]
    }],
    6: [{
      result: { id: 6, count: 1 },
      inShape: [
        [5, 5],
        [5, 5]
      ]
    }]
  }
}

test('item normalization preserves authoritative max stack sizes', () => {
  const items = normalizeItems(data.itemsArray)

  assert.equal(
    items.find(item => item.id === 'minecraft:stone')
      ?.stackSize,
    64
  )
  assert.equal(
    items.find(item => item.id === 'minecraft:ender_pearl')
      ?.stackSize,
    16
  )
  assert.equal(
    items.find(item => item.id === 'minecraft:wooden_pickaxe')
      ?.stackSize,
    1
  )
})

test('crafting normalization emits exact input/output batches and workstation ids', () => {
  const names = new Map(
    data.itemsArray.map(item => [item.id, item.name] as const)
  )
  const recipes = normalizeRecipes(data.recipes, names)

  assert.deepEqual(
    recipes.find(
      recipe => recipe.output.item === 'minecraft:oak_planks'
    ),
    {
      id: 'minecraft:craft/oak_planks/0',
      output: {
        item: 'minecraft:oak_planks',
        count: 4
      },
      inputs: [{
        item: 'minecraft:oak_log',
        count: 1
      }],
      workstation: 'minecraft:inventory_crafting'
    }
  )
  assert.equal(
    recipes.find(
      recipe => recipe.output.item === 'minecraft:crafting_table'
    )?.workstation,
    'minecraft:inventory_crafting'
  )
})

test('world acquisition only emits deterministic minimum-one drops and exact harvest tool ids', () => {
  const names = new Map(
    data.itemsArray.map(item => [item.id, item.name] as const)
  )
  const facts = normalizeWorldAcquisition(
    data.blocksArray,
    names
  )

  assert.deepEqual(facts, [{
    id: 'minecraft:mine/stone/cobblestone',
    resource: 'minecraft:stone',
    output: {
      item: 'minecraft:cobblestone',
      count: 1
    },
    blockIds: ['minecraft:stone'],
    minimumOnePerBlock: true,
    tool: {
      acceptedItems: ['minecraft:wooden_pickaxe'],
      class: 'pickaxe',
      minimumTier: null,
      minimumTierRank: null,
      requiredEnchantments: [],
      forbiddenEnchantments: ['silk_touch']
    }
  }])
})

test('reviewed overlays add mechanics that minecraft-data cannot prove without code special cases', () => {
  const pack = generateProductionKnowledge(
    'test-1.0',
    data,
    {
      worldAcquisition: [{
        id: 'minecraft:mine/stone/stone_silk_touch',
        resource: 'minecraft:stone',
        output: {
          item: 'minecraft:stone',
          count: 1
        },
        blockIds: ['minecraft:stone'],
        minimumOnePerBlock: true,
        tool: {
          acceptedItems: ['minecraft:wooden_pickaxe'],
          class: 'pickaxe',
          minimumTier: null,
          minimumTierRank: null,
          requiredEnchantments: ['silk_touch'],
          forbiddenEnchantments: []
        }
      }],
      processing: [{
        id: 'minecraft:smelt/stone',
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
        item: 'minecraft:oak_planks',
        burnTimeTicks: 300
      }],
      workstations: [{
        id: 'minecraft:furnace',
        item: null,
        blockIds: ['minecraft:furnace'],
        supportedKinds: ['smelting']
      }]
    }
  )

  assert.equal(
    pack.worldAcquisition.some(
      fact =>
        fact.output.item === 'minecraft:stone' &&
        fact.tool.requiredEnchantments.includes('silk_touch')
    ),
    true
  )
  assert.equal(
    pack.processing[0]?.input.item,
    'minecraft:cobblestone'
  )
})

test('overlay ids cannot silently replace generated facts', () => {
  assert.throws(
    () => generateProductionKnowledge(
      'test-1.0',
      data,
      {
        worldAcquisition: [{
          id: 'minecraft:mine/stone/cobblestone',
          resource: 'minecraft:stone',
          output: {
            item: 'minecraft:stone',
            count: 1
          },
          blockIds: ['minecraft:stone'],
          minimumOnePerBlock: true,
          tool: {
            class: null,
            minimumTier: null,
            minimumTierRank: null,
            requiredEnchantments: [],
            forbiddenEnchantments: []
          }
        }]
      }
    ),
    /knowledge_overlay_duplicate_world_acquisition/
  )
})


test('mcmeta-style processing summary expands item tags into exact routes', () => {
  const facts = normalizeVanillaProcessingRecipes(
    {
      stone: {
        type: 'minecraft:smelting',
        cookingtime: 200,
        ingredient: {
          item: 'minecraft:cobblestone'
        },
        result: {
          id: 'minecraft:stone'
        }
      },
      smooth_stone: {
        type: 'minecraft:stonecutting',
        ingredient: {
          tag: 'minecraft:test_stones'
        },
        result: {
          id: 'minecraft:smooth_stone',
          count: 2
        }
      }
    },
    {
      test_stones: {
        values: [
          'minecraft:stone',
          '#minecraft:nested_stones'
        ]
      },
      nested_stones: {
        values: [
          'minecraft:andesite'
        ]
      }
    }
  )

  assert.deepEqual(facts, [
    {
      id: 'minecraft:process/smooth_stone/0',
      kind: 'stonecutting',
      input: {
        item: 'minecraft:andesite',
        count: 1
      },
      output: {
        item: 'minecraft:smooth_stone',
        count: 2
      },
      workstation: 'minecraft:stonecutter',
      cookTimeTicks: null
    },
    {
      id: 'minecraft:process/smooth_stone/1',
      kind: 'stonecutting',
      input: {
        item: 'minecraft:stone',
        count: 1
      },
      output: {
        item: 'minecraft:smooth_stone',
        count: 2
      },
      workstation: 'minecraft:stonecutter',
      cookTimeTicks: null
    },
    {
      id: 'minecraft:process/stone/0',
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
    }
  ])
})

test('processing import rejects unresolved or cyclic item tags instead of inventing inputs', () => {
  assert.throws(
    () => normalizeVanillaProcessingRecipes(
      {
        unsafe: {
          type: 'minecraft:smelting',
          ingredient: {
            tag: 'minecraft:a'
          },
          result: {
            id: 'minecraft:stone'
          }
        }
      },
      {
        a: { values: ['#minecraft:b'] },
        b: { values: ['#minecraft:a'] }
      }
    ),
    /vanilla_item_tag_cycle/
  )
})

test('default workstations include supported physical production blocks when their items exist', () => {
  const extended: ProductionMinecraftData = {
    ...data,
    itemsArray: [
      ...data.itemsArray,
      { id: 8, name: 'furnace', stackSize: 64 },
      { id: 9, name: 'blast_furnace', stackSize: 64 },
      { id: 10, name: 'smoker', stackSize: 64 },
      { id: 11, name: 'stonecutter', stackSize: 64 }
    ]
  }

  const pack = generateProductionKnowledge(
    'test-1.0',
    extended
  )

  assert.deepEqual(
    pack.workstations
      .filter(fact =>
        fact.id !== 'minecraft:inventory_crafting' &&
        fact.id !== 'minecraft:crafting_table'
      )
      .map(fact => fact.id),
    [
      'minecraft:blast_furnace',
      'minecraft:furnace',
      'minecraft:smoker',
      'minecraft:stonecutter'
    ]
  )
})
