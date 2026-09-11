import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { Vec3 } from 'vec3'
import type { Bot } from 'mineflayer'
import type { Position } from '../../src/contracts/events.js'
import type { ResourceCandidate } from '../../src/minecraft/gathering.js'
import { MineflayerGatheringRuntime } from '../../src/minecraft/mineflayer-gathering.js'

interface FakeBlock {
  name: string
  position: Vec3
  boundingBox: 'block' | 'empty'
}

class ApproachBot extends EventEmitter {
  readonly entity = { position: new Vec3(0, 64, 0) }
  readonly inventory = { items: () => [] }
  readonly searchPositions = [new Vec3(4, 64, 0), new Vec3(6, 70, 0)]
  private readonly blocks = new Map<string, FakeBlock>()

  constructor() {
    super()
    this.setBlock(4, 64, 0, 'spruce_log', 'block')
    this.setBlock(3, 63, 0, 'stone', 'block')

    this.setBlock(6, 70, 0, 'spruce_log', 'block')
    for (const [x, z] of [[5, 0], [7, 0], [6, -1], [6, 1]]) {
      this.setBlock(x, 69, z, 'spruce_leaves', 'block')
    }
  }

  findBlocks(options: {
    matching: (block: { name: string }) => boolean
    count?: number
  }): Vec3[] {
    return this.searchPositions
      .filter(position => options.matching(this.blockAt(position)!))
      .slice(0, options.count ?? this.searchPositions.length)
  }

  blockAt(position: Vec3): FakeBlock {
    return this.blocks.get(key(position.x, position.y, position.z)) ?? {
      name: 'air',
      position: position.clone(),
      boundingBox: 'empty'
    }
  }

  private setBlock(
    x: number,
    y: number,
    z: number,
    name: string,
    boundingBox: 'block' | 'empty'
  ) {
    this.blocks.set(key(x, y, z), {
      name,
      position: new Vec3(x, y, z),
      boundingBox
    })
  }
}

test('resource search returns a safe ground approach and skips canopy-only logs', async () => {
  const bot = new ApproachBot()
  const runtime = new MineflayerGatheringRuntime(() => bot as unknown as Bot)

  const result = await runtime.findResourceBlocks(
    {
      blockNames: ['spruce_log'],
      origin: { x: 0, y: 64, z: 0 },
      radius: 16,
      limit: 8
    },
    new AbortController().signal
  )

  assert.equal(result.length, 1)
  assert.deepEqual(result[0]?.position, { x: 4, y: 64, z: 0 })
  const approach = (result[0] as ResourceCandidate & { approachPosition?: Position })?.approachPosition
  assert.deepEqual(approach, { x: 3, y: 64, z: 0 })
})

function key(x: number, y: number, z: number): string {
  return `${x},${y},${z}`
}
