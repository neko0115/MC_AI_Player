import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { Bot } from 'mineflayer'
import {
  MineflayerProductionRuntime,
  createMineflayerProductionExtension
} from '../../src/minecraft/mineflayer-production.js'
import {
  PRODUCTION_RUNTIME_PORT,
  type CraftItemRequest,
  type ProcessItemRequest
} from '../../src/minecraft/production.js'
import {
  RuntimePortRegistry
} from '../../src/minecraft/runtime-ports.js'

interface FakeItem {
  readonly name: string
  readonly count: number
  readonly type: number
  readonly metadata: number
}

class FakeFurnace {
  closeCount = 0
  putInputCalls: unknown[][] = []
  putFuelCalls: unknown[][] = []
  output: FakeItem | null = null
  input: FakeItem | null = null
  fuel: FakeItem | null = null

  inputItem() {
    return this.input
  }

  fuelItem() {
    return this.fuel
  }

  outputItem() {
    return this.output
  }

  async putInput(...args: unknown[]) {
    this.putInputCalls.push(args)
  }

  async putFuel(...args: unknown[]) {
    this.putFuelCalls.push(args)
  }

  async takeOutput() {
    const item = this.output
    this.output = null
    return item
  }

  async close() {
    this.closeCount += 1
  }
}

class FakeBot extends EventEmitter {
  readonly entity = {
    position: {
      x: 0,
      y: 64,
      z: 0,
      clone() {
        return {
          x: 0,
          y: 64,
          z: 0,
          set(x: number, y: number, z: number) {
            this.x = x
            this.y = y
            this.z = z
            return this
          }
        }
      }
    }
  }

  readonly registry = {
    itemsByName: {
      oak_log: { id: 1, name: 'oak_log' },
      birch_log: { id: 2, name: 'birch_log' },
      oak_planks: { id: 3, name: 'oak_planks' },
      cobblestone: { id: 4, name: 'cobblestone' },
      stone: { id: 5, name: 'stone' },
      coal: { id: 6, name: 'coal' }
    },
    items: {
      1: { id: 1, name: 'oak_log' },
      2: { id: 2, name: 'birch_log' },
      3: { id: 3, name: 'oak_planks' },
      4: { id: 4, name: 'cobblestone' },
      5: { id: 5, name: 'stone' },
      6: { id: 6, name: 'coal' }
    }
  }

  readonly furnace = new FakeFurnace()
  inventoryStacks: FakeItem[] = []
  blockName = 'crafting_table'
  craftCalls: Array<{ recipe: unknown; count: number; table: unknown }> = []
  recipes: unknown[] = []
  openFurnaceCount = 0

  readonly inventory = {
    items: () => this.inventoryStacks
  }

  blockAt() {
    return { name: this.blockName }
  }

  recipesFor() {
    return this.recipes
  }

  async craft(recipe: unknown, count: number, table?: unknown) {
    this.craftCalls.push({ recipe, count, table })
    const current = this.inventoryStacks.find(
      item => item.name === 'oak_planks'
    )
    const produced = count * 4
    this.inventoryStacks = [
      ...this.inventoryStacks.filter(
        item => item.name !== 'oak_planks'
      ),
      {
        name: 'oak_planks',
        count: (current?.count ?? 0) + produced,
        type: 3,
        metadata: 0
      }
    ]
  }

  async openFurnace() {
    this.openFurnaceCount += 1
    return this.furnace
  }
}

function craftRequest(): CraftItemRequest {
  return {
    recipeId: 'minecraft:oak_planks_from_oak_log',
    item: 'minecraft:oak_planks',
    outputCountPerBatch: 4,
    inputs: [{ item: 'minecraft:oak_log', count: 1 }],
    batches: 2,
    workstation: null
  }
}

function processRequest(): ProcessItemRequest {
  return {
    processingId: 'minecraft:smelt_stone',
    kind: 'smelting',
    input: 'minecraft:cobblestone',
    inputCountPerBatch: 1,
    output: 'minecraft:stone',
    outputCountPerBatch: 1,
    batches: 2,
    cookTimeTicks: 200,
    workstation: {
      id: 'minecraft:furnace',
      kind: 'furnace',
      position: { x: 2, y: 64, z: 3 },
      expectedBlockNames: ['minecraft:furnace']
    },
    fuel: 'minecraft:coal',
    fuelQuantity: 1
  }
}

test('craft executes the planner-selected recipe shape rather than the first output match', async () => {
  const bot = new FakeBot()
  const wrongRecipe = {
    result: { id: 3, count: 4 },
    ingredients: [{ id: 2, count: 1 }]
  }
  const selectedRecipe = {
    result: { id: 3, count: 4 },
    ingredients: [{ id: 1, count: 1 }]
  }
  bot.recipes = [wrongRecipe, selectedRecipe]
  bot.inventoryStacks = [
    { name: 'oak_log', count: 2, type: 1, metadata: 0 }
  ]

  const runtime = new MineflayerProductionRuntime(
    () => bot as unknown as Bot
  )

  assert.deepEqual(
    await runtime.craft(
      craftRequest(),
      new AbortController().signal
    ),
    { status: 'succeeded', code: 'crafted' }
  )
  assert.equal(bot.craftCalls.length, 1)
  assert.equal(bot.craftCalls[0]?.recipe, selectedRecipe)
  assert.equal(bot.craftCalls[0]?.count, 2)
})

test('craft fails closed when the exact selected recipe shape is unavailable', async () => {
  const bot = new FakeBot()
  bot.recipes = [{
    result: { id: 3, count: 4 },
    ingredients: [{ id: 2, count: 1 }]
  }]

  const runtime = new MineflayerProductionRuntime(
    () => bot as unknown as Bot
  )

  assert.deepEqual(
    await runtime.craft(
      craftRequest(),
      new AbortController().signal
    ),
    {
      status: 'failed',
      code: 'selected_recipe_unavailable'
    }
  )
  assert.equal(bot.craftCalls.length, 0)
})

test('processing uses only the resolved workstation and exact input/fuel quantities', async () => {
  const bot = new FakeBot()
  bot.blockName = 'furnace'
  bot.inventoryStacks = [
    {
      name: 'cobblestone',
      count: 2,
      type: 4,
      metadata: 0
    },
    { name: 'coal', count: 1, type: 6, metadata: 0 }
  ]
  bot.furnace.output = {
    name: 'stone',
    count: 2,
    type: 5,
    metadata: 0
  }

  const runtime = new MineflayerProductionRuntime(
    () => bot as unknown as Bot,
    {
      pollIntervalMs: 1,
      sleep: async () => {}
    }
  )

  assert.deepEqual(
    await runtime.process(
      processRequest(),
      new AbortController().signal
    ),
    { status: 'succeeded', code: 'processed' }
  )
  assert.equal(bot.openFurnaceCount, 1)
  assert.deepEqual(
    bot.furnace.putInputCalls,
    [[4, null, 2]]
  )
  assert.deepEqual(
    bot.furnace.putFuelCalls,
    [[6, null, 1]]
  )
  assert.equal(bot.furnace.closeCount, 1)
})

test('processing refuses a busy workstation before inserting planned materials', async () => {
  const bot = new FakeBot()
  bot.blockName = 'furnace'
  bot.inventoryStacks = [
    {
      name: 'cobblestone',
      count: 2,
      type: 4,
      metadata: 0
    },
    { name: 'coal', count: 1, type: 6, metadata: 0 }
  ]
  bot.furnace.input = {
    name: 'sand',
    count: 1,
    type: 12,
    metadata: 0
  }

  const runtime = new MineflayerProductionRuntime(
    () => bot as unknown as Bot
  )

  assert.deepEqual(
    await runtime.process(
      processRequest(),
      new AbortController().signal
    ),
    { status: 'failed', code: 'workstation_busy' }
  )
  assert.deepEqual(bot.furnace.putInputCalls, [])
  assert.deepEqual(bot.furnace.putFuelCalls, [])
  assert.equal(bot.furnace.closeCount, 1)
})

test('abort while waiting for processing output closes the furnace and returns cancelled', async () => {
  const bot = new FakeBot()
  bot.blockName = 'furnace'
  bot.inventoryStacks = [
    {
      name: 'cobblestone',
      count: 2,
      type: 4,
      metadata: 0
    },
    { name: 'coal', count: 1, type: 6, metadata: 0 }
  ]

  let releaseSleep: (() => void) | null = null
  const runtime = new MineflayerProductionRuntime(
    () => bot as unknown as Bot,
    {
      pollIntervalMs: 1,
      sleep: () =>
        new Promise<void>(resolve => {
          releaseSleep = resolve
        })
    }
  )
  const controller = new AbortController()

  const pending = runtime.process(
    processRequest(),
    controller.signal
  )
  while (releaseSleep === null) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  controller.abort('threat_suspended')
  releaseSleep?.()

  assert.deepEqual(
    await pending,
    {
      status: 'cancelled',
      code: 'threat_suspended'
    }
  )
  assert.equal(bot.furnace.closeCount, 1)
})

test('stonecutting stays fail-closed until a reviewed runtime adapter exists', async () => {
  const bot = new FakeBot()
  const runtime = new MineflayerProductionRuntime(
    () => bot as unknown as Bot
  )

  assert.deepEqual(
    await runtime.process(
      {
        processingId: 'minecraft:cut_stone',
        kind: 'stonecutting',
        input: 'minecraft:stone',
        inputCountPerBatch: 1,
        output: 'minecraft:stone',
        outputCountPerBatch: 1,
        batches: 1,
        cookTimeTicks: null,
        workstation: {
          id: 'minecraft:stonecutter',
          kind: 'stonecutter',
          position: { x: 2, y: 64, z: 3 },
          expectedBlockNames: ['minecraft:stonecutter']
        }
      },
      new AbortController().signal
    ),
    {
      status: 'failed',
      code: 'stonecutting_runtime_unavailable'
    }
  )
  assert.equal(bot.openFurnaceCount, 0)
})


test('production runtime extension registers only the typed production port', () => {
  const ports = new RuntimePortRegistry()
  const extension = createMineflayerProductionExtension()

  extension.install({
    readyBot: () => null,
    ports
  })

  assert.equal(ports.has(PRODUCTION_RUNTIME_PORT), true)
  assert.deepEqual(
    ports.registeredIds(),
    ['minecraft.production']
  )
})
