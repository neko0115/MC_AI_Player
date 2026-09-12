import type { DecisionSkillDescription } from './context-builder.js'
import type { SkillName } from '../contracts/skills.js'
import type { SkillRegistry } from '../skills/registry.js'

const DECISION_SKILLS: ReadonlyArray<DecisionSkillDescription> = Object.freeze([
  { name: 'follow_player', description: 'Follow one named player at a bounded range.' },
  { name: 'stay', description: 'Hold the current position until safely superseded.' },
  { name: 'go_to', description: 'Navigate to one bounded coordinate target without generic digging.' },
  { name: 'return_home', description: 'Return to the configured home location.' },
  { name: 'eat', description: 'Eat one approved ordinary food item.' },
  { name: 'equip', description: 'Equip one exact inventory item to an approved destination.' },
  { name: 'gather_resource', description: 'Gather an exact bounded quantity of one resource.' },
  { name: 'deposit_item', description: 'Deposit an exact bounded quantity into one named storage target.' },
  { name: 'withdraw_item', description: 'Withdraw an exact bounded quantity from one named storage target.' }
])

export function registeredDecisionSkills(registry: Pick<SkillRegistry, 'has'>): DecisionSkillDescription[] {
  return DECISION_SKILLS
    .filter(skill => registry.has(skill.name as SkillName))
    .map(skill => ({ ...skill }))
}
