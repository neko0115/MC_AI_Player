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
  type RuntimePortRegistry
} from '../minecraft/runtime-ports.js'
import type { SafetyPolicy } from '../safety/policy.js'
import { AcquireResourceSkill } from '../skills/acquisition.js'
import { ExcavateResourceSkill } from '../skills/excavation.js'
import {
  ExploreResourceSkill,
  FindResourceSkill,
  GatherResourceSkill,
  RegionProtectionPolicy
} from '../skills/gathering.js'
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
  readonly runtimePorts: RuntimePortRegistry
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
  return [
    createNavigationModule(dependencies),
    createSurvivalModule(dependencies),
    createResourceModule(dependencies)
  ]
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
        dependencies.runtimePorts.require(SURVIVAL_INVENTORY_PORT)

      registry.register(new EatSkill(inventory, {
        preferredFood: PREFERRED_FOOD,
        excludedItems: EXCLUDED_FOOD
      }))
      registry.register(new EquipSkill(inventory))
    }
  }
}

function createResourceModule(
  dependencies: BuiltinSkillModuleDependencies
): SkillModule {
  return {
    id: 'resources',
    install(registry) {
      const protection = new RegionProtectionPolicy([])
      const resourceProfiles = dependencies.resourceProfiles

      registry.register(new FindResourceSkill(
        dependencies.runtime.gathering,
        protection,
        resourceProfiles ? { resourceProfiles } : {}
      ))

      const exploreResource = new ExploreResourceSkill(
        dependencies.runtime.gathering,
        dependencies.runtime.adapter,
        protection,
        resourceProfiles ? { resourceProfiles } : {}
      )
      const excavateResource = new ExcavateResourceSkill({
        resources: dependencies.runtime.gathering,
        navigation: dependencies.runtime.adapter,
        safety: dependencies.safety,
        state: () => dependencies.state.snapshot(),
        protection,
        ...(resourceProfiles ? { resourceProfiles } : {})
      })
      const gatherResource = new GatherResourceSkill({
        resources: dependencies.runtime.gathering,
        navigation: dependencies.runtime.adapter,
        safety: dependencies.safety,
        state: () => dependencies.state.snapshot(),
        protection,
        ...(dependencies.serverCapabilities
          ? { capabilities: dependencies.serverCapabilities }
          : {}),
        ...(resourceProfiles ? { resourceProfiles } : {}),
        ...(dependencies.treeLeafCleanupSetting === 'catalog'
          ? {}
          : {
              options: {
                leafCleanupPolicyOverride:
                  dependencies.treeLeafCleanupSetting
              }
            }),
        onCapabilityUsed: notice => {
          void dependencies.events.publish({
            type: 'server_capability_used',
            at: Date.now(),
            capability: notice.capability,
            resource: notice.resource,
            maxChain: notice.maxChain
          }).catch(() => {
            // Capability telemetry is advisory and must never stop gameplay.
          })
        },
        onCooperativePickup: notice => {
          void dependencies.events.publish({
            type: 'cooperative_pickup',
            at: Date.now(),
            resource: notice.resource,
            player: notice.player,
            interceptedCount: notice.interceptedCount,
            remaining: notice.remaining
          }).catch(() => {
            // Cooperative telemetry is advisory and must never stop gameplay.
          })
        }
      })

      registry.register(exploreResource)
      registry.register(excavateResource)
      registry.register(gatherResource)
      registry.register(new AcquireResourceSkill({
        resources: dependencies.runtime.gathering,
        navigation: dependencies.runtime.adapter,
        memory: dependencies.memory,
        worldKey:
          `${dependencies.minecraftConfig.host}:${dependencies.minecraftConfig.port}`,
        state: () => ({
          dimension: dependencies.state.snapshot().dimension
        }),
        gather: gatherResource,
        explore: exploreResource,
        excavate: excavateResource,
        ...(resourceProfiles ? { resourceProfiles } : {}),
        events: dependencies.events
      }))
    }
  }
}
