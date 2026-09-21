import { z } from 'zod'
import type {
  SkillContext,
  SkillDefinition,
  SkillResult
} from '../contracts/skills.js'
import {
  NamespacedIdSchema,
  ProcessingKindSchema
} from '../knowledge/contracts.js'
import type {
  ProductionRuntime,
  ResolvedWorkstation
} from '../minecraft/production.js'

const PositionSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite()
  })
  .strict()

const WorkstationKindSchema = z.enum([
  'crafting_table',
  'furnace',
  'blast_furnace',
  'smoker',
  'stonecutter'
])

const ResolvedWorkstationSchema = z
  .object({
    id: NamespacedIdSchema,
    kind: WorkstationKindSchema,
    position: PositionSchema,
    expectedBlockNames: z
      .array(z.string().min(1).max(128))
      .min(1)
      .max(16)
  })
  .strict()

export const CraftItemArgsSchema = z
  .object({
    recipeId: NamespacedIdSchema,
    item: NamespacedIdSchema,
    batches: z.number().int().min(1).max(2304),
    workstation: ResolvedWorkstationSchema.nullable()
  })
  .strict()

export const ProcessItemArgsSchema = z
  .object({
    processingId: NamespacedIdSchema,
    kind: ProcessingKindSchema,
    input: NamespacedIdSchema,
    output: NamespacedIdSchema,
    batches: z.number().int().min(1).max(2304),
    workstation: ResolvedWorkstationSchema,
    fuel: NamespacedIdSchema.optional(),
    fuelQuantity: z.number().int().min(1).max(2304).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.fuel === undefined) !== (value.fuelQuantity === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'fuel and fuelQuantity must be provided together'
      })
    }
  })

type CraftItemArgs = z.infer<typeof CraftItemArgsSchema>
type ProcessItemArgs = z.infer<typeof ProcessItemArgsSchema>

export class CraftItemSkill
  implements SkillDefinition<CraftItemArgs> {
  readonly name = 'craft_item' as const

  constructor(
    private readonly runtime: ProductionRuntime
  ) {}

  async execute(
    context: SkillContext,
    args: CraftItemArgs
  ): Promise<SkillResult> {
    if (context.signal.aborted) {
      return cancelled(context.signal)
    }

    const parsed = CraftItemArgsSchema.safeParse(args)
    if (!parsed.success) {
      return { status: 'failed', code: 'invalid_args' }
    }

    return this.runtime.craft(
      {
        recipeId: parsed.data.recipeId,
        item: parsed.data.item,
        batches: parsed.data.batches,
        workstation:
          parsed.data.workstation as ResolvedWorkstation | null
      },
      context.signal
    )
  }
}

export class ProcessItemSkill
  implements SkillDefinition<ProcessItemArgs> {
  readonly name = 'process_item' as const

  constructor(
    private readonly runtime: ProductionRuntime
  ) {}

  async execute(
    context: SkillContext,
    args: ProcessItemArgs
  ): Promise<SkillResult> {
    if (context.signal.aborted) {
      return cancelled(context.signal)
    }

    const parsed = ProcessItemArgsSchema.safeParse(args)
    if (!parsed.success) {
      return { status: 'failed', code: 'invalid_args' }
    }

    return this.runtime.process(
      {
        processingId: parsed.data.processingId,
        kind: parsed.data.kind,
        input: parsed.data.input,
        output: parsed.data.output,
        batches: parsed.data.batches,
        workstation:
          parsed.data.workstation as ResolvedWorkstation,
        ...(parsed.data.fuel
          ? {
              fuel: parsed.data.fuel,
              fuelQuantity: parsed.data.fuelQuantity!
            }
          : {})
      },
      context.signal
    )
  }
}

function cancelled(
  signal: AbortSignal
): SkillResult {
  const reason =
    typeof signal.reason === 'string'
      ? signal.reason.trim()
      : ''
  return {
    status: 'cancelled',
    code:
      reason
        ? reason.replace(/\s+/g, '_').slice(0, 128)
        : 'cancelled'
  }
}
