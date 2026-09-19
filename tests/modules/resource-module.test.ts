import assert from 'node:assert/strict'
import test from 'node:test'
import type { Position, RuntimeEvent } from '../../src/contracts/events.js'
import type { SkillResult } from '../../src/contracts/skills.js'
import type { MinecraftMemoryRepository, MemorySearchQuery, MinecraftMemory } from '../../src/memory/repository.js'
import type { MinecraftAdapter, NavigationOptions } from '../../src/minecraft/adapter.js'
import type {
  ResourceCandidate,
  ResourceSearchRequest
} from '../../src/minecraft/gathering.js'
import {
  MINECRAFT_ADAPTER_PORT,
  RESOURCE_GATHERING_PORT,
  RuntimePortRegistry
} from '../../src/minecraft/runtime-ports.js'
import { SafetyPolicy } from '../../src/safety/policy.js'
import { createResourceSkillModule } from '../../src/modules/resource-module.js'
import { SkillRegistry } from '../../src/skills/registry.js'
import { WorldStateCache } from '../../src/state/world-state-cache.js'
import { RuntimeEventBus } from '../../src/telemetry/event-bus.js'
import { registeredDecisionSkills } from '../../src/agent/skill-catalog.js'

class FakeNavigation implements MinecraftAdapter {
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async goTo(
    _position: Position,
    _options: NavigationOptions,
    _signal: AbortSignal
  ): Promise<SkillResult> {
    return { status: 'succeeded', code: 'arrived' }
  }
  async followPlayer(): Promise<SkillResult> {
    return { status: 'failed', code: 'unused' }
  }
  async holdPosition(): Promise<SkillResult> {
    return { status: 'failed', code: 'unused' }
  }
  async stopMotion(): Promise<void> {}
  onEvent(
    _listener: (event: RuntimeEvent) => void
  ): () => void {
    return () => {}
  }
}

class FakeMemory implements MinecraftMemoryRepository {
  remember(): MinecraftMemory {
    throw new Error('not used')
  }
  search(_query: MemorySearchQuery): MinecraftMemory[] {
    return []
  }
  forget(): boolean {
    return false
  }
  close(): void {}
}

function readyState(): WorldStateCache {
  const state = new WorldStateCache()
  state.apply({ type: 'connected', at: 1 })
  state.apply({
    type: 'spawned',
    at: 2,
    dimension: 'overworld',
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20
  })
  return state
}

test('resource module registers the complete resource workflow from typed runtime ports', () => {
  const ports = new RuntimePortRegistry()
  ports.register(MINECRAFT_ADAPTER_PORT, new FakeNavigation())
  ports.register(RESOURCE_GATHERING_PORT, {
    currentPosition: () => ({ x: 0, y: 64, z: 0 }),
    inventoryCount: () => 0,
    async findResourceBlocks(
      _request: ResourceSearchRequest,
      _signal: AbortSignal
    ): Promise<readonly ResourceCandidate[]> {
      return []
    },
    async harvestResourceBlock(): Promise<SkillResult> {
      return { status: 'failed', code: 'unused' }
    }
  })

  const registry = new SkillRegistry()
  createResourceSkillModule({
    runtimePorts: ports,
    safety: new SafetyPolicy(),
    state: readyState(),
    events: new RuntimeEventBus(),
    memory: new FakeMemory(),
    worldKey: 'world:test',
    treeLeafCleanupSetting: 'catalog'
  }).install(registry)

  assert.deepEqual(
    registry.registeredNames(),
    [
      'find_resource',
      'explore_resource',
      'excavate_resource',
      'gather_resource',
      'acquire_resource'
    ]
  )
  assert.deepEqual(
    registeredDecisionSkills(registry).map(skill => skill.name),
    ['acquire_resource']
  )
})

test('resource module fails closed when its required gathering port is absent', () => {
  const ports = new RuntimePortRegistry()
  ports.register(MINECRAFT_ADAPTER_PORT, new FakeNavigation())
  const registry = new SkillRegistry()

  assert.throws(
    () => createResourceSkillModule({
      runtimePorts: ports,
      safety: new SafetyPolicy(),
      state: readyState(),
      events: new RuntimeEventBus(),
      memory: new FakeMemory(),
      worldKey: 'world:test',
      treeLeafCleanupSetting: 'catalog'
    }).install(registry),
    /runtime port not registered: minecraft.gathering/
  )
  assert.deepEqual(registry.registeredNames(), [])
})
