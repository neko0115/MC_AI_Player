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
    destination: z.enum([
      'hand',
      'off-hand',
      'head',
      'torso',
      'legs',
      'feet'
    ]).optional()
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

export const AcquireItemArgsSchema = z
  .object({
    item: IdentifierSchema,
    quantity: QuantitySchema,
    unit: z.enum(['items', 'stacks'])
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
