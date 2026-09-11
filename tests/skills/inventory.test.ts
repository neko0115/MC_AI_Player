import assert from 'node:assert/strict'
import test from 'node:test'
import type { SkillResult } from '../../src/contracts/skills.js'
import type {
  ContainerTransactionAdapter,
  ResolvedStorageTarget
} from '../../src/minecraft/adapter.js'
import {
  DepositItemSkill,
  WithdrawItemSkill,
  type StorageResolver
} from '../../src/skills/inventory.js'

class FakeContainerAdapter implements ContainerTransactionAdapter {
  readonly transactions: Array<{
    direction: 'deposit' | 'withdraw'
    target: ResolvedStorageTarget
    item: string
    quantity: number
  }> = []

  constructor(
    private readonly result: SkillResult = { status: 'succeeded', code: 'transferred' }
  ) {}

  async transferContainerItem(
    target: ResolvedStorageTarget,
    direction: 'deposit' | 'withdraw',
    item: string,
    quantity: number,
    signal: AbortSignal
  ): Promise<SkillResult> {
    if (signal.aborted) return { status: 'cancelled', code: 'cancelled' }
    this.transactions.push({ direction, target, item, quantity })
    return this.result
  }
}

class FakeStorageResolver implements StorageResolver {
  constructor(private readonly target: ResolvedStorageTarget | null) {}
  async resolve(storageId: string): Promise<ResolvedStorageTarget | null> {
    return this.target && storageId === this.target.id ? this.target : null
  }
}

const chest: ResolvedStorageTarget = {
  id: 'base-food-chest',
  position: { x: 10, y: 64, z: -4 },
  expectedBlockNames: ['chest', 'trapped_chest']
}

function context(signal = new AbortController().signal) {
  return { signal }
}

test('deposit resolves an explicit storage id and transfers exact quantity', async () => {
  const adapter = new FakeContainerAdapter()
  const skill = new DepositItemSkill(adapter, new FakeStorageResolver(chest))

  const result = await skill.execute(context(), {
    item: 'bread',
    quantity: 12,
    storage: 'base-food-chest'
  })

  assert.deepEqual(result, { status: 'succeeded', code: 'transferred' })
  assert.deepEqual(adapter.transactions, [{
    direction: 'deposit',
    target: chest,
    item: 'bread',
    quantity: 12
  }])
})

test('withdraw resolves an explicit storage id and transfers exact quantity', async () => {
  const adapter = new FakeContainerAdapter()
  const skill = new WithdrawItemSkill(adapter, new FakeStorageResolver(chest))

  await skill.execute(context(), {
    item: 'bread',
    quantity: 4,
    storage: 'base-food-chest'
  })

  assert.equal(adapter.transactions[0]?.direction, 'withdraw')
  assert.equal(adapter.transactions[0]?.quantity, 4)
})

test('unknown storage id fails closed without touching a container', async () => {
  const adapter = new FakeContainerAdapter()
  const skill = new DepositItemSkill(adapter, new FakeStorageResolver(null))

  assert.deepEqual(await skill.execute(context(), {
    item: 'bread', quantity: 1, storage: 'missing'
  }), {
    status: 'failed',
    code: 'storage_not_found'
  })
  assert.deepEqual(adapter.transactions, [])
})

test('wildcard item names are rejected in v1', async () => {
  const adapter = new FakeContainerAdapter()
  const skill = new DepositItemSkill(adapter, new FakeStorageResolver(chest))

  assert.deepEqual(await skill.execute(context(), {
    item: '*', quantity: 1, storage: 'base-food-chest'
  }), {
    status: 'failed',
    code: 'wildcard_not_allowed'
  })
  assert.deepEqual(adapter.transactions, [])
})

test('container full and inventory full remain structured failures', async () => {
  const deposit = new DepositItemSkill(
    new FakeContainerAdapter({ status: 'failed', code: 'container_full' }),
    new FakeStorageResolver(chest)
  )
  const withdraw = new WithdrawItemSkill(
    new FakeContainerAdapter({ status: 'failed', code: 'inventory_full' }),
    new FakeStorageResolver(chest)
  )

  assert.equal((await deposit.execute(context(), {
    item: 'bread', quantity: 64, storage: 'base-food-chest'
  })).code, 'container_full')
  assert.equal((await withdraw.execute(context(), {
    item: 'bread', quantity: 64, storage: 'base-food-chest'
  })).code, 'inventory_full')
})

test('abort before storage resolution performs no transaction', async () => {
  const controller = new AbortController()
  controller.abort('disconnect')
  const adapter = new FakeContainerAdapter()
  const skill = new DepositItemSkill(adapter, new FakeStorageResolver(chest))

  assert.deepEqual(await skill.execute(context(controller.signal), {
    item: 'bread', quantity: 1, storage: 'base-food-chest'
  }), {
    status: 'cancelled',
    code: 'disconnect'
  })
  assert.deepEqual(adapter.transactions, [])
})
