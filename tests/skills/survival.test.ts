import assert from 'node:assert/strict'
import test from 'node:test'
import type { InventoryStack, SurvivalInventoryAdapter } from '../../src/minecraft/adapter.js'
import { EatSkill, EquipSkill } from '../../src/skills/survival.js'

class FakeSurvivalAdapter implements SurvivalInventoryAdapter {
  readonly consumed: string[] = []
  readonly equipped: Array<{ item: string; destination?: string }> = []

  constructor(
    private readonly items: InventoryStack[],
    private readonly consumeResult = { status: 'succeeded' as const, code: 'consumed' },
    private readonly equipResult = { status: 'succeeded' as const, code: 'equipped' }
  ) {}

  inventoryItems(): readonly InventoryStack[] {
    return this.items
  }

  async consumeInventoryItem(item: string, signal: AbortSignal) {
    if (signal.aborted) return { status: 'cancelled' as const, code: 'cancelled' }
    this.consumed.push(item)
    return this.consumeResult
  }

  async equipInventoryItem(item: string, destination: string | undefined, signal: AbortSignal) {
    if (signal.aborted) return { status: 'cancelled' as const, code: 'cancelled' }
    this.equipped.push({ item, ...(destination ? { destination } : {}) })
    return this.equipResult
  }
}

function context(signal = new AbortController().signal) {
  return { signal }
}

test('eat selects the highest-preference available ordinary food', async () => {
  const adapter = new FakeSurvivalAdapter([
    { name: 'apple', count: 2 },
    { name: 'bread', count: 3 },
    { name: 'cooked_beef', count: 1 }
  ])
  const skill = new EatSkill(adapter, {
    preferredFood: ['cooked_beef', 'bread', 'apple'],
    excludedItems: ['golden_apple', 'enchanted_golden_apple']
  })

  const result = await skill.execute(context(), {})

  assert.deepEqual(result, { status: 'succeeded', code: 'consumed' })
  assert.deepEqual(adapter.consumed, ['cooked_beef'])
})

test('eat never consumes excluded special items even if listed first', async () => {
  const adapter = new FakeSurvivalAdapter([
    { name: 'golden_apple', count: 1 },
    { name: 'bread', count: 1 }
  ])
  const skill = new EatSkill(adapter, {
    preferredFood: ['golden_apple', 'bread'],
    excludedItems: ['golden_apple']
  })

  await skill.execute(context(), {})

  assert.deepEqual(adapter.consumed, ['bread'])
})

test('eat fails cleanly when no approved food is available', async () => {
  const adapter = new FakeSurvivalAdapter([{ name: 'golden_apple', count: 1 }])
  const skill = new EatSkill(adapter, {
    preferredFood: ['golden_apple', 'bread'],
    excludedItems: ['golden_apple']
  })

  assert.deepEqual(await skill.execute(context(), {}), {
    status: 'failed',
    code: 'no_approved_food'
  })
  assert.deepEqual(adapter.consumed, [])
})

test('eat respects cancellation before touching inventory', async () => {
  const controller = new AbortController()
  controller.abort('emergency_stop')
  const adapter = new FakeSurvivalAdapter([{ name: 'bread', count: 1 }])
  const skill = new EatSkill(adapter, { preferredFood: ['bread'], excludedItems: [] })

  assert.deepEqual(await skill.execute(context(controller.signal), {}), {
    status: 'cancelled',
    code: 'emergency_stop'
  })
  assert.deepEqual(adapter.consumed, [])
})

test('equip delegates one exact item and destination to semantic adapter', async () => {
  const adapter = new FakeSurvivalAdapter([{ name: 'iron_helmet', count: 1 }])
  const skill = new EquipSkill(adapter)

  const result = await skill.execute(context(), { item: 'iron_helmet', destination: 'head' })

  assert.deepEqual(result, { status: 'succeeded', code: 'equipped' })
  assert.deepEqual(adapter.equipped, [{ item: 'iron_helmet', destination: 'head' }])
})
