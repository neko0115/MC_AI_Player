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

export {
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

export const GoalRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('follow_player'), args: FollowPlayerArgsSchema }).strict(),
  z.object({ kind: z.literal('stay'), args: StayArgsSchema }).strict(),
  z.object({ kind: z.literal('go_to'), args: GoToArgsSchema }).strict(),
  z.object({ kind: z.literal('return_home'), args: ReturnHomeArgsSchema }).strict(),
  z.object({ kind: z.literal('eat'), args: EatArgsSchema }).strict(),
  z.object({ kind: z.literal('equip'), args: EquipArgsSchema }).strict(),
  z.object({ kind: z.literal('gather_resource'), args: GatherResourceArgsSchema }).strict(),
  z.object({ kind: z.literal('explore_resource'), args: ExploreResourceArgsSchema }).strict(),
  z.object({ kind: z.literal('excavate_resource'), args: ExcavateResourceArgsSchema }).strict(),
  z.object({ kind: z.literal('acquire_resource'), args: AcquireResourceArgsSchema }).strict(),
  z.object({ kind: z.literal('deposit_item'), args: DepositItemArgsSchema }).strict(),
  z.object({ kind: z.literal('withdraw_item'), args: WithdrawItemArgsSchema }).strict()
])

export type GoalRequest = z.infer<typeof GoalRequestSchema>
export type GoalKind = GoalRequest['kind']

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
