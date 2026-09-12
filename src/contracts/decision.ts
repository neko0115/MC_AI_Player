import { z } from 'zod'
import {
  DepositItemArgsSchema,
  EatArgsSchema,
  EquipArgsSchema,
  FollowPlayerArgsSchema,
  GatherResourceArgsSchema,
  GoToArgsSchema,
  ReturnHomeArgsSchema,
  StayArgsSchema,
  WithdrawItemArgsSchema
} from './goals.js'

export const DecisionV1Schema = z.discriminatedUnion('intent', [
  z.object({ version: z.literal(1), intent: z.literal('follow_player'), args: FollowPlayerArgsSchema }).strict(),
  z.object({ version: z.literal(1), intent: z.literal('stay'), args: StayArgsSchema }).strict(),
  z.object({ version: z.literal(1), intent: z.literal('go_to'), args: GoToArgsSchema }).strict(),
  z.object({ version: z.literal(1), intent: z.literal('return_home'), args: ReturnHomeArgsSchema }).strict(),
  z.object({ version: z.literal(1), intent: z.literal('eat'), args: EatArgsSchema }).strict(),
  z.object({ version: z.literal(1), intent: z.literal('equip'), args: EquipArgsSchema }).strict(),
  z.object({ version: z.literal(1), intent: z.literal('gather_resource'), args: GatherResourceArgsSchema }).strict(),
  z.object({ version: z.literal(1), intent: z.literal('deposit_item'), args: DepositItemArgsSchema }).strict(),
  z.object({ version: z.literal(1), intent: z.literal('withdraw_item'), args: WithdrawItemArgsSchema }).strict()
])

const DecisionActionSchema = z.discriminatedUnion('intent', [
  z.object({ intent: z.literal('follow_player'), args: FollowPlayerArgsSchema }).strict(),
  z.object({ intent: z.literal('stay'), args: StayArgsSchema }).strict(),
  z.object({ intent: z.literal('go_to'), args: GoToArgsSchema }).strict(),
  z.object({ intent: z.literal('return_home'), args: ReturnHomeArgsSchema }).strict(),
  z.object({ intent: z.literal('eat'), args: EatArgsSchema }).strict(),
  z.object({ intent: z.literal('equip'), args: EquipArgsSchema }).strict(),
  z.object({ intent: z.literal('gather_resource'), args: GatherResourceArgsSchema }).strict(),
  z.object({ intent: z.literal('deposit_item'), args: DepositItemArgsSchema }).strict(),
  z.object({ intent: z.literal('withdraw_item'), args: WithdrawItemArgsSchema }).strict()
])

export const DecisionBlockedReasonSchema = z.enum([
  'no_safe_action',
  'missing_information',
  'capability_unavailable'
])

export const DecisionOutcomeV2Schema = z.discriminatedUnion('outcome', [
  z
    .object({
      version: z.literal(2),
      outcome: z.literal('action'),
      action: DecisionActionSchema
    })
    .strict(),
  z
    .object({
      version: z.literal(2),
      outcome: z.literal('complete')
    })
    .strict(),
  z
    .object({
      version: z.literal(2),
      outcome: z.literal('blocked'),
      reason: DecisionBlockedReasonSchema
    })
    .strict()
])

export type DecisionV1 = z.infer<typeof DecisionV1Schema>
export type DecisionIntent = DecisionV1['intent']
export type DecisionOutcomeV2 = z.infer<typeof DecisionOutcomeV2Schema>
export type DecisionAction = z.infer<typeof DecisionActionSchema>
export type DecisionBlockedReason = z.infer<typeof DecisionBlockedReasonSchema>
