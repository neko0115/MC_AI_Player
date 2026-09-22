import { z } from 'zod'
import {
  goalSkillContracts,
  type GoalRequestFromCatalog
} from './skill-catalog.js'

export {
  AcquireItemArgsSchema,
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

export type GoalRequest = GoalRequestFromCatalog
export type GoalKind = GoalRequest['kind']

const goalVariants = goalSkillContracts().map(entry => {
  if (entry.argsSchema === null) {
    throw new Error(`goal skill is missing args schema: ${entry.name}`)
  }
  return z
    .object({
      kind: z.literal(entry.name),
      args: entry.argsSchema
    })
    .strict()
})

export const GoalRequestSchema: z.ZodType<GoalRequest> =
  schemaUnion<GoalRequest>(goalVariants)

export type GoalStatus =
  | 'queued'
  | 'running'
  | 'suspended'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
export type GoalSource = 'player' | 'ai' | 'system'

export interface GoalRecord {
  goalId: string
  request: GoalRequest
  status: GoalStatus
  source: GoalSource
  createdAt: number
  updatedAt: number
}

function schemaUnion<T>(
  schemas: readonly z.ZodType[]
): z.ZodType<T> {
  if (schemas.length < 2) {
    throw new Error('goal action catalog must contain at least two entries')
  }
  return z.union(
    schemas as [z.ZodType, z.ZodType, ...z.ZodType[]]
  ) as z.ZodType<T>
}
