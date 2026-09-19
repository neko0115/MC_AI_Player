import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { Vec3 } from 'vec3'
import type { Bot } from 'mineflayer'
import type { ResourceMutationPermit } from '../../src/safety/policy.js'
import { SafetyPolicy } from '../../src/safety/policy.js'
import { MineflayerGatheringRuntime } from '../../src/minecraft/mineflayer-gathering.js'
import type { ResourceCandidate } from '../../src/minecraft/gathering.js'
import type { WorldStateSnapshot } from '../../src/state/world-state.js'

interface FakeItem {
  name: string
  count: number
  type: number
  enchants?: Array<{ name: string; lvl: number }>
}

class FakeBot extends EventEmitter {
  entity = { position: new Vec3(0, 64, 0) }
  inventoryItems: FakeItem[] = []
  digCount = 0
  stopDiggingCount = 0
  blockName = 'oak_log'
  searchPositions = [new Vec3(4, 64, 0)]
  canDig = true
  visible = true
  harvestTools: Readonly<Record<string, boolean>> | undefined
  blockProperties: Record<string, unknown> = {}
  equippedItem: FakeItem | null = null
  readonly controlStates: Array<{ state: string; enabled: boolean }> = []

  readonly world = {
    raycast: () => {
      if (this.visible) {
        return {
          name: this.blockName,
          position: (this.searchPositions[0] ?? new Vec3(4, 64, 0)).clone()
        }
      }
      return {
        name: 'stone',
        position: new Vec3(1, 64, 0)
      }
    }
  }

  inventory = {
    items: () => this.inventoryItems
  }

  findBlocks(options: {
    point?: Vec3
    matching: (block: { name: string }) => boolean
    maxDistance?: number
    count?: number
  }): Vec3[] {
    const block = { name: this.blockName }
    return options.matching(block)
      ? this.searchPositions.slice(0, options.count ?? this.searchPositions.length)
      : []
  }

  blockAt(position: Vec3) {
    return {
      name: this.blockName,
      position: position.clone(),
      ...(this.harvestTools ? { harvestTools: this.harvestTools } : {}),
      getProperties: () => ({ ...this.blockProperties })
    }
  }

  canSeeBlock() {
    return this.visible
  }

  canDigBlock() {
    return this.canDig
  }

  async dig() {
    this.digCount += 1
    const existing = this.inventoryItems.find(item => item.name === this.blockName)
    if (existing) existing.count += 1
    else this.inventoryItems.push({ name: this.blockName, count: 1, type: 999 })
  }

  async equip(item: FakeItem) {
    this.equippedItem = item
  }

  setControlState(state: string, enabled: boolean) {
    this.controlStates.push({ state, enabled })
  }

  stopDigging() {
    this.stopDiggingCount += 1
  }
}

function readyState(): WorldStateSnapshot {
  return {
    connected: true,
    spawned: true,
    health: 20,
    food: 20,
    dimension: 'overworld',
    position: { x: 0, y: 64, z: 0 },
    nearbyPlayers: [],
    inventory: [],
    recentEvents: []
  }
}

function issuedPermit(blockName = 'oak_log') {
  const result = new SafetyPolicy().issueResourceMutationPermit(
    'gather_resource',
    [blockName],
    readyState()
  )
  assert.equal(result.kind, 'allow')
  if (result.kind !== 'allow') throw new Error('permit not issued')
  return result.permit
}

const oak: ResourceCandidate = {
  blockName: 'oak_log',
  position: { x: 4, y: 64, z: 0 }
}

test('bounded Mineflayer search returns semantic resource candidates', async () => {
  const bot = new FakeBot()
  const runtime = new MineflayerGatheringRuntime(() => bot as unknown as Bot)

  const result = await runtime.findResourceBlocks(
    {
      blockNames: ['oak_log'],
      origin: { x: 0, y: 64, z: 0 },
      radius: 16,
      limit: 4
    },
    new AbortController().signal
  )

  assert.deepEqual(result, [oak])
  assert.deepEqual(runtime.currentPosition(), { x: 0, y: 64, z: 0 })
})

test('visible resource scan accepts a partially exposed target when one surface sample is visible', async () => {
  const target = new Vec3(2, 64, 1)
  let raycastCalls = 0
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    inventory: { items: () => [] },
    username: 'Moxue_Test',
    on() {},
    off() {},
    findBlocks(options: {
      matching: (block: { name: string }) => boolean
      count?: number
    }) {
      return options.matching({ name: 'diamond_ore' })
        ? [target.clone()]
        : []
    },
    blockAt(position: Vec3) {
      return {
        name: 'diamond_ore',
        position: position.clone()
      }
    },
    canSeeBlock() {
      return false
    },
    world: {
      raycast() {
        raycastCalls += 1
        if (raycastCalls === 1) {
          return {
            name: 'stone',
            position: new Vec3(1, 65, 1)
          }
        }
        return {
          name: 'diamond_ore',
          position: target.clone()
        }
      }
    }
  } as unknown as Bot

  const runtime = new MineflayerGatheringRuntime(() => bot)
  const visible = await runtime.findResourceBlocks(
    {
      blockNames: ['diamond_ore'],
      origin: { x: 0.5, y: 64, z: 0.5 },
      radius: 6,
      limit: 4,
      visibility: 'visible'
    },
    new AbortController().signal
  )

  assert.equal(visible.length, 1)
  assert.ok(raycastCalls >= 2)
  assert.equal(visible[0]?.blockName, 'diamond_ore')
  assert.deepEqual(visible[0]?.position, { x: 2, y: 64, z: 1 })
})

test('ordinary resource scan refuses loaded but hidden blocks', async () => {
  const bot = new FakeBot()
  bot.blockName = 'iron_ore'
  bot.visible = false
  const runtime = new MineflayerGatheringRuntime(() => bot as unknown as Bot)

  const hidden = await runtime.findResourceBlocks(
    {
      blockNames: ['iron_ore'],
      origin: { x: 0, y: 64, z: 0 },
      radius: 16,
      limit: 4,
      visibility: 'visible'
    },
    new AbortController().signal
  )
  assert.deepEqual(hidden, [])

  const loaded = await runtime.findResourceBlocks(
    {
      blockNames: ['iron_ore'],
      origin: { x: 0, y: 64, z: 0 },
      radius: 16,
      limit: 4,
      visibility: 'loaded'
    },
    new AbortController().signal
  )
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0]?.blockName, 'iron_ore')
})

test('exploration waypoint uses visible standing space instead of requiring visible floor support', async () => {
  const supportTarget = new Vec3(4, 63, 0)
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    username: 'Moxue_Test',
    on() {},
    off() {},
    findBlocks(options: {
      matching: (block: { name: string; boundingBox: string }) => boolean
      count?: number
    }) {
      const stone = { name: 'stone', boundingBox: 'block' }
      return options.matching(stone) ? [supportTarget.clone()] : []
    },
    blockAt(position: Vec3) {
      if (position.y === 63) {
        return {
          name: 'stone',
          boundingBox: 'block',
          position: position.clone()
        }
      }
      return {
        name: 'air',
        boundingBox: 'empty',
        position: position.clone()
      }
    },
    canSeeBlock() {
      return false
    },
    world: {
      raycast() {
        return null
      }
    }
  } as unknown as Bot

  const runtime = new MineflayerGatheringRuntime(() => bot)
  const waypoints = await runtime.findExplorationWaypoints(
    {
      origin: { x: 0, y: 64, z: 0 },
      radius: 6,
      limit: 4
    },
    new AbortController().signal
  )

  assert.deepEqual(waypoints, [{ x: 4, y: 64, z: 0 }])
})

test('exploration waypoint rejects standing space hidden behind a solid raycast hit', async () => {
  const supportTarget = new Vec3(4, 63, 0)
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    username: 'Moxue_Test',
    on() {},
    off() {},
    findBlocks(options: {
      matching: (block: { name: string; boundingBox: string }) => boolean
      count?: number
    }) {
      const stone = { name: 'stone', boundingBox: 'block' }
      return options.matching(stone) ? [supportTarget.clone()] : []
    },
    blockAt(position: Vec3) {
      if (position.y === 63) {
        return {
          name: 'stone',
          boundingBox: 'block',
          position: position.clone()
        }
      }
      return {
        name: 'air',
        boundingBox: 'empty',
        position: position.clone()
      }
    },
    canSeeBlock() {
      return true
    },
    world: {
      raycast() {
        return {
          name: 'stone',
          boundingBox: 'block',
          position: new Vec3(2, 65, 0)
        }
      }
    }
  } as unknown as Bot

  const runtime = new MineflayerGatheringRuntime(() => bot)
  const waypoints = await runtime.findExplorationWaypoints(
    {
      origin: { x: 0, y: 64, z: 0 },
      radius: 6,
      limit: 4
    },
    new AbortController().signal
  )

  assert.deepEqual(waypoints, [])
})

test('decaying leaf scan only returns natural unsupported leaves', async () => {
  const bot = new FakeBot()
  bot.blockName = 'oak_leaves'
  bot.blockProperties = {
    persistent: false,
    distance: 7
  }
  const runtime = new MineflayerGatheringRuntime(() => bot as unknown as Bot)

  const decaying = await runtime.findDecayingLeafBlocks(
    ['oak_leaves'],
    { x: 0, y: 64, z: 0 },
    8,
    8,
    new AbortController().signal
  )
  assert.equal(decaying.length, 1)
  assert.equal(decaying[0]?.blockName, 'oak_leaves')

  bot.blockProperties = {
    persistent: true,
    distance: 7
  }
  assert.deepEqual(
    await runtime.findDecayingLeafBlocks(
      ['oak_leaves'],
      { x: 0, y: 64, z: 0 },
      8,
      8,
      new AbortController().signal
    ),
    []
  )

  bot.blockProperties = {
    persistent: false,
    distance: 6
  }
  assert.deepEqual(
    await runtime.findDecayingLeafBlocks(
      ['oak_leaves'],
      { x: 0, y: 64, z: 0 },
      8,
      8,
      new AbortController().signal
    ),
    []
  )
})

test('optional-collection removal succeeds even when a cleaned leaf drops nothing', async () => {
  const bot = new FakeBot()
  bot.blockName = 'oak_leaves'
  bot.dig = async () => {
    bot.digCount += 1
  }
  const runtime = new MineflayerGatheringRuntime(() => bot as unknown as Bot)
  const leaf: ResourceCandidate = {
    blockName: 'oak_leaves',
    position: { x: 4, y: 64, z: 0 }
  }

  const result = await runtime.harvestResourceBlock(
    leaf,
    issuedPermit('oak_leaves'),
    new AbortController().signal,
    { requireCollection: false }
  )

  assert.deepEqual(result, { status: 'succeeded', code: 'removed' })
  assert.equal(bot.digCount, 1)
  assert.equal(runtime.inventoryCount('oak_leaves'), 0)
})

test('forged mutation permit cannot reach bot.dig', async () => {
  const bot = new FakeBot()
  const runtime = new MineflayerGatheringRuntime(() => bot as unknown as Bot)
  const forged = {
    mutateBlocks: true,
    allowedBlockNames: ['oak_log']
  } as ResourceMutationPermit

  const result = await runtime.harvestResourceBlock(
    oak,
    forged,
    new AbortController().signal
  )

  assert.deepEqual(result, { status: 'failed', code: 'mutation_not_permitted' })
  assert.equal(bot.digCount, 0)
})

test('permit scope mismatch cannot reach bot.dig', async () => {
  const bot = new FakeBot()
  const runtime = new MineflayerGatheringRuntime(() => bot as unknown as Bot)

  const result = await runtime.harvestResourceBlock(
    { blockName: 'birch_log', position: oak.position },
    issuedPermit('oak_log'),
    new AbortController().signal
  )

  assert.deepEqual(result, { status: 'failed', code: 'mutation_not_permitted' })
  assert.equal(bot.digCount, 0)
})

test('changed target block fails closed before digging', async () => {
  const bot = new FakeBot()
  bot.blockName = 'stone'
  const runtime = new MineflayerGatheringRuntime(() => bot as unknown as Bot)

  const result = await runtime.harvestResourceBlock(
    oak,
    issuedPermit(),
    new AbortController().signal
  )

  assert.deepEqual(result, { status: 'failed', code: 'resource_changed' })
  assert.equal(bot.digCount, 0)
})

test('issued scoped permit allows one matching resource harvest and confirms collection', async () => {
  const bot = new FakeBot()
  const runtime = new MineflayerGatheringRuntime(() => bot as unknown as Bot)

  const result = await runtime.harvestResourceBlock(
    oak,
    issuedPermit(),
    new AbortController().signal
  )

  assert.deepEqual(result, { status: 'succeeded', code: 'collected' })
  assert.equal(bot.digCount, 1)
  assert.equal(runtime.inventoryCount('oak_log'), 1)
})


test('capability tool preparation equips one tool accepted by the target block', async () => {
  const bot = new FakeBot()
  bot.harvestTools = { '257': true }
  bot.inventoryItems.push(
    { name: 'stick', count: 2, type: 280 },
    { name: 'iron_pickaxe', count: 1, type: 257 }
  )
  const runtime = new MineflayerGatheringRuntime(() => bot as unknown as Bot)

  const result = await runtime.prepareResourceTool(
    oak,
    new AbortController().signal
  )

  assert.deepEqual(result, { status: 'succeeded', code: 'correct_tool_equipped' })
  assert.equal(bot.equippedItem?.name, 'iron_pickaxe')
})


test('semantic axe preparation equips an axe when vanilla block metadata has no harvest tool requirement', async () => {
  const bot = new FakeBot()
  bot.harvestTools = undefined
  bot.inventoryItems.push(
    { name: 'stick', count: 2, type: 280 },
    { name: 'stone_axe', count: 1, type: 275 },
    { name: 'iron_axe', count: 1, type: 258 }
  )
  const runtime = new MineflayerGatheringRuntime(() => bot as unknown as Bot)

  const result = await runtime.prepareResourceTool(
    oak,
    new AbortController().signal,
    { toolKind: 'axe' }
  )

  assert.deepEqual(result, { status: 'succeeded', code: 'correct_tool_equipped' })
  assert.equal(bot.equippedItem?.name, 'iron_axe')
})

test('tool preparation excludes forbidden Fortune and Silk Touch enchantments', async () => {
  const bot = new FakeBot()
  bot.harvestTools = { '257': true }
  bot.inventoryItems.push(
    {
      name: 'iron_pickaxe',
      count: 1,
      type: 257,
      enchants: [{ name: 'fortune', lvl: 3 }]
    },
    {
      name: 'iron_pickaxe',
      count: 1,
      type: 257
    }
  )
  const runtime = new MineflayerGatheringRuntime(() => bot as unknown as Bot)

  const result = await runtime.prepareResourceTool(
    oak,
    new AbortController().signal,
    {
      toolKind: 'pickaxe',
      forbiddenEnchantments: ['silk_touch', 'fortune']
    }
  )

  assert.deepEqual(result, { status: 'succeeded', code: 'correct_tool_equipped' })
  assert.deepEqual(bot.equippedItem?.enchants, undefined)
})

test('tool preparation fails closed when every valid pickaxe has Silk Touch', async () => {
  const bot = new FakeBot()
  bot.harvestTools = { '257': true }
  bot.inventoryItems.push({
    name: 'iron_pickaxe',
    count: 1,
    type: 257,
    enchants: [{ name: 'minecraft:silk_touch', lvl: 1 }]
  })
  const runtime = new MineflayerGatheringRuntime(() => bot as unknown as Bot)

  const result = await runtime.prepareResourceTool(
    oak,
    new AbortController().signal,
    {
      toolKind: 'pickaxe',
      forbiddenEnchantments: ['silk_touch']
    }
  )

  assert.deepEqual(result, { status: 'failed', code: 'correct_tool_unavailable' })
  assert.equal(bot.equippedItem, null)
})

test('harvest can confirm a resource-profile drop whose item name differs from the block', async () => {
  const bot = new FakeBot()
  bot.blockName = 'iron_ore'
  bot.dig = async () => {
    bot.digCount += 1
    bot.inventoryItems.push({ name: 'raw_iron', count: 1, type: 1000 })
  }
  const runtime = new MineflayerGatheringRuntime(() => bot as unknown as Bot)
  const target: ResourceCandidate = {
    blockName: 'iron_ore',
    position: { x: 4, y: 64, z: 0 }
  }

  const result = await runtime.harvestResourceBlock(
    target,
    issuedPermit('iron_ore'),
    new AbortController().signal,
    { expectedItemNames: ['raw_iron'] }
  )

  assert.deepEqual(result, { status: 'succeeded', code: 'collected' })
  assert.equal(runtime.inventoryCount('raw_iron'), 1)
})

test('sneak harvest always releases the sneak control state after digging', async () => {
  const bot = new FakeBot()
  const runtime = new MineflayerGatheringRuntime(() => bot as unknown as Bot)

  const result = await runtime.harvestResourceBlock(
    oak,
    issuedPermit(),
    new AbortController().signal,
    { sneak: true }
  )

  assert.deepEqual(result, { status: 'succeeded', code: 'collected' })
  assert.deepEqual(bot.controlStates, [
    { state: 'sneak', enabled: true },
    { state: 'sneak', enabled: false }
  ])
})

test('aborted harvest never digs and an abort during dig invokes stopDigging', async () => {
  const bot = new FakeBot()
  const runtime = new MineflayerGatheringRuntime(() => bot as unknown as Bot)
  const preAborted = new AbortController()
  preAborted.abort('operator_stop')

  const early = await runtime.harvestResourceBlock(oak, issuedPermit(), preAborted.signal)
  assert.deepEqual(early, { status: 'cancelled', code: 'operator_stop' })
  assert.equal(bot.digCount, 0)

  let releaseDig!: () => void
  bot.dig = async () => {
    bot.digCount += 1
    await new Promise<void>(resolve => {
      releaseDig = resolve
    })
  }
  const controller = new AbortController()
  const pending = runtime.harvestResourceBlock(oak, issuedPermit(), controller.signal)
  await Promise.resolve()
  controller.abort('emergency_stop')
  releaseDig()

  const result = await pending
  assert.deepEqual(result, { status: 'cancelled', code: 'emergency_stop' })
  assert.equal(bot.stopDiggingCount, 1)
})
