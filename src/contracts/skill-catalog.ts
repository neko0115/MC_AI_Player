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
} from './action-args.js'
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
  readonly goal: boolean
  readonly decision: boolean
  readonly ai: SkillAiContract
  readonly safety: SkillSafetyContract
}

const NONE = Object.freeze([] as SkillSafetyCapability[])

function contract<const T extends SkillContract>(
  value: T
): T {
  return Object.freeze({
    ...value,
    ai: Object.freeze({ ...value.ai }),
    safety: Object.freeze({
      capabilities: Object.freeze([...value.safety.capabilities]),
      mutationAuthority: value.safety.mutationAuthority
    })
  }) as T
}

export const SKILL_CONTRACTS = [
  contract({
    name: 'follow_player',
    argsSchema: FollowPlayerArgsSchema,
    goal: true,
    decision: true,
    ai: {
      exposed: true,
      description: 'Follow one named player at a bounded range.'
    },
    safety: { capabilities: NONE, mutationAuthority: 'none' }
  }),
  contract({
    name: 'stay',
    argsSchema: StayArgsSchema,
    goal: true,
    decision: true,
    ai: {
      exposed: true,
      description: 'Hold the current position until safely superseded.'
    },
    safety: { capabilities: NONE, mutationAuthority: 'none' }
  }),
  contract({
    name: 'stop',
    argsSchema: null,
    goal: false,
    decision: false,
    ai: { exposed: false, description: null },
    safety: { capabilities: NONE, mutationAuthority: 'none' }
  }),
  contract({
    name: 'go_to',
    argsSchema: GoToArgsSchema,
    goal: true,
    decision: true,
    ai: {
      exposed: true,
      description: 'Navigate to one bounded coordinate target without generic digging.'
    },
    safety: { capabilities: NONE, mutationAuthority: 'none' }
  }),
  contract({
    name: 'return_home',
    argsSchema: ReturnHomeArgsSchema,
    goal: true,
    decision: true,
    ai: {
      exposed: true,
      description: 'Return to the configured home location.'
    },
    safety: { capabilities: NONE, mutationAuthority: 'none' }
  }),
  contract({
    name: 'eat',
    argsSchema: EatArgsSchema,
    goal: true,
    decision: true,
    ai: {
      exposed: true,
      description: 'Eat one approved ordinary food item.'
    },
    safety: { capabilities: NONE, mutationAuthority: 'none' }
  }),
  contract({
    name: 'equip',
    argsSchema: EquipArgsSchema,
    goal: true,
    decision: true,
    ai: {
      exposed: true,
      description: 'Equip one exact inventory item to an approved destination.'
    },
    safety: { capabilities: NONE, mutationAuthority: 'none' }
  }),
  contract({
    name: 'find_resource',
    argsSchema: null,
    goal: false,
    decision: false,
    ai: { exposed: false, description: null },
    safety: { capabilities: NONE, mutationAuthority: 'none' }
  }),
  contract({
    name: 'gather_resource',
    argsSchema: GatherResourceArgsSchema,
    goal: true,
    decision: true,
    ai: { exposed: false, description: null },
    safety: {
      capabilities: Object.freeze(['break_blocks']),
      mutationAuthority: 'resource_break'
    }
  }),
  contract({
    name: 'explore_resource',
    argsSchema: ExploreResourceArgsSchema,
    goal: true,
    decision: true,
    ai: { exposed: false, description: null },
    safety: { capabilities: NONE, mutationAuthority: 'none' }
  }),
  contract({
    name: 'excavate_resource',
    argsSchema: ExcavateResourceArgsSchema,
    goal: true,
    decision: true,
    ai: { exposed: false, description: null },
    safety: {
      capabilities: Object.freeze(['break_blocks']),
      mutationAuthority: 'resource_break'
    }
  }),
  contract({
    name: 'acquire_resource',
    argsSchema: AcquireResourceArgsSchema,
    goal: true,
    decision: true,
    ai: {
      exposed: true,
      description: 'Acquire at least a bounded quantity of one resource through visible search, known resource memory, no-dig exploration, bounded excavation, and deterministic gathering.'
    },
    safety: { capabilities: NONE, mutationAuthority: 'none' }
  }),
  contract({
    name: 'deposit_item',
    argsSchema: DepositItemArgsSchema,
    goal: true,
    decision: true,
    ai: {
      exposed: true,
      description: 'Deposit an exact bounded quantity into one named storage target.'
    },
    safety: { capabilities: NONE, mutationAuthority: 'none' }
  }),
  contract({
    name: 'withdraw_item',
    argsSchema: WithdrawItemArgsSchema,
    goal: true,
    decision: true,
    ai: {
      exposed: true,
      description: 'Withdraw an exact bounded quantity from one named storage target.'
    },
    safety: { capabilities: NONE, mutationAuthority: 'none' }
  })
] as const satisfies readonly SkillContract[]

const CONTRACTS_BY_NAME = new Map(
  SKILL_CONTRACTS.map(entry => [entry.name, entry] as const)
)

if (
  CONTRACTS_BY_NAME.size !== SKILL_CONTRACTS.length ||
  SkillNameSchema.options.some(name => !CONTRACTS_BY_NAME.has(name))
) {
  throw new Error('skill contract catalog is incomplete or contains duplicates')
}

export type SkillContractEntry = typeof SKILL_CONTRACTS[number]
export type GoalSkillContract =
  Extract<SkillContractEntry, { readonly goal: true }>
export type DecisionSkillContract =
  Extract<SkillContractEntry, { readonly decision: true }>

type GoalRequestFor<T> =
  T extends {
    readonly name: infer N extends SkillName
    readonly argsSchema: infer S extends z.ZodType
  }
    ? { readonly kind: N; readonly args: z.infer<S> }
    : never

type DecisionActionFor<T> =
  T extends {
    readonly name: infer N extends SkillName
    readonly argsSchema: infer S extends z.ZodType
  }
    ? { readonly intent: N; readonly args: z.infer<S> }
    : never

export type GoalRequestFromCatalog =
  GoalRequestFor<GoalSkillContract>

export type DecisionActionFromCatalog =
  DecisionActionFor<DecisionSkillContract>

export type DecisionV1FromCatalog =
  DecisionActionFromCatalog extends infer Action
    ? Action extends {
        readonly intent: infer N extends SkillName
        readonly args: infer A
      }
      ? {
          readonly version: 1
          readonly intent: N
          readonly args: A
        }
      : never
    : never

export function skillContract(
  name: SkillName
): SkillContractEntry {
  const entry = CONTRACTS_BY_NAME.get(name)
  if (!entry) {
    throw new Error(`skill contract missing: ${name}`)
  }
  return entry
}

export function goalSkillContracts(): readonly GoalSkillContract[] {
  return SKILL_CONTRACTS.filter(
    entry => entry.goal
  ) as readonly GoalSkillContract[]
}

export function decisionSkillContracts(): readonly DecisionSkillContract[] {
  return SKILL_CONTRACTS.filter(
    entry => entry.decision
  ) as readonly DecisionSkillContract[]
}

export function aiExposedSkillContracts(): readonly SkillContractEntry[] {
  return SKILL_CONTRACTS.filter(
    entry => entry.ai.exposed && entry.ai.description !== null
  )
}
