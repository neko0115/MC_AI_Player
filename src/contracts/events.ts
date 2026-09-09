import { z } from 'zod'
import { SkillNameSchema } from './skills.js'

const AtSchema = z.number().finite().nonnegative()

export const PositionSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite()
  })
  .strict()

export const PlayerSnapshotSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    id: z.string().trim().min(1).max(128).optional(),
    position: PositionSchema
  })
  .strict()

export const ItemStackSnapshotSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    count: z.number().int().min(1).max(2304),
    slot: z.number().int().nonnegative().optional()
  })
  .strict()

export const RuntimeEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('connected'), at: AtSchema }).strict(),
  z.object({ type: z.literal('disconnected'), at: AtSchema, reason: z.string().max(500).optional() }).strict(),
  z
    .object({
      type: z.literal('adapter_error'),
      at: AtSchema,
      code: z.enum(['kicked', 'error', 'reconnect_exhausted']),
      message: z.string().max(500).optional()
    })
    .strict(),
  z
    .object({
      type: z.literal('spawned'),
      at: AtSchema,
      dimension: z.string().trim().min(1).max(128),
      position: PositionSchema,
      health: z.number().finite().min(0).max(40),
      food: z.number().finite().min(0).max(20)
    })
    .strict(),
  z.object({ type: z.literal('player_seen'), at: AtSchema, player: PlayerSnapshotSchema }).strict(),
  z
    .object({
      type: z.literal('player_chat'),
      at: AtSchema,
      player: z.string().trim().min(1).max(64),
      message: z.string().max(1000)
    })
    .strict(),
  z
    .object({
      type: z.literal('health_changed'),
      at: AtSchema,
      health: z.number().finite().min(0).max(40),
      food: z.number().finite().min(0).max(20)
    })
    .strict(),
  z.object({ type: z.literal('inventory_changed'), at: AtSchema, items: z.array(ItemStackSnapshotSchema).max(256) }).strict(),
  z.object({ type: z.literal('goal_started'), at: AtSchema, goalId: z.string().trim().min(1).max(128) }).strict(),
  z.object({ type: z.literal('goal_completed'), at: AtSchema, goalId: z.string().trim().min(1).max(128) }).strict(),
  z
    .object({
      type: z.literal('goal_failed'),
      at: AtSchema,
      goalId: z.string().trim().min(1).max(128),
      code: z.string().trim().min(1).max(128)
    })
    .strict(),
  z.object({ type: z.literal('skill_started'), at: AtSchema, skill: SkillNameSchema }).strict(),
  z.object({ type: z.literal('skill_completed'), at: AtSchema, skill: SkillNameSchema }).strict(),
  z
    .object({
      type: z.literal('skill_failed'),
      at: AtSchema,
      skill: SkillNameSchema,
      code: z.string().trim().min(1).max(128)
    })
    .strict(),
  z.object({ type: z.literal('emergency_stop'), at: AtSchema, reason: z.string().trim().min(1).max(500) }).strict(),
  z.object({ type: z.literal('decision_accepted'), at: AtSchema, intent: z.string().trim().min(1).max(64) }).strict(),
  z.object({ type: z.literal('decision_rejected'), at: AtSchema, code: z.string().trim().min(1).max(128) }).strict(),
  z.object({ type: z.literal('memory_written'), at: AtSchema, memoryId: z.string().trim().min(1).max(128) }).strict(),
  z.object({ type: z.literal('stuck'), at: AtSchema, code: z.string().trim().min(1).max(128).optional() }).strict()
])

export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>
export type Position = z.infer<typeof PositionSchema>
export type PlayerSnapshot = z.infer<typeof PlayerSnapshotSchema>
export type ItemStackSnapshot = z.infer<typeof ItemStackSnapshotSchema>
