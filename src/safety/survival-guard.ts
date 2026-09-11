import type { GoalManager } from '../goals/goal-manager.js'
import type { SkillExecutor } from '../skills/executor.js'
import type { WorldStateSnapshot } from '../state/world-state.js'
import type { SafetyPolicy } from './policy.js'

export type SurvivalGuardResult =
  | { kind: 'noop'; code: 'no_active_goal' | 'allowed' | 'unsupported_preemption' }
  | { kind: 'handled'; code: 'low_food'; result: string }

export class SurvivalGuard {
  constructor(
    private readonly policy: SafetyPolicy,
    private readonly goals: GoalManager,
    private readonly executor: SkillExecutor
  ) {}

  async enforce(state: WorldStateSnapshot): Promise<SurvivalGuardResult> {
    const active = this.goals.activeGoal()
    if (!active) {
      return { kind: 'noop', code: 'no_active_goal' }
    }

    const decision = this.policy.runtimeAction(state, active.request)
    if (decision.kind !== 'preempt') {
      return { kind: 'noop', code: 'allowed' }
    }
    if (decision.code !== 'low_food') {
      return { kind: 'noop', code: 'unsupported_preemption' }
    }

    const preempted = await this.goals.preemptActive('low_food')
    if (!preempted) {
      return { kind: 'noop', code: 'no_active_goal' }
    }

    const eatGoal = await this.goals.submit({ kind: 'eat', args: {} }, 'system')
    const result = await this.executor.execute('eat', eatGoal.request.args)
    await this.goals.completeGoal(eatGoal.goalId, result)

    return {
      kind: 'handled',
      code: 'low_food',
      result: result.code
    }
  }
}
