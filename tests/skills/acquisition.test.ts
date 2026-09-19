import assert from 'node:assert/strict'
import test from 'node:test'
import type { Position } from '../../src/contracts/events.js'
import type {
  SkillContext,
  SkillResult
} from '../../src/contracts/skills.js'
import type {
  MinecraftMemory,
  MinecraftMemoryInput,
  MinecraftMemoryRepository,
  MemorySearchQuery
} from '../../src/memory/repository.js'
import type {
  ResourceCandidate,
  ResourceGatheringAdapter,
  ResourceNavigationAdapter,
  ResourceSearchRequest
} from '../../src/minecraft/gathering.js'
import { AcquireResourceSkill } from '../../src/skills/acquisition.js'

class FakeMemory implements MinecraftMemoryRepository {
  readonly records: MinecraftMemory[] = []
  readonly remembered: MinecraftMemoryInput[] = []
  private nextId = 1

  remember(input: MinecraftMemoryInput): MinecraftMemory {
    this.remembered.push(structuredClone(input))
    const memory: MinecraftMemory = {
      id: `memory-${this.nextId++}`,
      worldKey: input.worldKey,
      type: input.type,
      content: input.content,
      dimension: input.dimension ?? null,
      position: input.position ? { ...input.position } : null,
      tags: [...(input.tags ?? [])],
      importance: input.importance ?? 0.5,
      observedAt: input.observedAt,
      createdAt: input.observedAt,
      updatedAt: input.observedAt,
      reinforcementCount: 0
    }
    this.records.push(memory)
    return memory
  }

  search(query: MemorySearchQuery): MinecraftMemory[] {
    return this.records
      .filter(memory => memory.worldKey === query.worldKey)
      .filter(memory =>
        !query.types || query.types.includes(memory.type)
      )
      .filter(memory =>
        query.dimension === undefined ||
        memory.dimension === query.dimension
      )
      .slice(0, query.limit ?? 8)
      .map(memory => structuredClone(memory))
  }

  forget(id: string): boolean {
    const index = this.records.findIndex(memory => memory.id === id)
    if (index < 0) return false
    this.records.splice(index, 1)
    return true
  }

  close(): void {}
}

class FakeResourceWorld
implements ResourceGatheringAdapter, ResourceNavigationAdapter {
  position: Position = { x: 0, y: 64, z: 0 }
  target: ResourceCandidate = {
    blockName: 'diamond_ore',
    position: { x: 20, y: 64, z: 0 }
  }
  targetVisible = false
  readonly inventory = new Map<string, number>()
  readonly navigation: Position[] = []

  currentPosition(): Position | null {
    return { ...this.position }
  }

  inventoryCount(item: string): number {
    return this.inventory.get(item) ?? 0
  }

  async findResourceBlocks(
    request: ResourceSearchRequest,
    signal: AbortSignal
  ): Promise<readonly ResourceCandidate[]> {
    if (signal.aborted || !this.targetVisible) return []
    if (!request.blockNames.includes(this.target.blockName)) return []
    if (distance(this.position, this.target.position) > request.radius) {
      return []
    }
    return [{
      blockName: this.target.blockName,
      position: { ...this.target.position }
    }]
  }

  async harvestResourceBlock(): Promise<SkillResult> {
    return {
      status: 'failed',
      code: 'unused'
    }
  }

  async goTo(
    position: Position,
    _options: { readonly range: number; readonly canDig: false },
    signal: AbortSignal
  ): Promise<SkillResult> {
    if (signal.aborted) {
      return { status: 'cancelled', code: 'cancelled' }
    }
    this.navigation.push({ ...position })
    this.position = { ...position }
    if (distance(this.position, this.target.position) <= 8) {
      this.targetVisible = true
    }
    return { status: 'succeeded', code: 'reached' }
  }
}

class RangeSensitiveResourceWorld extends FakeResourceWorld {
  readonly navigationRanges: number[] = []

  override async goTo(
    position: Position,
    options: { readonly range: number; readonly canDig: false },
    signal: AbortSignal
  ): Promise<SkillResult> {
    if (signal.aborted) {
      return { status: 'cancelled', code: 'cancelled' }
    }

    this.navigation.push({ ...position })
    this.navigationRanges.push(options.range)

    const start = { ...this.position }
    const dx = position.x - start.x
    const dy = position.y - start.y
    const dz = position.z - start.z
    const totalDistance = Math.hypot(dx, dy, dz)

    if (totalDistance <= options.range) {
      this.position = { ...position }
    } else {
      const travelDistance = totalDistance - options.range
      const ratio = travelDistance / totalDistance
      this.position = {
        x: start.x + dx * ratio,
        y: start.y + dy * ratio,
        z: start.z + dz * ratio
      }
    }

    this.targetVisible =
      distance(this.position, this.target.position) <= 4

    return { status: 'succeeded', code: 'reached' }
  }
}

class FakeGather {
  readonly calls: Array<{ resource: string; quantity: number }> = []
  constructor(
    private readonly world: FakeResourceWorld,
    private readonly behavior?: (
      context: SkillContext,
      args: { resource: string; quantity: number }
    ) => Promise<SkillResult>
  ) {}

  async execute(
    context: SkillContext,
    args: { resource: string; quantity: number }
  ): Promise<SkillResult> {
    this.calls.push({ ...args })
    if (this.behavior) {
      return this.behavior(context, args)
    }
    const current = this.world.inventoryCount('diamond')
    this.world.inventory.set(
      'diamond',
      current + args.quantity
    )
    return { status: 'succeeded', code: 'gathered' }
  }
}

class FakeExplore {
  calls = 0
  result: SkillResult = {
    status: 'failed',
    code: 'resource_not_visible'
  }

  constructor(private readonly world: FakeResourceWorld) {}

  async execute(): Promise<SkillResult> {
    this.calls += 1
    if (this.result.status === 'succeeded') {
      this.world.position = { x: 14, y: 64, z: 0 }
      this.world.targetVisible = true
    }
    return this.result
  }
}

class FakeExcavate {
  readonly directions: string[] = []
  succeedOn: string | null = null

  constructor(private readonly world: FakeResourceWorld) {}

  async execute(
    _context: SkillContext,
    args: { direction: string }
  ): Promise<SkillResult> {
    this.directions.push(args.direction)
    if (args.direction === this.succeedOn) {
      this.world.position = { x: 14, y: 64, z: 0 }
      this.world.targetVisible = true
      return { status: 'succeeded', code: 'resource_found' }
    }
    return {
      status: 'failed',
      code: 'resource_not_found_within_excavation_budget'
    }
  }
}

function createSkill(options: {
  world: FakeResourceWorld
  memory?: FakeMemory
  gather?: FakeGather
  explore?: FakeExplore
  excavate?: FakeExcavate
}) {
  const memory = options.memory ?? new FakeMemory()
  const gather = options.gather ?? new FakeGather(options.world)
  const explore = options.explore ?? new FakeExplore(options.world)
  const excavate = options.excavate ?? new FakeExcavate(options.world)

  return {
    memory,
    gather,
    explore,
    excavate,
    skill: new AcquireResourceSkill({
      resources: options.world,
      navigation: options.world,
      memory,
      worldKey: 'world:test',
      state: () => ({ dimension: 'overworld' }),
      gather: gather as never,
      explore: explore as never,
      excavate: excavate as never,
      now: () => 1234
    })
  }
}

test('acquire_resource uses known resource memory before exploration or excavation', async () => {
  const world = new FakeResourceWorld()
  const memory = new FakeMemory()
  memory.records.push({
    id: 'known-diamond',
    worldKey: 'world:test',
    type: 'resource',
    content: 'Known resource diamond_ore',
    dimension: 'overworld',
    position: { x: 18, y: 64, z: 0 },
    tags: ['resource', 'diamond_ore', 'diamond'],
    importance: 0.8,
    observedAt: 1000,
    createdAt: 1000,
    updatedAt: 1000,
    reinforcementCount: 0
  })

  const current = createSkill({ world, memory })
  const result = await current.skill.execute(
    { signal: new AbortController().signal },
    { resource: 'diamond_ore', quantity: 3 }
  )

  assert.deepEqual(result, {
    status: 'succeeded',
    code: 'acquired'
  })
  assert.deepEqual(
    world.navigation.map(position => position.x),
    [18]
  )
  assert.equal(current.explore.calls, 0)
  assert.deepEqual(current.excavate.directions, [])
  assert.deepEqual(current.gather.calls, [
    { resource: 'diamond_ore', quantity: 3 }
  ])
})

test('acquire_resource approaches remembered resource area closely enough to rescan nearby resources', async () => {
  const world = new RangeSensitiveResourceWorld()
  world.target = {
    blockName: 'diamond_ore',
    position: { x: 21, y: 64, z: 0 }
  }

  const memory = new FakeMemory()
  memory.records.push({
    id: 'stale-diamond-anchor',
    worldKey: 'world:test',
    type: 'resource',
    content: 'Known resource diamond_ore',
    dimension: 'overworld',
    position: { x: 18, y: 64, z: 0 },
    tags: ['resource', 'diamond_ore', 'diamond'],
    importance: 0.8,
    observedAt: 1000,
    createdAt: 1000,
    updatedAt: 1000,
    reinforcementCount: 0
  })

  const current = createSkill({ world, memory })
  const result = await current.skill.execute(
    { signal: new AbortController().signal },
    {
      resource: 'diamond_ore',
      quantity: 1,
      exploreSteps: 1,
      excavateLength: 1
    }
  )

  assert.deepEqual(result, {
    status: 'succeeded',
    code: 'acquired'
  })
  assert.equal(world.navigationRanges[0], 1)
  assert.equal(current.explore.calls, 0)
  assert.deepEqual(current.gather.calls, [
    { resource: 'diamond_ore', quantity: 1 }
  ])
})

test('acquire_resource explores before excavation and remembers a discovered resource', async () => {
  const world = new FakeResourceWorld()
  const current = createSkill({ world })
  current.explore.result = {
    status: 'succeeded',
    code: 'resource_found'
  }

  const result = await current.skill.execute(
    { signal: new AbortController().signal },
    { resource: 'diamond_ore', quantity: 2 }
  )

  assert.deepEqual(result, {
    status: 'succeeded',
    code: 'acquired'
  })
  assert.equal(current.explore.calls, 1)
  assert.deepEqual(current.excavate.directions, [])
  assert.equal(current.memory.remembered.length, 1)
  assert.deepEqual(
    current.memory.remembered[0]?.position,
    { x: 20, y: 64, z: 0 }
  )
  assert.deepEqual(current.gather.calls, [
    { resource: 'diamond_ore', quantity: 2 }
  ])
})

test('acquire_resource falls through to bounded excavation directions after exploration fails', async () => {
  const world = new FakeResourceWorld()
  const current = createSkill({ world })
  current.excavate.succeedOn = 'east'

  const result = await current.skill.execute(
    { signal: new AbortController().signal },
    {
      resource: 'diamond_ore',
      quantity: 1,
      exploreSteps: 2,
      excavateLength: 4
    }
  )

  assert.deepEqual(result, {
    status: 'succeeded',
    code: 'acquired'
  })
  assert.equal(current.explore.calls, 1)
  assert.deepEqual(
    current.excavate.directions,
    ['north', 'east']
  )
  assert.equal(current.memory.remembered.length, 1)
  assert.deepEqual(current.gather.calls, [
    { resource: 'diamond_ore', quantity: 1 }
  ])
})

test('acquire_resource preserves the original minimum target across threat suspension', async () => {
  const world = new FakeResourceWorld()
  world.position = { x: 18, y: 64, z: 0 }
  world.targetVisible = true

  const firstController = new AbortController()
  let call = 0
  const gather = new FakeGather(
    world,
    async (_context, args) => {
      call += 1
      if (call === 1) {
        world.inventory.set('diamond', 2)
        firstController.abort('threat_suspended')
        return {
          status: 'cancelled',
          code: 'threat_suspended'
        }
      }

      world.inventory.set(
        'diamond',
        world.inventoryCount('diamond') + args.quantity
      )
      return {
        status: 'succeeded',
        code: 'gathered'
      }
    }
  )

  const current = createSkill({ world, gather })
  const first = await current.skill.execute(
    {
      signal: firstController.signal,
      executionId: 'goal-acquire-1'
    },
    {
      resource: 'diamond_ore',
      quantity: 5
    }
  )

  assert.deepEqual(first, {
    status: 'cancelled',
    code: 'threat_suspended'
  })
  assert.equal(world.inventoryCount('diamond'), 2)

  const resumed = await current.skill.execute(
    {
      signal: new AbortController().signal,
      executionId: 'goal-acquire-1'
    },
    {
      resource: 'diamond_ore',
      quantity: 5
    }
  )

  assert.deepEqual(resumed, {
    status: 'succeeded',
    code: 'acquired'
  })
  assert.equal(world.inventoryCount('diamond'), 5)
  assert.deepEqual(
    gather.calls.map(entry => entry.quantity),
    [5, 3]
  )
})

function distance(a: Position, b: Position): number {
  return Math.hypot(
    a.x - b.x,
    a.y - b.y,
    a.z - b.z
  )
}
