import { EatArgsSchema, EquipArgsSchema } from '../contracts/goals.js'
import type { SkillContext, SkillDefinition, SkillResult } from '../contracts/skills.js'
import type {
  EquipmentSlot,
  SurvivalInventoryAdapter
} from '../minecraft/adapter.js'

export interface EatSkillOptions {
  readonly preferredFood: readonly string[]
  readonly excludedItems: readonly string[]
}

type EatArgs = typeof EatArgsSchema._output
type EquipArgs = typeof EquipArgsSchema._output

export class EatSkill implements SkillDefinition<EatArgs> {
  readonly name = 'eat' as const
  private readonly preferredFood: readonly string[]
  private readonly excludedItems: ReadonlySet<string>

  constructor(
    private readonly adapter: SurvivalInventoryAdapter,
    options: EatSkillOptions
  ) {
    this.preferredFood = [...new Set(options.preferredFood.map(normalizeName).filter(Boolean))]
    this.excludedItems = new Set(options.excludedItems.map(normalizeName).filter(Boolean))
  }

  async execute(context: SkillContext, args: EatArgs): Promise<SkillResult> {
    if (context.signal.aborted) return cancelled(context.signal)
    if (!EatArgsSchema.safeParse(args).success) {
      return { status: 'failed', code: 'invalid_args' }
    }

    const available = new Set(
      this.adapter
        .inventoryItems()
        .filter(stack => stack.count > 0)
        .map(stack => normalizeName(stack.name))
    )

    const selected = this.preferredFood.find(
      item => !this.excludedItems.has(item) && available.has(item)
    )
    if (!selected) {
      return { status: 'failed', code: 'no_approved_food' }
    }

    return this.adapter.consumeInventoryItem(selected, context.signal)
  }
}

export class EquipSkill implements SkillDefinition<EquipArgs> {
  readonly name = 'equip' as const

  constructor(private readonly adapter: SurvivalInventoryAdapter) {}

  async execute(context: SkillContext, args: EquipArgs): Promise<SkillResult> {
    if (context.signal.aborted) return cancelled(context.signal)
    const parsed = EquipArgsSchema.safeParse(args)
    if (!parsed.success) {
      return { status: 'failed', code: 'invalid_args' }
    }

    return this.adapter.equipInventoryItem(
      parsed.data.item,
      parsed.data.destination as EquipmentSlot | undefined,
      context.signal
    )
  }
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase()
}

function cancelled(signal: AbortSignal): SkillResult {
  const reason = typeof signal.reason === 'string' ? signal.reason.trim() : ''
  return {
    status: 'cancelled',
    code: reason ? reason.replace(/\s+/g, '_').slice(0, 128) : 'cancelled'
  }
}
