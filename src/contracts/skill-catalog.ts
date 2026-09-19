import { z } from 'zod'
import {
  AcquireResourceArgsSchema,
  DepositItemArgsSchema,
  EatArgsSchema,
  EquipArgsSchema,
  ExcavateResourceArgsSchema,
  ExploreResourceArgsSchema,
  FollowPlayerArgsSchema,
  GatherResourceArgsSchema,
  GoToArgsSchema,
  ReturnHomeArgsSchema,
  StayArgsSchema,
  WithdrawItemArgsSchema
} from './goals.js'
import {
  SkillNameSchema,
  type SkillName
} from './skills.js'

export type SkillSafetyCapability =
  | 'break_blocks'
  | 'place_blocks'
  | 'pvp'

export type SkillMutationAuthority =
  | 'none'
  | 'resource_break'

export interface SkillAiContract {
  readonly exposed: boolean
  readonly description: string | null
}

export interface SkillSafetyContract {
  readonly capabilities: readonly SkillSafetyCapability[]
  readonly mutationAuthority: SkillMutationAuthority
}

export interface SkillContract {
  readonly name: SkillName
  readonly argsSchema: z.ZodType | null
  readonly ai: SkillAiContract
  readonly safety: SkillSafetyContract
}

const NONE = Object.freeze([] as SkillSafetyCapability[])

function contract(
  value: SkillContract
): SkillContract {
  return Object.freeze({
    ...value,
    ai: Object.freeze({ ...value.ai }),
    safety: Object.freeze({
      capabilities: Object.freeze([...value.safety.capabilities]),
      mutationAuthority: value.safety.mutationAuthority
    })
  })
}

export const SKILL_CONTRACTS: readonly SkillContract[] = Object.freeze([
  contract({
    name: 'follow_player',
    argsSchema: FollowPlayerArgsSchema,
    ai: {
      exposed: true,
      description: 'Follow one named player at a bounded range.'
    },
    safety: { capabilities: NONE, mutationAuthority: 'none' }
  }),
  contract({
    name: 'stay',
    argsSchema: StayArgsSchema,
    ai: {
      exposed: true,
      description: 'Hold the current position until safely superseded.'
    },
    safety: { capabilities: NONE, mutationAuthority: 'none' }
  }),
  contract({
    name: 'stop',
    argsSchema: null,
    ai: { exposed: false, description: null },
    safety: { capabilities: NONE, mutationAuthority: 'none' }
  }),
  contract({
    name: 'go_to',
    argsSchema: GoToArgsSchema,
    ai: {
      exposed: true,
      description: 'Navigate to one bounded coordinate target without generic digging.'
    },
    safety: { capabilities: NONE, mutationAuthority: 'none' }
  }),
  contract({
    name: 'return_home',
    argsSchema: ReturnHomeArgsSchema,
    ai: {
      exposed: true,
      description: 'Return to the configured home location.'
    },
    safety: { capabilities: NONE, mutationAuthority: 'none' }
  }),
  contract({
    name: 'eat',
    argsSchema: EatArgsSchema,
    ai: {
      exposed: true,
      description: 'Eat one approved ordinary food item.'
    },
    safety: { capabilities: NONE, mutationAuthority: 'none' }
  }),
  contract({
    name: 'equip',
    argsSchema: EquipArgsSchema,
    ai: {
      exposed: true,
      description: 'Equip one exact inventory item to an approved destination.'
    },
    safety: { capabilities: NONE, mutationAuthority: 'none' }
  }),
  contract({
    name: 'find_resource',
    argsSchema: null,
    ai: { exposed: false, description: null },
    safety: { capabilities: NONE, mutationAuthority: 'none' }
  }),
  contract({
    name: 'gather_resource',
    argsSchema: GatherResourceArgsSchema,
    ai: { exposed: false, description: null },
    safety: {
      capabilities: Object.freeze(['break_blocks']),
      mutationAuthority: 'resource_break'
    }
  }),
  contract({
    name: 'explore_resource',
    argsSchema: ExploreResourceArgsSchema,
    ai: { exposed: false, description: null },
    safety: { capabilities: NONE, mutationAuthority: 'none' }
  }),
  contract({
    name: 'excavate_resource',
    argsSchema: ExcavateResourceArgsSchema,
    ai: { exposed: false, description: null },
    safety: {
      capabilities: Object.freeze(['break_blocks']),
      mutationAuthority: 'resource_break'
    }
  }),
  contract({
    name: 'acquire_resource',
    argsSchema: AcquireResourceArgsSchema,
    ai: {
      exposed: true,
      description: 'Acquire at least a bounded quantity of one resource through visible search, known resource memory, no-dig exploration, bounded excavation, and deterministic gathering.'
    },
    safety: { capabilities: NONE, mutationAuthority: 'none' }
  }),
  contract({
    name: 'deposit_item',
    argsSchema: DepositItemArgsSchema,
    ai: {
      exposed: true,
      description: 'Deposit an exact bounded quantity into one named storage target.'
    },
    safety: { capabilities: NONE, mutationAuthority: 'none' }
  }),
  contract({
    name: 'withdraw_item',
    argsSchema: WithdrawItemArgsSchema,
    ai: {
      exposed: true,
      description: 'Withdraw an exact bounded quantity from one named storage target.'
    },
    safety: { capabilities: NONE, mutationAuthority: 'none' }
  })
])

const CONTRACTS_BY_NAME = new Map(
  SKILL_CONTRACTS.map(entry => [entry.name, entry] as const)
)

if (
  CONTRACTS_BY_NAME.size !== SKILL_CONTRACTS.length ||
  SkillNameSchema.options.some(name => !CONTRACTS_BY_NAME.has(name))
) {
  throw new Error('skill contract catalog is incomplete or contains duplicates')
}

export function skillContract(
  name: SkillName
): SkillContract {
  const entry = CONTRACTS_BY_NAME.get(name)
  if (!entry) {
    throw new Error(`skill contract missing: ${name}`)
  }
  return entry
}

export function aiExposedSkillContracts(): readonly SkillContract[] {
  return SKILL_CONTRACTS.filter(
    entry => entry.ai.exposed && entry.ai.description !== null
  )
}
