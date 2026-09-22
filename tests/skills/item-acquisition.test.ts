import assert from 'node:assert/strict'
import test from 'node:test'
import type { SkillResult } from '../../src/contracts/skills.js'
import type { GameKnowledgePack } from '../../src/knowledge/contracts.js'
import type {
  CraftItemRequest,
  ProcessItemRequest,
  ProductionRuntime
} from '../../src/minecraft/production.js'
import { AcquireItemSkill } from '../../src/skills/item-acquisition.js'
import type { SupplyExecutionPorts } from '../../src/supply/executor.js'

class NoMutationProduction implements ProductionRuntime {
  async craft(
    _request: CraftItemRequest
  ): Promise<SkillResult> {
    throw new Error('unexpected craft')
  }

  async process(
    _request: ProcessItemRequest
  ): Promise<SkillResult> {
    throw new Error('unexpected process')
  }
}

function knowledge(): GameKnowledgePack {
  return {
    schemaVersion: 1,
    edition: 'java',
    minecraftVersion: 'test-1.0',
    items: [
      { id: 'minecraft:stone', stackSize: 64 },
      { id: 'minecraft:ender_pearl', stackSize: 16 },
      { id: 'minecraft:diamond_pickaxe', stackSize: 1 }
    ],
    worldAcquisition: [],
    recipes: [],
    processing: [],
    fuels: [],
    tools: [],
    workstations: []
  }
}

function execution(
  inventory: Readonly<Record<string, number>>
): SupplyExecutionPorts {
  return {
    inventoryCount(item) {
      return inventory[item] ?? 0
    },
    async withdrawStorage() {
      throw new Error('unexpected storage')
    },
    async acquireResource() {
      throw new Error('unexpected world acquisition')
    },
    async equipTool() {
      throw new Error('unexpected equip')
    },
    async resolveWorkstation() {
      throw new Error('unexpected workstation')
    },
    production: new NoMutationProduction()
  }
}

test('acquire_item resolves one stack from authoritative per-item stack size', async () => {
  const inventory = {
    'minecraft:ender_pearl': 16
  }
  const skill = new AcquireItemSkill({
    knowledge: knowledge(),
    planningState: () => ({
      inventory,
      storages: [],
      tools: [],
      workstations: []
    }),
    execution: execution(inventory)
  })

  assert.deepEqual(
    await skill.execute(
      { signal: new AbortController().signal },
      {
        item: 'minecraft:ender_pearl',
        quantity: 1,
        unit: 'stacks'
      }
    ),
    {
      status: 'succeeded',
      code: 'item_acquired'
    }
  )
})

test('acquire_item does not assume stack size 64 for unstackable items', async () => {
  const inventory = {
    'minecraft:diamond_pickaxe': 1
  }
  const skill = new AcquireItemSkill({
    knowledge: knowledge(),
    planningState: () => ({
      inventory,
      storages: [],
      tools: [],
      workstations: []
    }),
    execution: execution(inventory)
  })

  assert.deepEqual(
    await skill.execute(
      { signal: new AbortController().signal },
      {
        item: 'minecraft:diamond_pickaxe',
        quantity: 1,
        unit: 'stacks'
      }
    ),
    {
      status: 'succeeded',
      code: 'item_acquired'
    }
  )
})

test('acquire_item fails closed for an item absent from exact-version knowledge', async () => {
  const skill = new AcquireItemSkill({
    knowledge: knowledge(),
    planningState: () => ({
      inventory: {},
      storages: [],
      tools: [],
      workstations: []
    }),
    execution: execution({})
  })

  assert.deepEqual(
    await skill.execute(
      { signal: new AbortController().signal },
      {
        item: 'examplemod:unknown_ingot',
        quantity: 1,
        unit: 'items'
      }
    ),
    {
      status: 'failed',
      code: 'item_fact_missing'
    }
  )
})

test('acquire_item bounds the resolved item count after stack expansion', async () => {
  const skill = new AcquireItemSkill({
    knowledge: knowledge(),
    planningState: () => ({
      inventory: {},
      storages: [],
      tools: [],
      workstations: []
    }),
    execution: execution({})
  })

  assert.deepEqual(
    await skill.execute(
      { signal: new AbortController().signal },
      {
        item: 'minecraft:stone',
        quantity: 37,
        unit: 'stacks'
      }
    ),
    {
      status: 'failed',
      code: 'invalid_quantity'
    }
  )
})
