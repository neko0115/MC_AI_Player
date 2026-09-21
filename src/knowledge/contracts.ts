import { z } from 'zod'

const IDENTIFIER_PATTERN = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/

export const NamespacedIdSchema = z
  .string()
  .min(3)
  .max(160)
  .regex(IDENTIFIER_PATTERN)

export const PositiveCountSchema = z.number().int().positive()

export const IngredientRequirementSchema = z
  .object({
    item: NamespacedIdSchema,
    count: PositiveCountSchema
  })
  .strict()

export interface IngredientRequirement {
  readonly item: string
  readonly count: number
}

export const ItemFactSchema = z
  .object({
    id: NamespacedIdSchema,
    stackSize: z.number().int().positive()
  })
  .strict()

export interface ItemFact {
  readonly id: string
  readonly stackSize: number
}

export const ToolRequirementSchema = z
  .object({
    acceptedItems: z.array(NamespacedIdSchema).optional(),
    class: z.string().min(1).max(64).nullable(),
    minimumTier: z.string().min(1).max(64).nullable(),
    minimumTierRank: z.number().int().nonnegative().nullable(),
    requiredEnchantments: z.array(z.string().min(1).max(64)),
    forbiddenEnchantments: z.array(z.string().min(1).max(64))
  })
  .strict()

export interface ToolRequirement {
  readonly acceptedItems?: readonly string[]
  readonly class: string | null
  readonly minimumTier: string | null
  readonly minimumTierRank: number | null
  readonly requiredEnchantments: readonly string[]
  readonly forbiddenEnchantments: readonly string[]
}

export const WorldAcquisitionFactSchema = z
  .object({
    id: NamespacedIdSchema,
    resource: NamespacedIdSchema,
    output: IngredientRequirementSchema,
    blockIds: z.array(NamespacedIdSchema).min(1),
    minimumOnePerBlock: z.boolean(),
    tool: ToolRequirementSchema
  })
  .strict()

export interface WorldAcquisitionFact {
  readonly id: string
  readonly resource: string
  readonly output: IngredientRequirement
  readonly blockIds: readonly string[]
  readonly minimumOnePerBlock: boolean
  readonly tool: ToolRequirement
}

export const RecipeFactSchema = z
  .object({
    id: NamespacedIdSchema,
    output: IngredientRequirementSchema,
    inputs: z.array(IngredientRequirementSchema).min(1),
    workstation: NamespacedIdSchema
  })
  .strict()

export interface RecipeFact {
  readonly id: string
  readonly output: IngredientRequirement
  readonly inputs: readonly IngredientRequirement[]
  readonly workstation: string
}

export const ProcessingKindSchema = z.enum([
  'smelting',
  'blasting',
  'smoking',
  'stonecutting'
])

export type ProcessingKind = z.infer<typeof ProcessingKindSchema>

export const ProcessingFactSchema = z
  .object({
    id: NamespacedIdSchema,
    kind: ProcessingKindSchema,
    input: IngredientRequirementSchema,
    output: IngredientRequirementSchema,
    workstation: NamespacedIdSchema,
    cookTimeTicks: z.number().int().positive().nullable()
  })
  .strict()

export interface ProcessingFact {
  readonly id: string
  readonly kind: ProcessingKind
  readonly input: IngredientRequirement
  readonly output: IngredientRequirement
  readonly workstation: string
  readonly cookTimeTicks: number | null
}

export const FuelFactSchema = z
  .object({
    item: NamespacedIdSchema,
    burnTimeTicks: z.number().int().positive()
  })
  .strict()

export interface FuelFact {
  readonly item: string
  readonly burnTimeTicks: number
}

export const ToolFactSchema = z
  .object({
    item: NamespacedIdSchema,
    class: z.string().min(1).max(64),
    tier: z.string().min(1).max(64).nullable(),
    tierRank: z.number().int().nonnegative().nullable(),
    maxDurability: z.number().int().positive().nullable()
  })
  .strict()

export interface ToolFact {
  readonly item: string
  readonly class: string
  readonly tier: string | null
  readonly tierRank: number | null
  readonly maxDurability: number | null
}

export const WorkstationFactSchema = z
  .object({
    id: NamespacedIdSchema,
    item: NamespacedIdSchema.nullable(),
    blockIds: z.array(NamespacedIdSchema),
    supportedKinds: z.array(
      z.enum([
        'crafting',
        'smelting',
        'blasting',
        'smoking',
        'stonecutting'
      ])
    )
  })
  .strict()

export interface WorkstationFact {
  readonly id: string
  readonly item: string | null
  readonly blockIds: readonly string[]
  readonly supportedKinds: readonly (
    | 'crafting'
    | 'smelting'
    | 'blasting'
    | 'smoking'
    | 'stonecutting'
  )[]
}

export const GameKnowledgePackSchema = z
  .object({
    schemaVersion: z.literal(1),
    edition: z.literal('java'),
    minecraftVersion: z.string().min(1).max(64),
    items: z.array(ItemFactSchema),
    worldAcquisition: z.array(WorldAcquisitionFactSchema),
    recipes: z.array(RecipeFactSchema),
    processing: z.array(ProcessingFactSchema),
    fuels: z.array(FuelFactSchema),
    tools: z.array(ToolFactSchema),
    workstations: z.array(WorkstationFactSchema)
  })
  .strict()

export interface GameKnowledgePack {
  readonly schemaVersion: 1
  readonly edition: 'java'
  readonly minecraftVersion: string
  readonly items: readonly ItemFact[]
  readonly worldAcquisition: readonly WorldAcquisitionFact[]
  readonly recipes: readonly RecipeFact[]
  readonly processing: readonly ProcessingFact[]
  readonly fuels: readonly FuelFact[]
  readonly tools: readonly ToolFact[]
  readonly workstations: readonly WorkstationFact[]
}

export type ItemQuantityRequest =
  | { readonly kind: 'exact'; readonly quantity: number }
  | { readonly kind: 'stacks'; readonly stacks: number }

export function parseGameKnowledgePack(
  value: unknown
): GameKnowledgePack {
  const pack = GameKnowledgePackSchema.parse(value)
  validateKnowledgePackReferences(pack)
  return pack
}

export function resolveItemQuantity(
  pack: GameKnowledgePack,
  item: string,
  request: ItemQuantityRequest
): number {
  const normalizedItem = normalizeNamespacedId(item)
  const fact = pack.items.find(candidate => candidate.id === normalizedItem)
  if (!fact) {
    throw new Error(`item_fact_missing:${normalizedItem}`)
  }

  if (request.kind === 'exact') {
    if (!Number.isInteger(request.quantity) || request.quantity <= 0) {
      throw new Error('invalid_item_quantity')
    }
    return request.quantity
  }

  if (!Number.isInteger(request.stacks) || request.stacks <= 0) {
    throw new Error('invalid_stack_count')
  }
  return request.stacks * fact.stackSize
}

export function normalizeNamespacedId(value: string): string {
  const normalized = value.trim().toLowerCase()
  const namespaced = normalized.includes(':')
    ? normalized
    : `minecraft:${normalized}`
  if (!IDENTIFIER_PATTERN.test(namespaced)) {
    throw new Error(`invalid_namespaced_id:${value}`)
  }
  return namespaced
}

export function validateKnowledgePackReferences(
  pack: GameKnowledgePack
): void {
  assertUnique(pack.items.map(value => value.id), 'item')
  assertUnique(pack.worldAcquisition.map(value => value.id), 'world_acquisition')
  assertUnique(pack.recipes.map(value => value.id), 'recipe')
  assertUnique(pack.processing.map(value => value.id), 'processing')
  assertUnique(pack.fuels.map(value => value.item), 'fuel')
  assertUnique(pack.tools.map(value => value.item), 'tool')
  assertUnique(pack.workstations.map(value => value.id), 'workstation')

  const items = new Set(pack.items.map(value => value.id))
  const workstations = new Set(pack.workstations.map(value => value.id))

  const requireItem = (item: string, source: string): void => {
    if (!items.has(item)) {
      throw new Error(`knowledge_unknown_item:${source}:${item}`)
    }
  }

  for (const fact of pack.worldAcquisition) {
    requireItem(fact.output.item, fact.id)
    for (const toolItem of fact.tool.acceptedItems ?? []) {
      requireItem(toolItem, `harvest_tool:${fact.id}`)
    }
    if (
      fact.tool.requiredEnchantments.length > 0 &&
      fact.tool.class === null &&
      (fact.tool.acceptedItems?.length ?? 0) === 0
    ) {
      throw new Error(
        `knowledge_invalid_tool_requirement:${fact.id}`
      )
    }
  }

  for (const fact of pack.recipes) {
    requireItem(fact.output.item, fact.id)
    for (const input of fact.inputs) {
      requireItem(input.item, fact.id)
    }
    requireWorkstation(workstations, fact.workstation, fact.id)
  }

  for (const fact of pack.processing) {
    requireItem(fact.input.item, fact.id)
    requireItem(fact.output.item, fact.id)
    requireWorkstation(workstations, fact.workstation, fact.id)
  }

  for (const fact of pack.fuels) {
    requireItem(fact.item, `fuel:${fact.item}`)
  }

  for (const fact of pack.tools) {
    requireItem(fact.item, `tool:${fact.item}`)
  }

  for (const fact of pack.workstations) {
    if (fact.item !== null) {
      requireItem(fact.item, `workstation:${fact.id}`)
    }
  }
}

function requireWorkstation(
  workstations: ReadonlySet<string>,
  workstation: string,
  source: string
): void {
  if (!workstations.has(workstation)) {
    throw new Error(
      `knowledge_unknown_workstation:${source}:${workstation}`
    )
  }
}

function assertUnique(
  values: readonly string[],
  kind: string
): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`knowledge_duplicate_${kind}:${value}`)
    }
    seen.add(value)
  }
}
