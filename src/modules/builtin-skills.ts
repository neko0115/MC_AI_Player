import type {
  MinecraftConfig,
  TreeLeafCleanupSetting
} from '../config.js'
import type { MinecraftMemoryRepository } from '../memory/repository.js'
import type { ServerCapabilityStatusSource } from '../minecraft/moxuebridge-capabilities.js'
import type { ResourceProfileSource } from '../minecraft/resource-profiles.js'
import type { MineflayerRuntimeBundle } from '../minecraft/runtime-bundle.js'
import {
  SURVIVAL_INVENTORY_PORT,
  runtimePortRegistry
} from '../minecraft/runtime-ports.js'
import {
  PRODUCTION_RUNTIME_PORT
} from '../minecraft/production.js'
import { createResourceSkillModule } from './resource-module.js'
import { createProductionSkillModule } from './production-module.js'
import type { SafetyPolicy } from '../safety/policy.js'
import { createNavigationSkills } from '../skills/navigation.js'
import { EatSkill, EquipSkill } from '../skills/survival.js'
import type { WorldStateCache } from '../state/world-state-cache.js'
import type { RuntimeEventBus } from '../telemetry/event-bus.js'
import type { SkillModule } from './skill-module.js'

const PREFERRED_FOOD = [
  'bread',
  'cooked_beef',
  'cooked_porkchop',
  'baked_potato',
  'cooked_chicken',
  'cooked_mutton',
  'cooked_cod',
  'cooked_salmon',
  'carrot',
  'apple'
] as const

const EXCLUDED_FOOD = [
  'enchanted_golden_apple',
  'golden_apple',
  'chorus_fruit',
  'pufferfish',
  'spider_eye',
  'poisonous_potato',
  'rotten_flesh',
  'suspicious_stew'
] as const

export interface BuiltinSkillModuleDependencies {
  readonly runtime: MineflayerRuntimeBundle
  readonly safety: SafetyPolicy
  readonly state: WorldStateCache
  readonly events: RuntimeEventBus
  readonly memory: MinecraftMemoryRepository
  readonly minecraftConfig: MinecraftConfig
  readonly serverCapabilities?: ServerCapabilityStatusSource
  readonly resourceProfiles?: ResourceProfileSource
  readonly treeLeafCleanupSetting: TreeLeafCleanupSetting
}

export function createBuiltinSkillModules(
  dependencies: BuiltinSkillModuleDependencies
): readonly SkillModule[] {
  const runtimePorts = runtimePortRegistry(dependencies.runtime)
  const modules: SkillModule[] = [
    createNavigationModule(dependencies),
    createSurvivalModule(dependencies),
    createResourceSkillModule({
      runtimePorts,
      safety: dependencies.safety,
      state: dependencies.state,
      events: dependencies.events,
      memory: dependencies.memory,
      worldKey:
        `${dependencies.minecraftConfig.host}:${dependencies.minecraftConfig.port}`,
      ...(dependencies.serverCapabilities
        ? { serverCapabilities: dependencies.serverCapabilities }
        : {}),
      ...(dependencies.resourceProfiles
        ? { resourceProfiles: dependencies.resourceProfiles }
        : {}),
      treeLeafCleanupSetting: dependencies.treeLeafCleanupSetting
    })
  ]

  if (runtimePorts.has(PRODUCTION_RUNTIME_PORT)) {
    modules.push(
      createProductionSkillModule({ runtimePorts })
    )
  }

  return modules
}

function createNavigationModule(
  dependencies: BuiltinSkillModuleDependencies
): SkillModule {
  return {
    id: 'navigation',
    install(registry) {
      const navigation = createNavigationSkills(dependencies.runtime.adapter)
      registry.register(navigation.goTo)
      registry.register(navigation.followPlayer)
      registry.register(navigation.stay)
      registry.register(navigation.stop)
    }
  }
}

function createSurvivalModule(
  dependencies: BuiltinSkillModuleDependencies
): SkillModule {
  return {
    id: 'survival',
    install(registry) {
      const inventory =
        runtimePortRegistry(dependencies.runtime)
          .require(SURVIVAL_INVENTORY_PORT)

      registry.register(new EatSkill(inventory, {
        preferredFood: PREFERRED_FOOD,
        excludedItems: EXCLUDED_FOOD
      }))
      registry.register(new EquipSkill(inventory))
    }
  }
}
