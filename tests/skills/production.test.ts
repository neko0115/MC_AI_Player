import assert from 'node:assert/strict'
import test from 'node:test'
import type { SkillResult } from '../../src/contracts/skills.js'
import type {
  CraftItemRequest,
  ProcessItemRequest,
  ProductionRuntime
} from '../../src/minecraft/production.js'
import {
  CraftItemSkill,
  ProcessItemSkill
} from '../../src/skills/production.js'

class FakeRuntime implements ProductionRuntime {
  craftCalls: CraftItemRequest[] = []
  processCalls: ProcessItemRequest[] = []

  async craft(
    request: CraftItemRequest
  ): Promise<SkillResult> {
    this.craftCalls.push(request)
    return { status: 'succeeded', code: 'crafted' }
  }

  async process(
    request: ProcessItemRequest
  ): Promise<SkillResult> {
    this.processCalls.push(request)
    return { status: 'succeeded', code: 'processed' }
  }
}

test('craft skill forwards one exact chosen recipe and batch count', async () => {
  const runtime = new FakeRuntime()
  const skill = new CraftItemSkill(runtime)
  const signal = new AbortController().signal

  assert.deepEqual(
    await skill.execute({ signal }, {
      recipeId: 'minecraft:oak_planks',
      item: 'minecraft:oak_planks',
      batches: 4,
      workstation: null
    }),
    { status: 'succeeded', code: 'crafted' }
  )
  assert.deepEqual(runtime.craftCalls, [{
    recipeId: 'minecraft:oak_planks',
    item: 'minecraft:oak_planks',
    batches: 4,
    workstation: null
  }])
})

test('process skill rejects half-specified fuel dependency', async () => {
  const runtime = new FakeRuntime()
  const skill = new ProcessItemSkill(runtime)
  const signal = new AbortController().signal

  const result = await skill.execute(
    { signal },
    {
      processingId: 'minecraft:smelt_stone',
      kind: 'smelting',
      input: 'minecraft:cobblestone',
      output: 'minecraft:stone',
      batches: 8,
      workstation: {
        id: 'minecraft:furnace',
        kind: 'furnace',
        position: { x: 1, y: 64, z: 2 },
        expectedBlockNames: ['furnace']
      },
      fuel: 'minecraft:coal'
    } as never
  )

  assert.deepEqual(result, {
    status: 'failed',
    code: 'invalid_args'
  })
  assert.deepEqual(runtime.processCalls, [])
})

test('production skills reject extra fields', async () => {
  const runtime = new FakeRuntime()
  const skill = new CraftItemSkill(runtime)

  const result = await skill.execute(
    { signal: new AbortController().signal },
    {
      recipeId: 'minecraft:oak_planks',
      item: 'minecraft:oak_planks',
      batches: 1,
      workstation: null,
      chooseRecipeAutomatically: true
    } as never
  )

  assert.deepEqual(result, {
    status: 'failed',
    code: 'invalid_args'
  })
  assert.deepEqual(runtime.craftCalls, [])
})

test('production skills honor cancellation before runtime mutation', async () => {
  const runtime = new FakeRuntime()
  const skill = new ProcessItemSkill(runtime)
  const controller = new AbortController()
  controller.abort('threat_suspended')

  const result = await skill.execute(
    { signal: controller.signal },
    {
      processingId: 'minecraft:smelt_stone',
      kind: 'smelting',
      input: 'minecraft:cobblestone',
      output: 'minecraft:stone',
      batches: 1,
      workstation: {
        id: 'minecraft:furnace',
        kind: 'furnace',
        position: { x: 0, y: 64, z: 0 },
        expectedBlockNames: ['furnace']
      },
      fuel: 'minecraft:coal',
      fuelQuantity: 1
    }
  )

  assert.deepEqual(result, {
    status: 'cancelled',
    code: 'threat_suspended'
  })
  assert.deepEqual(runtime.processCalls, [])
})
