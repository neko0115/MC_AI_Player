import assert from 'node:assert/strict'
import test from 'node:test'
import type { Position } from '../../src/contracts/events.js'
import type { SkillResult } from '../../src/contracts/skills.js'
import type {
  BlockObservation,
  ResourceCandidate,
  ResourceGatheringAdapter,
  ResourceHarvestOptions,
  ResourceNavigationAdapter,
  ResourceSearchRequest,
  ResourceToolPreparationOptions
} from '../../src/minecraft/gathering.js'
import { SafetyPolicy, isResourceMutationPermit, type ResourceMutationPermit } from '../../src/safety/policy.js'
import { ExcavateResourceSkill } from '../../src/skills/excavation.js'
import { RegionProtectionPolicy } from '../../src/skills/gathering.js'
import type { WorldStateSnapshot } from '../../src/state/world-state.js'

class FakeExcavationWorld
implements ResourceGatheringAdapter, ResourceNavigationAdapter {
  readonly blocks = new Map<string, string>()
  readonly harvests: ResourceCandidate[] = []
  readonly harvestOptions: Array<ResourceHarvestOptions | undefined> = []
  readonly toolKinds: Array<ResourceToolPreparationOptions['toolKind']> = []
  readonly navigation: Array<{
    position: Position
    canDig: boolean
  }> = []
  position: Position = { x: 0, y: 64, z: 0 }

  currentPosition(): Position | null {
    return { ...this.position }
  }

  inventoryCount(): number {
    return 0
  }

  inspectBlock(position: Position): BlockObservation | null {
    const name = this.blocks.get(key(position)) ?? 'air'
    return {
      name,
      position: { ...position },
      boundingBox:
        name === 'air' || name === 'cave_air' || name === 'void_air'
          ? 'empty'
          : 'block'
    }
  }

  async findResourceBlocks(
    request: ResourceSearchRequest,
    signal: AbortSignal
  ): Promise<readonly ResourceCandidate[]> {
    if (signal.aborted) return []
    const candidates: ResourceCandidate[] = []
    for (const [positionKey, name] of this.blocks.entries()) {
      if (!request.blockNames.includes(name)) continue
      const position = parseKey(positionKey)
      if (distance(position, request.origin) > request.radius) continue
      candidates.push({
        blockName: name,
        position
      })
    }
    return candidates.slice(0, request.limit)
  }

  async prepareResourceTool(
    _target: ResourceCandidate,
    signal: AbortSignal,
    options: ResourceToolPreparationOptions = {}
  ): Promise<SkillResult> {
    if (signal.aborted) {
      return { status: 'cancelled', code: 'cancelled' }
    }
    this.toolKinds.push(options.toolKind)
    return {
      status: 'succeeded',
      code: 'correct_tool_equipped'
    }
  }

  async harvestResourceBlock(
    target: ResourceCandidate,
    permit: ResourceMutationPermit,
    signal: AbortSignal,
    options?: ResourceHarvestOptions
  ): Promise<SkillResult> {
    if (signal.aborted) {
      return { status: 'cancelled', code: 'cancelled' }
    }
    if (
      !isResourceMutationPermit(permit) ||
      !permit.allowedBlockNames.includes(target.blockName)
    ) {
      return {
        status: 'failed',
        code: 'mutation_not_permitted'
      }
    }

    const stored = this.blocks.get(key(target.position))
    if (stored !== target.blockName) {
      return {
        status: 'failed',
        code: 'resource_changed'
      }
    }

    this.harvests.push({
      blockName: target.blockName,
      position: { ...target.position }
    })
    this.harvestOptions.push(
      options ? { ...options } : undefined
    )
    this.blocks.delete(key(target.position))
    return {
      status: 'succeeded',
      code: 'removed'
    }
  }

  async goTo(
    position: Position,
    options: {
      readonly range: number
      readonly canDig: false
    },
    signal: AbortSignal
  ): Promise<SkillResult> {
    if (signal.aborted) {
      return { status: 'cancelled', code: 'cancelled' }
    }
    this.navigation.push({
      position: { ...position },
      canDig: options.canDig
    })
    this.position = { ...position }
    return {
      status: 'succeeded',
      code: 'reached'
    }
  }
}

function readyState(
  world: FakeExcavationWorld
): WorldStateSnapshot {
  return {
    connected: true,
    spawned: true,
    health: 20,
    food: 20,
    dimension: 'overworld',
    position: world.currentPosition(),
    nearbyPlayers: [],
    nearbyHostiles: [],
    inventory: [],
    recentEvents: []
  }
}

test('excavate_resource opens a bounded 1x2 tunnel and stops when the target becomes visible', async () => {
  const world = new FakeExcavationWorld()

  for (const x of [1, 2]) {
    world.blocks.set(key({ x, y: 64, z: 0 }), 'stone')
    world.blocks.set(key({ x, y: 65, z: 0 }), x === 1 ? 'granite' : 'deepslate')
  }
  world.blocks.set(
    key({ x: 4, y: 64, z: 0 }),
    'diamond_ore'
  )

  const skill = new ExcavateResourceSkill({
    resources: world,
    navigation: world,
    safety: new SafetyPolicy(),
    state: () => readyState(world),
    protection: new RegionProtectionPolicy([])
  })

  const result = await skill.execute(
    { signal: new AbortController().signal },
    {
      resource: 'diamond_ore',
      direction: 'east',
      maxLength: 4,
      radius: 2
    }
  )

  assert.equal(result.status, 'succeeded')
  assert.equal(result.code, 'resource_found')
  assert.deepEqual(
    world.harvests.map(candidate => [
      candidate.blockName,
      candidate.position.x,
      candidate.position.y
    ]),
    [
      ['granite', 1, 65],
      ['stone', 1, 64],
      ['deepslate', 2, 65],
      ['stone', 2, 64]
    ]
  )
  assert.deepEqual(
    world.harvestOptions,
    [
      { requireCollection: false },
      { requireCollection: false },
      { requireCollection: false },
      { requireCollection: false }
    ]
  )
  assert.deepEqual(
    world.toolKinds,
    ['pickaxe', 'pickaxe', 'pickaxe', 'pickaxe']
  )
  assert.equal(
    world.navigation.every(entry => entry.canDig === false),
    true
  )
  assert.equal(
    world.blocks.get(key({ x: 4, y: 64, z: 0 })),
    'diamond_ore'
  )
})

test('excavate_resource fails closed on a non-allowlisted block without mutating it', async () => {
  const world = new FakeExcavationWorld()
  world.blocks.set(
    key({ x: 1, y: 64, z: 0 }),
    'oak_planks'
  )

  const skill = new ExcavateResourceSkill({
    resources: world,
    navigation: world,
    safety: new SafetyPolicy(),
    state: () => readyState(world),
    protection: new RegionProtectionPolicy([])
  })

  const result = await skill.execute(
    { signal: new AbortController().signal },
    {
      resource: 'diamond_ore',
      direction: 'east',
      maxLength: 2,
      radius: 2
    }
  )

  assert.deepEqual(result, {
    status: 'failed',
    code: 'excavation_blocked'
  })
  assert.deepEqual(world.harvests, [])
  assert.equal(
    world.blocks.get(key({ x: 1, y: 64, z: 0 })),
    'oak_planks'
  )
})

test('excavate_resource stops before digging when lava touches the next slice', async () => {
  const world = new FakeExcavationWorld()
  world.blocks.set(
    key({ x: 1, y: 64, z: 0 }),
    'stone'
  )
  world.blocks.set(
    key({ x: 1, y: 65, z: 0 }),
    'stone'
  )
  world.blocks.set(
    key({ x: 1, y: 64, z: 1 }),
    'lava'
  )

  const skill = new ExcavateResourceSkill({
    resources: world,
    navigation: world,
    safety: new SafetyPolicy(),
    state: () => readyState(world),
    protection: new RegionProtectionPolicy([])
  })

  const result = await skill.execute(
    { signal: new AbortController().signal },
    {
      resource: 'diamond_ore',
      direction: 'east',
      maxLength: 2,
      radius: 2
    }
  )

  assert.deepEqual(result, {
    status: 'failed',
    code: 'excavation_hazard_detected'
  })
  assert.deepEqual(world.harvests, [])
  assert.equal(
    world.blocks.get(key({ x: 1, y: 64, z: 0 })),
    'stone'
  )
})

function key(position: Position): string {
  return `${position.x},${position.y},${position.z}`
}

function parseKey(value: string): Position {
  const [x, y, z] = value.split(',').map(Number)
  return { x: x!, y: y!, z: z! }
}

function distance(a: Position, b: Position): number {
  return Math.hypot(
    a.x - b.x,
    a.y - b.y,
    a.z - b.z
  )
}
