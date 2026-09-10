import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { Bot } from 'mineflayer'
import { MineflayerInventoryRuntime } from '../../src/minecraft/mineflayer-inventory.js'
import type { ResolvedStorageTarget } from '../../src/minecraft/adapter.js'

class FakeContainer {
  closeCount = 0
  depositCount = 0
  withdrawCount = 0
  shouldFailDeposit = false
  shouldPauseDeposit = false
  releaseDeposit: (() => void) | null = null

  items() {
    return [{ name: 'bread', count: 8, type: 297, metadata: 0 }]
  }

  async deposit() {
    this.depositCount += 1
    if (this.shouldFailDeposit) throw new Error('container full')
    if (this.shouldPauseDeposit) {
      await new Promise<void>(resolve => {
        this.releaseDeposit = resolve
      })
    }
  }

  async withdraw() {
    this.withdrawCount += 1
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
  readonly inventory = {
    items: () => [{ name: 'bread', count: 16, type: 297, metadata: 0 }]
  }
  readonly container = new FakeContainer()
  blockName = 'chest'
  openCount = 0

  blockAt() {
    return { name: this.blockName }
  }

  async openContainer() {
    this.openCount += 1
    return this.container
  }

  async equip() {}
  async consume() {}
}

const target: ResolvedStorageTarget = {
  id: 'food-chest',
  position: { x: 2, y: 64, z: 3 },
  expectedBlockNames: ['chest', 'trapped_chest']
}

test('storage block mismatch fails before opening a container', async () => {
  const bot = new FakeBot()
  bot.blockName = 'furnace'
  const runtime = new MineflayerInventoryRuntime(() => bot as unknown as Bot)

  assert.deepEqual(
    await runtime.transferContainerItem(target, 'deposit', 'bread', 1, new AbortController().signal),
    { status: 'failed', code: 'storage_block_mismatch' }
  )
  assert.equal(bot.openCount, 0)
})

test('successful bounded deposit closes the container in finally', async () => {
  const bot = new FakeBot()
  const runtime = new MineflayerInventoryRuntime(() => bot as unknown as Bot)

  assert.deepEqual(
    await runtime.transferContainerItem(target, 'deposit', 'bread', 4, new AbortController().signal),
    { status: 'succeeded', code: 'transferred' }
  )
  assert.equal(bot.container.depositCount, 1)
  assert.equal(bot.container.closeCount, 1)
})

test('container-full failure remains structured and still closes', async () => {
  const bot = new FakeBot()
  bot.container.shouldFailDeposit = true
  const runtime = new MineflayerInventoryRuntime(() => bot as unknown as Bot)

  assert.deepEqual(
    await runtime.transferContainerItem(target, 'deposit', 'bread', 4, new AbortController().signal),
    { status: 'failed', code: 'container_full' }
  )
  assert.equal(bot.container.closeCount, 1)
})

test('abort during a container transaction closes and returns cancelled', async () => {
  const bot = new FakeBot()
  bot.container.shouldPauseDeposit = true
  const controller = new AbortController()
  const runtime = new MineflayerInventoryRuntime(() => bot as unknown as Bot)

  const pending = runtime.transferContainerItem(target, 'deposit', 'bread', 4, controller.signal)
  while (bot.container.releaseDeposit === null) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  controller.abort('emergency_stop')
  bot.container.releaseDeposit?.()

  assert.deepEqual(await pending, { status: 'cancelled', code: 'emergency_stop' })
  assert.equal(bot.container.closeCount, 1)
})
