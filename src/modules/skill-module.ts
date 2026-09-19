import type { SkillRegistry } from '../skills/registry.js'

const MODULE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

export interface SkillModule {
  readonly id: string
  install(registry: SkillRegistry): void
}

export function installSkillModules(
  registry: SkillRegistry,
  modules: readonly SkillModule[]
): void {
  const seen = new Set<string>()

  for (const module of modules) {
    if (!MODULE_ID_PATTERN.test(module.id)) {
      throw new Error(`invalid skill module id: ${module.id}`)
    }
    if (seen.has(module.id)) {
      throw new Error(`duplicate skill module id: ${module.id}`)
    }
    seen.add(module.id)
  }

  for (const module of modules) {
    module.install(registry)
  }
}
