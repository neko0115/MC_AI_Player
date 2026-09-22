import type {
  SkillResult
} from '../contracts/skills.js'
import type {
  GameKnowledgePack,
  WorkstationFact,
  WorldAcquisitionFact
} from '../knowledge/contracts.js'
import type {
  ProductionRuntime,
  ResolvedWorkstation
} from '../minecraft/production.js'
import type {
  SupplyPlan,
  SupplyStep
} from './planner.js'

export interface SupplyExecutionPorts {
  inventoryCount(item: string): number

  withdrawStorage(
    storageId: string,
    item: string,
    quantity: number,
    signal: AbortSignal
  ): Promise<SkillResult>

  acquireResource(
    fact: WorldAcquisitionFact,
    quantity: number,
    signal: AbortSignal,
    executionId?: string
  ): Promise<SkillResult>

  equipTool(
    item: string,
    signal: AbortSignal
  ): Promise<SkillResult>

  resolveWorkstation(
    fact: WorkstationFact,
    signal: AbortSignal
  ): Promise<ResolvedWorkstation | null>

  readonly production: ProductionRuntime
}

export async function executeSupplyPlan(
  pack: GameKnowledgePack,
  plan: SupplyPlan,
  ports: SupplyExecutionPorts,
  signal: AbortSignal,
  executionId?: string
): Promise<SkillResult> {
  if (signal.aborted) return cancelled(signal)

  const unresolved = plan.unresolved[0]
  if (unresolved) {
    return {
      status: 'failed',
      code: sanitizeCode(
        unresolved.code,
        'supply_plan_unresolved'
      )
    }
  }

  const workstations =
    new Map<string, ResolvedWorkstation>()

  for (const step of plan.steps) {
    if (signal.aborted) return cancelled(signal)

    const result = await executeStep(
      pack,
      step,
      ports,
      workstations,
      signal,
      executionId
    )
    if (result.status !== 'succeeded') return result
  }

  if (
    ports.inventoryCount(plan.requestedItem) <
    plan.requestedQuantity
  ) {
    return {
      status: 'failed',
      code: 'supply_output_mismatch'
    }
  }

  return {
    status: 'succeeded',
    code: 'item_acquired'
  }
}

async function executeStep(
  pack: GameKnowledgePack,
  step: SupplyStep,
  ports: SupplyExecutionPorts,
  workstations: Map<string, ResolvedWorkstation>,
  signal: AbortSignal,
  executionId?: string
): Promise<SkillResult> {
  switch (step.kind) {
    case 'use_inventory':
      return {
        status: 'succeeded',
        code: 'inventory_available'
      }

    case 'withdraw_storage':
      return ports.withdrawStorage(
        step.storageId,
        step.item,
        step.quantity,
        signal
      )

    case 'ensure_tool':
      return ports.equipTool(step.item, signal)

    case 'gather': {
      const fact = pack.worldAcquisition.find(
        candidate => candidate.id === step.routeId
      )
      if (
        !fact ||
        fact.resource !== step.resource ||
        fact.output.item !== step.item
      ) {
        return {
          status: 'failed',
          code: 'world_acquisition_fact_mismatch'
        }
      }

      const before = ports.inventoryCount(step.item)
      const result = await ports.acquireResource(
        fact,
        step.quantity,
        signal,
        executionId
      )
      if (result.status !== 'succeeded') return result

      const gained =
        ports.inventoryCount(step.item) - before
      if (gained < step.quantity) {
        return {
          status: 'failed',
          code: 'world_acquisition_output_mismatch'
        }
      }
      return {
        status: 'succeeded',
        code: 'world_item_acquired'
      }
    }

    case 'ensure_workstation': {
      const fact = workstationFact(
        pack,
        step.workstation
      )
      if (!fact) {
        return {
          status: 'failed',
          code: 'workstation_fact_missing'
        }
      }
      if (!requiresPhysicalWorkstation(fact)) {
        return {
          status: 'succeeded',
          code: 'workstation_ready'
        }
      }

      const resolved =
        await ports.resolveWorkstation(fact, signal)
      if (signal.aborted) return cancelled(signal)
      if (!resolved) {
        return {
          status: 'failed',
          code: 'workstation_unavailable'
        }
      }
      workstations.set(fact.id, resolved)
      return {
        status: 'succeeded',
        code: 'workstation_ready'
      }
    }

    case 'craft': {
      const recipe = pack.recipes.find(
        fact => fact.id === step.recipeId
      )
      if (!recipe) {
        return {
          status: 'failed',
          code: 'recipe_fact_missing'
        }
      }

      const workstation = workstationFact(
        pack,
        recipe.workstation
      )
      if (!workstation) {
        return {
          status: 'failed',
          code: 'workstation_fact_missing'
        }
      }

      const resolved =
        requiresPhysicalWorkstation(workstation)
          ? await resolveCachedWorkstation(
              workstation,
              ports,
              workstations,
              signal
            )
          : null
      if (
        requiresPhysicalWorkstation(workstation) &&
        !resolved
      ) {
        return signal.aborted
          ? cancelled(signal)
          : {
              status: 'failed',
              code: 'workstation_unavailable'
            }
      }

      return ports.production.craft(
        {
          recipeId: recipe.id,
          item: recipe.output.item,
          outputCountPerBatch: recipe.output.count,
          inputs: recipe.inputs,
          batches: step.batches,
          workstation: resolved
        },
        signal
      )
    }

    case 'process': {
      const processing = pack.processing.find(
        fact => fact.id === step.processingId
      )
      if (!processing) {
        return {
          status: 'failed',
          code: 'processing_fact_missing'
        }
      }

      const workstation = workstationFact(
        pack,
        processing.workstation
      )
      if (!workstation) {
        return {
          status: 'failed',
          code: 'workstation_fact_missing'
        }
      }

      const resolved = await resolveCachedWorkstation(
        workstation,
        ports,
        workstations,
        signal
      )
      if (!resolved) {
        return signal.aborted
          ? cancelled(signal)
          : {
              status: 'failed',
              code: 'workstation_unavailable'
            }
      }

      return ports.production.process(
        {
          processingId: processing.id,
          kind: processing.kind,
          input: processing.input.item,
          inputCountPerBatch: processing.input.count,
          output: processing.output.item,
          outputCountPerBatch: processing.output.count,
          batches: step.batches,
          cookTimeTicks: processing.cookTimeTicks,
          workstation: resolved,
          ...(step.fuelItem
            ? {
                fuel: step.fuelItem,
                fuelQuantity: step.fuelQuantity
              }
            : {})
        },
        signal
      )
    }
  }
}

async function resolveCachedWorkstation(
  fact: WorkstationFact,
  ports: SupplyExecutionPorts,
  cache: Map<string, ResolvedWorkstation>,
  signal: AbortSignal
): Promise<ResolvedWorkstation | null> {
  const cached = cache.get(fact.id)
  if (cached) return cached

  const resolved =
    await ports.resolveWorkstation(fact, signal)
  if (resolved) cache.set(fact.id, resolved)
  return resolved
}

function workstationFact(
  pack: GameKnowledgePack,
  id: string
): WorkstationFact | null {
  return pack.workstations.find(
    fact => fact.id === id
  ) ?? null
}

function requiresPhysicalWorkstation(
  fact: WorkstationFact
): boolean {
  return fact.blockIds.length > 0
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
        ? sanitizeCode(reason, 'cancelled')
        : 'cancelled'
  }
}

function sanitizeCode(
  value: string,
  fallback: string
): string {
  const normalized =
    value.trim().replace(/\s+/g, '_').slice(0, 128)
  return normalized || fallback
}
