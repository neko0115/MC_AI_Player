import type { SkillDefinition, SkillName } from '../contracts/skills.js'

type AnySkillDefinition = SkillDefinition<any>

export class SkillRegistry {
  private readonly definitions = new Map<SkillName, AnySkillDefinition>()

  register<A>(definition: SkillDefinition<A>): void {
    if (this.definitions.has(definition.name)) {
      throw new Error(`skill already registered: ${definition.name}`)
    }
    this.definitions.set(definition.name, definition as AnySkillDefinition)
  }

  get(name: SkillName): AnySkillDefinition | undefined {
    return this.definitions.get(name)
  }
}
