import type { DecisionSkillDescription } from './context-builder.js'
import {
  aiExposedSkillContracts
} from '../contracts/skill-catalog.js'
import type { SkillRegistry } from '../skills/registry.js'

export function registeredDecisionSkills(
  registry: Pick<SkillRegistry, 'has'>
): DecisionSkillDescription[] {
  return aiExposedSkillContracts()
    .filter(skill => registry.has(skill.name))
    .map(skill => ({
      name: skill.name,
      description: skill.ai.description!
    }))
}
