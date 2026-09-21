import assert from 'node:assert/strict'
import test from 'node:test'
import type { SkillResult } from '../../src/contracts/skills.js'
import {
  PRODUCTION_RUNTIME_PORT,
  type CraftItemRequest,
  type ProcessItemRequest,
  type ProductionRuntime
} from '../../src/minecraft/production.js'
import { RuntimePortRegistry } from '../../src/minecraft/runtime-ports.js'
import { createProductionSkillModule } from '../../src/modules/production-module.js'
import { SkillExecutor } from '../../src/skills/executor.js'
import { SkillRegistry } from '../../src/skills/registry.js'

class FakeProductionRuntime implements ProductionRuntime {
  readonly craftRequests: CraftItemRequest[] = []
  readonly processRequests: ProcessItemRequest[] = []

  async craft(
    request: CraftItemRequest,
    signal: AbortSignal
  ): Promise<SkillResult> {
    if (signal.aborted) {
      return { status: 'cancelled', code: 'cancelled' }
    }
    this.craftRequests.push(request)
    return { status: 'succeeded', code: 'crafted' }
  }

  async process(
    request: ProcessItemRequest,
    signal: AbortSignal
  ): Promise<SkillResult> {
    if (signal.aborted) {
      return { status: 'cancelled', code: 'cancelled' }
    }
    this.processRequests.push(request)
    return { status: 'succeeded', code: 'processed' }
  }
}

test('production module registers only internal production skills from its typed runtime port', async () => {
  const runtime = new FakeProductionRuntime()
  const ports = new RuntimePortRegistry()
  ports.register(PRODUCTION_RUNTIME_PORT, runtime)

  const registry = new SkillRegistry()
  createProductionSkillModule({
    runtimePorts: ports
  }).install(registry)

  assert.deepEqual(
    registry.registeredNames(),
    ['craft_item', 'process_item']
  )

  const executor = new SkillExecutor(registry)
  assert.deepEqual(
    await executor.execute('craft_item', {
      item: 'minecraft:crafting_table',
      quantity: 1,
      workstation: null
    }),
    { status: 'succeeded', code: 'crafted' }
  )

  assert.equal(runtime.craftRequests.length, 1)
  assert.deepEqual(runtime.craftRequests[0], {
    item: 'minecraft:crafting_table',
    quantity: 1,
    workstation: null
  })
})

test('production module delegates exact processing requests without deciding recipes', async () => {
  const runtime = new FakeProductionRuntime()
  const ports = new RuntimePortRegistry()
  ports.register(PRODUCTION_RUNTIME_PORT, runtime)

  const registry = new SkillRegistry()
  createProductionSkillModule({
    runtimePorts: ports
  }).install(registry)

  const executor = new SkillExecutor(registry)
  assert.deepEqual(
    await executor.execute('process_item', {
      kind: 'smelting',
      input: 'minecraft:cobblestone',
      output: 'minecraft:stone',
      quantity: 64,
      workstation: {
        id: 'minecraft:furnace',
        kind: 'furnace',
        position: { x: 1, y: 64, z: 2 },
        expectedBlockNames: ['furnace']
      },
      fuel: 'minecraft:coal'
    }),
    { status: 'succeeded', code: 'processed' }
  )

  assert.equal(runtime.processRequests.length, 1)
  assert.equal(
    runtime.processRequests[0]?.output,
    'minecraft:stone'
  )
})

test('production module fails closed when its typed runtime port is absent', () => {
  const registry = new SkillRegistry()

  assert.throws(
    () => createProductionSkillModule({
      runtimePorts: new RuntimePortRegistry()
    }).install(registry),
    /runtime port not registered: minecraft.production/
  )
  assert.deepEqual(registry.registeredNames(), [])
})
