import type {
  SkillContext,
  SkillResult
} from '../contracts/skills.js'
import type {
  WorkstationFact,
  WorldAcquisitionFact
} from '../knowledge/contracts.js'
import type {
  ContainerTransactionAdapter,
  ResolvedStorageTarget,
  SurvivalInventoryAdapter
} from '../minecraft/adapter.js'
import type {
  ProductionRuntime,
  ResolvedWorkstation
} from '../minecraft/production.js'
import type {
  SupplyExecutionPorts
} from './executor.js'

export interface ResourceAcquisitionLeaf {
  execute(
    context: SkillContext,
    args: {
      readonly fact: WorldAcquisitionFact
      readonly quantity: number
    }
  ): Promise<SkillResult>
}

export interface AuthorizedStorageResolver {
  resolve(
    storageId: string,
    signal: AbortSignal
  ): Promise<ResolvedStorageTarget | null>
}

export interface AuthorizedWorkstationResolver {
  resolve(
    fact: WorkstationFact,
    signal: AbortSignal
  ): Promise<ResolvedWorkstation | null>
}

export interface SupplyRuntimeAdapterDependencies {
  readonly inventory:
    SurvivalInventoryAdapter & ContainerTransactionAdapter
  readonly resourceAcquisition: ResourceAcquisitionLeaf
  readonly production: ProductionRuntime
  readonly storageResolver?: AuthorizedStorageResolver
  readonly workstationResolver?: AuthorizedWorkstationResolver
}

export class SupplyRuntimeAdapter
implements SupplyExecutionPorts {
  constructor(
    private readonly dependencies:
      SupplyRuntimeAdapterDependencies
  ) {}

  inventoryCount(item: string): number {
    const runtimeName = toRuntimeItemName(item)
    return this.dependencies.inventory
      .inventoryItems()
      .filter(stack =>
        normalizeRuntimeItemName(stack.name) === runtimeName
      )
      .reduce(
        (total, stack) =>
          total + Math.max(0, Math.floor(stack.count)),
        0
      )
  }

  async withdrawStorage(
    storageId: string,
    item: string,
    quantity: number,
    signal: AbortSignal
  ): Promise<SkillResult> {
    if (signal.aborted) return cancelled(signal)

    const resolver =
      this.dependencies.storageResolver
    if (!resolver) {
      return {
        status: 'failed',
        code: 'storage_unavailable'
      }
    }

    const target =
      await resolver.resolve(storageId, signal)
    if (signal.aborted) return cancelled(signal)
    if (!target) {
      return {
        status: 'failed',
        code: 'storage_not_found'
      }
    }

    return this.dependencies.inventory
      .transferContainerItem(
        target,
        'withdraw',
        toRuntimeItemName(item),
        quantity,
        signal
      )
  }

  async acquireResource(
    fact: WorldAcquisitionFact,
    quantity: number,
    signal: AbortSignal,
    executionId?: string
  ): Promise<SkillResult> {
    if (signal.aborted) return cancelled(signal)
    return this.dependencies.resourceAcquisition.execute(
      {
        signal,
        ...(executionId ? { executionId } : {})
      },
      {
        fact,
        quantity
      }
    )
  }

  async equipTool(
    item: string,
    signal: AbortSignal
  ): Promise<SkillResult> {
    if (signal.aborted) return cancelled(signal)
    return this.dependencies.inventory
      .equipInventoryItem(
        toRuntimeItemName(item),
        'hand',
        signal
      )
  }

  async resolveWorkstation(
    fact: WorkstationFact,
    signal: AbortSignal
  ): Promise<ResolvedWorkstation | null> {
    if (signal.aborted) return null
    const resolver =
      this.dependencies.workstationResolver
    if (!resolver) return null
    return resolver.resolve(fact, signal)
  }

  get production(): ProductionRuntime {
    return this.dependencies.production
  }
}

export function toCanonicalItemId(
  runtimeName: string
): string {
  const normalized =
    normalizeRuntimeItemName(runtimeName)
  return normalized.includes(':')
    ? normalized
    : `minecraft:${normalized}`
}

export function toRuntimeItemName(
  canonicalId: string
): string {
  const normalized =
    canonicalId.trim().toLowerCase()
  const separator = normalized.indexOf(':')
  if (separator < 0) return normalized

  const namespace = normalized.slice(0, separator)
  const path = normalized.slice(separator + 1)
  return namespace === 'minecraft'
    ? path
    : normalized
}

function normalizeRuntimeItemName(
  value: string
): string {
  return value.trim().toLowerCase()
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
