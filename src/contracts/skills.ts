import { z } from 'zod'

export const SkillNameSchema = z.enum([
  'follow_player',
  'stay',
  'stop',
  'go_to',
  'return_home',
  'eat',
  'equip',
  'find_resource',
  'gather_resource',
  'explore_resource',
  'deposit_item',
  'withdraw_item'
])

export type SkillName = z.infer<typeof SkillNameSchema>
export type SkillStatus = 'succeeded' | 'failed' | 'cancelled'

export interface SkillResult {
  status: SkillStatus
  code: string
  summary?: string
}

export interface SkillContext {
  signal: AbortSignal
  executionId?: string
}

export interface SkillDefinition<A> {
  readonly name: SkillName
  execute(context: SkillContext, args: A): Promise<SkillResult>
}
