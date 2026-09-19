import type { SkillName } from './skill-catalog.js'

export { SkillNameSchema } from './skill-catalog.js'
export type { SkillName } from './skill-catalog.js'

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
