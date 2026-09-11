import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { Vec3 } from 'vec3'
import type { Bot } from 'mineflayer'
import { MineflayerGatheringRuntime } from '../../src/minecraft/mineflayer-gathering.js'

interface FakeDroppedItem {
  name: string
  count: number
}

interface FakeEntity {
  id: number
  type: string
  username?: string
  position: Vec3
  getDroppedItem?: () => FakeDroppedItem | null
}

class TrackingBot extends EventEmitter {
  readonly entity = { id: 1, position: new Vec3(0, 64, 0) }
  readonly inventory = { items: () => [] }
  readonly entities: Record<number, FakeEntity> = {}
}

function droppedEntity(id: number, name: string, count: number, position: Vec3): FakeEntity {
  return {
    id,
    type: 'object',
    position,
    getDroppedItem: () => ({ name, count })
  }
}

test('findDroppedResource follows the actual matching item entity instead of the harvested block origin', async () => {
  const bot = new TrackingBot()
  bot.entities[101] = droppedEntity(101, 'spruce_log', 1, new Vec3(5.25, 64, 1.1))
  bot.entities[102] = droppedEntity(102, 'oak_log', 1, new Vec3(4.2, 64, 0.1))
  const runtime = new MineflayerGatheringRuntime(() => bot as unknown as Bot)

  const drop = await runtime.findDroppedResource(
    'spruce_log',
    { x: 4, y: 64, z: 0 },
    4,
    new AbortController().signal
  )

  assert.deepEqual(drop, {
    entityId: 101,
    itemName: 'spruce_log',
    count: 1,
    position: { x: 5.25, y: 64, z: 1.1 }
  })
})

test('playerCollect records which player took a tracked dropped resource', async () => {
  const bot = new TrackingBot()
  const drop = droppedEntity(201, 'spruce_log', 1, new Vec3(5, 64, 0))
  bot.entities[201] = drop
  const runtime = new MineflayerGatheringRuntime(() => bot as unknown as Bot)

  await runtime.findDroppedResource(
    'spruce_log',
    { x: 4, y: 64, z: 0 },
    4,
    new AbortController().signal
  )

  bot.emit('playerCollect', {
    id: 2,
    type: 'player',
    username: 'Neko0115',
    position: new Vec3(5, 64, 0)
  }, drop)
  delete bot.entities[201]

  const status = runtime.droppedResourceStatus(201)
  assert.deepEqual(status, {
    kind: 'collected_by_player',
    player: 'Neko0115',
    count: 1
  })
})

test('a pre-harvest collection cursor attributes a player pickup even after the item entity is gone', () => {
  const bot = new TrackingBot()
  const runtime = new MineflayerGatheringRuntime(() => bot as unknown as Bot)
  const cursor = runtime.resourceCollectionCursor()
  const drop = droppedEntity(301, 'spruce_log', 1, new Vec3(5.4, 64, 0.6))
  bot.entities[301] = drop

  bot.emit('playerCollect', {
    id: 2,
    type: 'player',
    username: 'Neko0115',
    position: new Vec3(5.4, 64, 0.6)
  }, drop)
  delete bot.entities[301]

  assert.deepEqual(
    runtime.findPlayerResourceCollectionAfter(
      cursor,
      'spruce_log',
      { x: 4, y: 64, z: 0 },
      4
    ),
    {
      sequence: cursor + 1,
      entityId: 301,
      itemName: 'spruce_log',
      count: 1,
      position: { x: 5.4, y: 64, z: 0.6 },
      player: 'Neko0115'
    }
  )
})
