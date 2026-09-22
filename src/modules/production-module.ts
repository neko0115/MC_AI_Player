import {
  PRODUCTION_RUNTIME_PORT,
  type ProductionRuntime
} from '../minecraft/production.js'
import type { RuntimePortRegistry } from '../minecraft/runtime-ports.js'
import {
  CraftItemSkill,
  ProcessItemSkill
} from '../skills/production.js'
import {
  AcquireItemSkill,
  type ItemAcquisitionDependencies
} from '../skills/item-acquisition.js'
import type { SkillModule } from './skill-module.js'

export interface ProductionSkillModuleDependencies {
  readonly runtimePorts: RuntimePortRegistry
  readonly itemAcquisition?: ItemAcquisitionDependencies
}

export function createProductionSkillModule(
  dependencies: ProductionSkillModuleDependencies
): SkillModule {
  return {
    id: 'production',
    install(registry) {
      const runtime: ProductionRuntime =
        dependencies.runtimePorts.require(PRODUCTION_RUNTIME_PORT)

      registry.register(new CraftItemSkill(runtime))
      registry.register(new ProcessItemSkill(runtime))
      if (dependencies.itemAcquisition) {
        registry.register(
          new AcquireItemSkill(dependencies.itemAcquisition)
        )
      }
    }
  }
}
