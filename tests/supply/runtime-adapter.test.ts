import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  ResolvedStorageTarget,
  SurvivalInventoryAdapter,
  ContainerTransactionAdapter,
  EquipmentSlot
} from '../../src/minecraft/adapter.js'
import type {
  CraftItemRequest,
  ProcessItemRequest,
  ProductionRuntime
} from '../../src/minecraft/production.js'
import type { SkillResult } from '../../src/contracts/skills.js'
import {
  SupplyRuntimeAdapter,
  toCanonicalItemId,
  toRuntimeItemName
} from '../../src/supply/runtime-adapter.js'

class FakeInventory
implements SurvivalInventoryAdapter, ContainerTransactionAdapter {
  readonly equips: Array<{
    item: string
    destination: string | undefined
  }> = []
  readonly transfers: Array<{
    target: ResolvedStorageTarget
    item: string
    quantity: number
  }> = []

  inventoryItems() {
    return [
      { name: 'stone', count: 12 },
      { name: 'stone', count: 4 },
      { name: 'examplemod:crystal', count: 3 }
    ]
  }

  async consumeInventoryItem(
    _item: string,
    _signal: AbortSignal
  ): Promise<SkillResult> {
    return { status: 'failed', code: 'unexpected_consume' }
  }

  async equipInventoryItem(
    item: string,
    destination: EquipmentSlot | undefined,
    _signal: AbortSignal
  ): Promise<SkillResult> {
    this.equips.push({ item, destination })
    return { status: 'succeeded', code: 'equipped' }
  }

  async transferContainerItem(
    target: ResolvedStorageTarget,
    direction: 'deposit' | 'withdraw',
    item: string,
    quantity: number,
    _signal: AbortSignal
  ): Promise<SkillResult> {
    assert.equal(direction, 'withdraw')
    this.transfers.push({
      target,
      item,
      quantity
    })
    return { status: 'succeeded', code: 'transferred' }
  }
}

class NoopProduction implements ProductionRuntime {
  async craft(
    _request: CraftItemRequest
  ): Promise<SkillResult> {
    return { status: 'succeeded', code: 'crafted' }
  }

  async process(
    _request: ProcessItemRequest
  ): Promise<SkillResult> {
    return { status: 'succeeded', code: 'processed' }
  }
}

test('runtime adapter converts vanilla canonical ids without item-specific cases', async () => {
  const inventory = new FakeInventory()
  const target: ResolvedStorageTarget = {
    id: 'main',
    position: { x: 1, y: 64, z: 2 },
    expectedBlockNames: ['chest']
  }
  const resourceCalls: Array<{
    resource: string
    quantity: number
  }> = []

  const adapter = new SupplyRuntimeAdapter({
    inventory,
    production: new NoopProduction(),
    resourceAcquisition: {
      async execute(_context, args) {
        resourceCalls.push(args)
        return { status: 'succeeded', code: 'acquired' }
      }
    },
    storageResolver: {
      async resolve() {
        return target
      }
    }
  })

  assert.equal(
    adapter.inventoryCount('minecraft:stone'),
    16
  )
  assert.equal(
    adapter.inventoryCount('examplemod:crystal'),
    3
  )

  assert.deepEqual(
    await adapter.equipTool(
      'minecraft:diamond_pickaxe',
      new AbortController().signal
    ),
    { status: 'succeeded', code: 'equipped' }
  )
  assert.deepEqual(inventory.equips, [{
    item: 'diamond_pickaxe',
    destination: 'hand'
  }])

  assert.deepEqual(
    await adapter.withdrawStorage(
      'main',
      'minecraft:stone',
      4,
      new AbortController().signal
    ),
    { status: 'succeeded', code: 'transferred' }
  )
  assert.equal(
    inventory.transfers[0]?.item,
    'stone'
  )

  await adapter.acquireResource(
    'minecraft:stone',
    4,
    new AbortController().signal,
    'exec-1'
  )
  assert.deepEqual(resourceCalls, [{
    resource: 'minecraft:stone',
    quantity: 4
  }])
})

test('namespace conversion preserves non-vanilla ids', () => {
  assert.equal(
    toRuntimeItemName('minecraft:stone'),
    'stone'
  )
  assert.equal(
    toRuntimeItemName('examplemod:crystal'),
    'examplemod:crystal'
  )
  assert.equal(
    toCanonicalItemId('stone'),
    'minecraft:stone'
  )
  assert.equal(
    toCanonicalItemId('examplemod:crystal'),
    'examplemod:crystal'
  )
})

test('missing authorization resolvers fail closed', async () => {
  const adapter = new SupplyRuntimeAdapter({
    inventory: new FakeInventory(),
    production: new NoopProduction(),
    resourceAcquisition: {
      async execute() {
        return { status: 'succeeded', code: 'acquired' }
      }
    }
  })

  assert.deepEqual(
    await adapter.withdrawStorage(
      'unknown',
      'minecraft:stone',
      1,
      new AbortController().signal
    ),
    {
      status: 'failed',
      code: 'storage_unavailable'
    }
  )

  assert.equal(
    await adapter.resolveWorkstation(
      {
        id: 'minecraft:furnace',
        item: 'minecraft:furnace',
        blockIds: ['minecraft:furnace'],
        supportedKinds: ['smelting']
      },
      new AbortController().signal
    ),
    null
  )
})
