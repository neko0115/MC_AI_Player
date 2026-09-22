import type {
  GoalRequest
} from '../contracts/goals.js'
import type {
  SkillContext,
  SkillDefinition,
  SkillResult
} from '../contracts/skills.js'
import {
  AcquireItemArgsSchema
} from '../contracts/action-args.js'
import type {
  GameKnowledgePack,
  ItemQuantityRequest
} from '../knowledge/contracts.js'
import {
  executeSupplyPlan,
  type SupplyExecutionPorts
} from '../supply/executor.js'
import {
  planItemAcquisition,
  type SupplyPlanningState
} from '../supply/planner.js'

type AcquireItemArgs =
  Extract<GoalRequest, { kind: 'acquire_item' }>['args']

export interface ItemAcquisitionDependencies {
  readonly knowledge: GameKnowledgePack
  planningState(): SupplyPlanningState
  readonly execution: SupplyExecutionPorts
}

const MAX_ACQUIRED_ITEM_COUNT = 2304

export class AcquireItemSkill
  implements SkillDefinition<AcquireItemArgs> {
  readonly name = 'acquire_item' as const

  constructor(
    private readonly dependencies: ItemAcquisitionDependencies
  ) {}

  async execute(
    context: SkillContext,
    args: AcquireItemArgs
  ): Promise<SkillResult> {
    if (context.signal.aborted) {
      return cancelled(context.signal)
    }

    const parsed = AcquireItemArgsSchema.safeParse(args)
    if (!parsed.success) {
      return { status: 'failed', code: 'invalid_args' }
    }

    const request: ItemQuantityRequest =
      parsed.data.unit === 'stacks'
        ? {
            kind: 'stacks',
            stacks: parsed.data.quantity
          }
        : {
            kind: 'exact',
            quantity: parsed.data.quantity
          }

    let plan
    try {
      plan = planItemAcquisition(
        this.dependencies.knowledge,
        parsed.data.item,
        request,
        this.dependencies.planningState()
      )
    } catch (error) {
      return {
        status: 'failed',
        code: acquisitionPlanningFailureCode(error)
      }
    }

    if (
      plan.requestedQuantity < 1 ||
      plan.requestedQuantity > MAX_ACQUIRED_ITEM_COUNT
    ) {
      return {
        status: 'failed',
        code: 'invalid_quantity'
      }
    }

    return executeSupplyPlan(
      this.dependencies.knowledge,
      plan,
      this.dependencies.execution,
      context.signal,
      context.executionId
    )
  }
}

function acquisitionPlanningFailureCode(
  error: unknown
): string {
  const message =
    error instanceof Error
      ? error.message
      : String(error)

  if (message.startsWith('item_fact_missing:')) {
    return 'item_fact_missing'
  }
  if (message.startsWith('invalid_namespaced_id:')) {
    return 'invalid_item'
  }
  if (
    message === 'invalid_item_quantity' ||
    message === 'invalid_stack_count'
  ) {
    return 'invalid_quantity'
  }
  return 'supply_planning_failed'
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
