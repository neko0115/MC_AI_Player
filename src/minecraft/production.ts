import type { Position } from '../contracts/events.js'
import type { SkillResult } from '../contracts/skills.js'
import type { ProcessingKind } from '../knowledge/contracts.js'
import { defineRuntimePort } from './runtime-ports.js'

export interface ResolvedWorkstation {
  readonly id: string
  readonly kind:
    | 'crafting_table'
    | 'furnace'
    | 'blast_furnace'
    | 'smoker'
    | 'stonecutter'
  readonly position: Position
  readonly expectedBlockNames: readonly string[]
}

export interface CraftItemRequest {
  readonly recipeId: string
  readonly item: string
  readonly batches: number
  readonly workstation: ResolvedWorkstation | null
}

export interface ProcessItemRequest {
  readonly processingId: string
  readonly kind: ProcessingKind
  readonly input: string
  readonly output: string
  readonly batches: number
  readonly workstation: ResolvedWorkstation
  readonly fuel?: string
  readonly fuelQuantity?: number
}

export interface ProductionRuntime {
  craft(
    request: CraftItemRequest,
    signal: AbortSignal
  ): Promise<SkillResult>

  process(
    request: ProcessItemRequest,
    signal: AbortSignal
  ): Promise<SkillResult>
}

export const PRODUCTION_RUNTIME_PORT =
  defineRuntimePort<ProductionRuntime>('minecraft.production')
