import { z } from 'zod'
import { SkillNameSchema } from './skills.js'

const AtSchema = z.number().finite().nonnegative()
const EventCodeSchema = z.string().trim().min(1).max(128)
const PlayerNameSchema = z.string().trim().min(1).max(64)
const PlayerIdSchema = z.string().trim().min(1).max(128)
const TaskIdSchema = EventCodeSchema
const DecisionIdSchema = EventCodeSchema
const ModelNameSchema = z.string().trim().min(1).max(256)
const ThinkingLevelSchema = z.enum(['low', 'medium', 'high'])
const RouteClassSchema = z.enum(['routine', 'complex'])
const RouteReasonSchema = z.string().trim().min(1).max(128)
const RouteReasonsSchema = z.array(RouteReasonSchema).max(16)
const HighReasonSchema = z.enum([
  'manual_deep_think',
  'repeated_replanning',
  'critical_context'
])
const AnonymousProjectSchema = z
  .string()
  .regex(/^(primary|backup-[1-9][0-9]*)$/)
const TaskSourceSchema = z.enum(['minecraft', 'local_admin', 'system'])
const AttemptResultSchema = z.enum([
  'success',
  'credential_fatal',
  'quota_unavailable',
  'transient',
  'safety_terminal',
  'generation_retry',
  'configuration_error',
  'cancelled'
])

export const PositionSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite()
  })
  .strict()

export const PlayerSnapshotSchema = z
  .object({
    name: PlayerNameSchema,
    id: PlayerIdSchema.optional(),
    position: PositionSchema
  })
  .strict()

export const HostileSnapshotSchema = z
  .object({
    entityId: z.number().int().nonnegative(),
    kind: z.string().trim().min(1).max(128),
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
  z.object({ type: z.literal('position_changed'), at: AtSchema, position: PositionSchema }).strict(),
  z.object({ type: z.literal('player_seen'), at: AtSchema, player: PlayerSnapshotSchema }).strict(),
  z.object({ type: z.literal('hostile_seen'), at: AtSchema, hostile: HostileSnapshotSchema }).strict(),
  z
    .object({
      type: z.literal('hostile_left'),
      at: AtSchema,
      entityId: z.number().int().nonnegative()
    })
    .strict(),
  z
    .object({
      type: z.literal('player_left'),
      at: AtSchema,
      player: PlayerNameSchema,
      playerId: PlayerIdSchema.optional()
    })
    .strict(),
  z
    .object({
      type: z.literal('player_chat'),
      at: AtSchema,
      player: PlayerNameSchema,
      playerId: PlayerIdSchema.optional(),
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
  z.object({ type: z.literal('goal_started'), at: AtSchema, goalId: EventCodeSchema }).strict(),
  z
    .object({
      type: z.literal('goal_suspended'),
      at: AtSchema,
      goalId: EventCodeSchema,
      code: EventCodeSchema
    })
    .strict(),
  z.object({ type: z.literal('goal_resumed'), at: AtSchema, goalId: EventCodeSchema }).strict(),
  z.object({ type: z.literal('goal_completed'), at: AtSchema, goalId: EventCodeSchema }).strict(),
  z
    .object({
      type: z.literal('goal_cancelled'),
      at: AtSchema,
      goalId: EventCodeSchema,
      code: EventCodeSchema
    })
    .strict(),
  z
    .object({
      type: z.literal('goal_failed'),
      at: AtSchema,
      goalId: EventCodeSchema,
      code: EventCodeSchema
    })
    .strict(),
  z.object({ type: z.literal('skill_started'), at: AtSchema, skill: SkillNameSchema }).strict(),
  z.object({ type: z.literal('skill_completed'), at: AtSchema, skill: SkillNameSchema }).strict(),
  z
    .object({
      type: z.literal('skill_cancelled'),
      at: AtSchema,
      skill: SkillNameSchema,
      code: EventCodeSchema
    })
    .strict(),
  z
    .object({
      type: z.literal('skill_failed'),
      at: AtSchema,
      skill: SkillNameSchema,
      code: EventCodeSchema
    })
    .strict(),
  z
    .object({
      type: z.literal('server_capability_used'),
      at: AtSchema,
      capability: EventCodeSchema,
      resource: z.string().trim().min(1).max(128),
      maxChain: z.number().int().min(1).max(2304)
    })
    .strict(),
  z
    .object({
      type: z.literal('resource_search_phase'),
      at: AtSchema,
      resource: z.string().trim().min(1).max(128),
      phase: z.enum([
        'visible',
        'memory',
        'explore',
        'excavate',
        'gather'
      ]),
      direction: z
        .enum(['north', 'south', 'east', 'west'])
        .optional()
    })
    .strict(),
  z
    .object({
      type: z.literal('cooperative_pickup'),
      at: AtSchema,
      resource: z.string().trim().min(1).max(128),
      player: PlayerNameSchema,
      interceptedCount: z.number().int().min(1).max(2304),
      remaining: z.number().int().min(0).max(2304)
    })
    .strict(),
  z.object({ type: z.literal('emergency_stop'), at: AtSchema, reason: z.string().trim().min(1).max(500) }).strict(),
  z.object({ type: z.literal('decision_accepted'), at: AtSchema, intent: z.string().trim().min(1).max(64) }).strict(),
  z.object({ type: z.literal('decision_rejected'), at: AtSchema, code: EventCodeSchema }).strict(),
  z.object({ type: z.literal('memory_written'), at: AtSchema, memoryId: EventCodeSchema }).strict(),
  z.object({ type: z.literal('stuck'), at: AtSchema, code: EventCodeSchema.optional() }).strict(),
  z
    .object({
      type: z.literal('complexity_assessment'),
      at: AtSchema,
      decisionId: DecisionIdSchema,
      taskId: TaskIdSchema,
      score: z.number().int().nonnegative().max(100),
      routeClass: RouteClassSchema,
      thinking: ThinkingLevelSchema,
      reasons: RouteReasonsSchema,
      highReason: HighReasonSchema.nullable()
    })
    .strict(),
  z
    .object({
      type: z.literal('model_route'),
      at: AtSchema,
      decisionId: DecisionIdSchema,
      model: ModelNameSchema,
      thinking: ThinkingLevelSchema,
      project: AnonymousProjectSchema,
      reasons: RouteReasonsSchema,
      reserveAuthorized: z.boolean(),
      reserveUsed: z.boolean()
    })
    .strict(),
  z
    .object({
      type: z.literal('attempt_result'),
      at: AtSchema,
      decisionId: DecisionIdSchema,
      model: ModelNameSchema,
      project: AnonymousProjectSchema,
      result: AttemptResultSchema,
      safeCode: EventCodeSchema.optional()
    })
    .strict(),
  z
    .object({
      type: z.literal('ai_availability_changed'),
      at: AtSchema,
      available: z.boolean(),
      retryAt: AtSchema.nullable()
    })
    .strict(),
  z
    .object({
      type: z.literal('task_started'),
      at: AtSchema,
      taskId: TaskIdSchema,
      source: TaskSourceSchema
    })
    .strict(),
  z.object({ type: z.literal('task_completed'), at: AtSchema, taskId: TaskIdSchema }).strict(),
  z
    .object({
      type: z.literal('task_blocked'),
      at: AtSchema,
      taskId: TaskIdSchema,
      code: EventCodeSchema
    })
    .strict(),
  z
    .object({
      type: z.literal('task_superseded'),
      at: AtSchema,
      taskId: TaskIdSchema,
      code: EventCodeSchema
    })
    .strict()
])

export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>
export type Position = z.infer<typeof PositionSchema>
export type PlayerSnapshot = z.infer<typeof PlayerSnapshotSchema>
export type HostileSnapshot = z.infer<typeof HostileSnapshotSchema>
export type ItemStackSnapshot = z.infer<typeof ItemStackSnapshotSchema>
