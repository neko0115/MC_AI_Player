import {
  DepositItemArgsSchema,
  WithdrawItemArgsSchema
} from '../contracts/goals.js'
import type { SkillContext, SkillDefinition, SkillResult } from '../contracts/skills.js'
import type {
  ContainerTransactionAdapter,
  ResolvedStorageTarget
} from '../minecraft/adapter.js'

export interface StorageResolver {
  resolve(storageId: string, signal: AbortSignal): Promise<ResolvedStorageTarget | null>
}

type DepositArgs = typeof DepositItemArgsSchema._output
type WithdrawArgs = typeof WithdrawItemArgsSchema._output

abstract class BaseInventoryTransactionSkill<A> implements SkillDefinition<A> {
  abstract readonly name: 'deposit_item' | 'withdraw_item'
  protected abstract readonly direction: 'deposit' | 'withdraw'

  constructor(
    protected readonly adapter: ContainerTransactionAdapter,
    protected readonly storageResolver: StorageResolver
  ) {}

  protected async transfer(
    context: SkillContext,
    item: string,
    quantity: number,
    storage: string
  ): Promise<SkillResult> {
    if (context.signal.aborted) return cancelled(context.signal)
    if (item.trim() === '*') {
      return { status: 'failed', code: 'wildcard_not_allowed' }
    }

    const target = await this.storageResolver.resolve(storage, context.signal)
    if (context.signal.aborted) return cancelled(context.signal)
    if (!target) {
      return { status: 'failed', code: 'storage_not_found' }
    }
    if (target.expectedBlockNames.length === 0) {
      return { status: 'failed', code: 'invalid_storage_target' }
    }

    return this.adapter.transferContainerItem(
      target,
      this.direction,
      item,
      quantity,
      context.signal
    )
  }

  abstract execute(context: SkillContext, args: A): Promise<SkillResult>
}

export class DepositItemSkill extends BaseInventoryTransactionSkill<DepositArgs> {
  readonly name = 'deposit_item' as const
  protected readonly direction = 'deposit' as const

  async execute(context: SkillContext, args: DepositArgs): Promise<SkillResult> {
    const parsed = DepositItemArgsSchema.safeParse(args)
    if (!parsed.success) {
      return { status: 'failed', code: 'invalid_args' }
    }
    return this.transfer(
      context,
      parsed.data.item,
      parsed.data.quantity,
      parsed.data.storage
    )
  }
}

export class WithdrawItemSkill extends BaseInventoryTransactionSkill<WithdrawArgs> {
  readonly name = 'withdraw_item' as const
  protected readonly direction = 'withdraw' as const

  async execute(context: SkillContext, args: WithdrawArgs): Promise<SkillResult> {
    const parsed = WithdrawItemArgsSchema.safeParse(args)
    if (!parsed.success) {
      return { status: 'failed', code: 'invalid_args' }
    }
    return this.transfer(
      context,
      parsed.data.item,
      parsed.data.quantity,
      parsed.data.storage
    )
  }
}

function cancelled(signal: AbortSignal): SkillResult {
  const reason = typeof signal.reason === 'string' ? signal.reason.trim() : ''
  return {
    status: 'cancelled',
    code: reason ? reason.replace(/\s+/g, '_').slice(0, 128) : 'cancelled'
  }
}
