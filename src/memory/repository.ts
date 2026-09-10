import { z } from 'zod'
import type { Position } from '../contracts/events.js'

export const MinecraftMemoryTypeSchema = z.enum([
  'landmark',
  'structure',
  'storage',
  'resource',
  'hazard',
  'player_instruction',
  'route',
  'episode',
  'task_history'
])

export type MinecraftMemoryType = z.infer<typeof MinecraftMemoryTypeSchema>

export const MemoryPositionSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite()
  })
  .strict()

const ContentSchema = z.string().trim().min(1).max(2000)
const DimensionSchema = z.string().trim().min(1).max(128)
const TagSchema = z.string().trim().min(1).max(64)

export const MinecraftMemoryInputSchema = z
  .object({
    type: MinecraftMemoryTypeSchema,
    content: ContentSchema,
    dimension: DimensionSchema.optional(),
    position: MemoryPositionSchema.optional(),
    tags: z.array(TagSchema).max(32).optional(),
    importance: z.number().finite().min(0).max(1).optional(),
    observedAt: z.number().int().nonnegative()
  })
  .strict()

export type MinecraftMemoryInput = z.input<typeof MinecraftMemoryInputSchema>

export interface MinecraftMemory {
  readonly id: string
  readonly type: MinecraftMemoryType
  readonly content: string
  readonly dimension: string | null
  readonly position: Position | null
  readonly tags: readonly string[]
  readonly importance: number
  readonly observedAt: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly reinforcementCount: number
}

export const MemorySearchQuerySchema = z
  .object({
    text: z.string().trim().min(1).max(500).optional(),
    types: z.array(MinecraftMemoryTypeSchema).min(1).max(9).optional(),
    dimension: DimensionSchema.optional(),
    tags: z.array(TagSchema).min(1).max(32).optional(),
    near: z
      .object({
        position: MemoryPositionSchema,
        radius: z.number().finite().positive().max(1_000_000)
      })
      .strict()
      .optional(),
    limit: z.number().int().min(1).max(50).optional()
  })
  .strict()

export type MemorySearchQuery = z.input<typeof MemorySearchQuerySchema>

export interface MinecraftMemoryRepository {
  remember(input: MinecraftMemoryInput): MinecraftMemory
  search(query: MemorySearchQuery): MinecraftMemory[]
  forget(id: string): boolean
  close(): void
}
