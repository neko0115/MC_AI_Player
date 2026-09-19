import type {
  TreeLeafCleanupSetting
} from '../config.js'
import type { MinecraftMemoryRepository } from '../memory/repository.js'
import type { ServerCapabilityStatusSource } from '../minecraft/moxuebridge-capabilities.js'
import type { ResourceProfileSource } from '../minecraft/resource-profiles.js'
import {
  MINECRAFT_ADAPTER_PORT,
  RESOURCE_GATHERING_PORT,
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
import type { WorldStateCache } from '../state/world-state-cache.js'
import type { RuntimeEventBus } from '../telemetry/event-bus.js'
import type { SkillModule } from './skill-module.js'

export interface ResourceSkillModuleDependencies {
  readonly runtimePorts: RuntimePortRegistry
  readonly safety: SafetyPolicy
  readonly state: WorldStateCache
  readonly events: RuntimeEventBus
  readonly memory: MinecraftMemoryRepository
  readonly worldKey: string
  readonly serverCapabilities?: ServerCapabilityStatusSource
  readonly resourceProfiles?: ResourceProfileSource
  readonly treeLeafCleanupSetting: TreeLeafCleanupSetting
}

export function createResourceSkillModule(
  dependencies: ResourceSkillModuleDependencies
): SkillModule {
  return {
    id: 'resources',
    install(registry) {
      const resources =
        dependencies.runtimePorts.require(RESOURCE_GATHERING_PORT)
      const navigation =
        dependencies.runtimePorts.require(MINECRAFT_ADAPTER_PORT)
      const protection = new RegionProtectionPolicy([])
      const resourceProfiles = dependencies.resourceProfiles

      registry.register(new FindResourceSkill(
        resources,
        protection,
        resourceProfiles ? { resourceProfiles } : {}
      ))

      const exploreResource = new ExploreResourceSkill(
        resources,
        navigation,
        protection,
        resourceProfiles ? { resourceProfiles } : {}
      )
      const excavateResource = new ExcavateResourceSkill({
        resources,
        navigation,
        safety: dependencies.safety,
        state: () => dependencies.state.snapshot(),
        protection,
        ...(resourceProfiles ? { resourceProfiles } : {})
      })
      const gatherResource = new GatherResourceSkill({
        resources,
        navigation,
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
        resources,
        navigation,
        memory: dependencies.memory,
        worldKey: dependencies.worldKey,
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
