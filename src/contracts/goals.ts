import { z } from 'zod'

const IdentifierSchema = z.string().trim().min(1).max(128)
const PlayerNameSchema = z.string().trim().min(1).max(64)
const QuantitySchema = z.number().int().min(1).max(2304)
const CoordinateSchema = z.number().finite()

export const FollowPlayerArgsSchema = z
  .object({
    player: PlayerNameSchema,
    range: z.number().finite().min(1).max(16).optional()
  })
  .strict()

export const StayArgsSchema = z.object({}).strict()

export const GoToArgsSchema = z
  .object({
    x: CoordinateSchema,
    y: CoordinateSchema,
    z: CoordinateSchema,
    radius: z.number().finite().min(0).max(16).optional()
  })
  .strict()

export const ReturnHomeArgsSchema = z.object({}).strict()
export const EatArgsSchema = z.object({}).strict()

export const EquipArgsSchema = z
  .object({
    item: IdentifierSchema,
    destination: z.enum(['hand', 'off-hand', 'head', 'torso', 'legs', 'feet']).optional()
  })
  .strict()

export const GatherResourceArgsSchema = z
  .object({
    resource: IdentifierSchema,
    quantity: QuantitySchema
  })
  .strict()

export const ExploreResourceArgsSchema = z
  .object({
    resource: IdentifierSchema,
    radius: z.number().int().min(4).max(64).optional(),
    maxSteps: z.number().int().min(1).max(16).optional()
  })
  .strict()

export const ExcavateResourceArgsSchema = z
  .object({
    resource: IdentifierSchema,
    direction: z.enum(['north', 'south', 'east', 'west']),
    maxLength: z.number().int().min(1).max(16).optional(),
    radius: z.number().int().min(2).max(8).optional()
  })
  .strict()

export const AcquireResourceArgsSchema = z
  .object({
    resource: IdentifierSchema,
    quantity: QuantitySchema,
    exploreRadius: z.number().int().min(4).max(64).optional(),
    exploreSteps: z.number().int().min(1).max(16).optional(),
    excavateLength: z.number().int().min(1).max(16).optional()
  })
  .strict()


export const DepositItemArgsSchema = z
  .object({
    item: IdentifierSchema,
    quantity: QuantitySchema,
    storage: IdentifierSchema
  })
  .strict()

export const WithdrawItemArgsSchema = z
  .object({
    item: IdentifierSchema,
    quantity: QuantitySchema,
    storage: IdentifierSchema
  })
  .strict()

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
