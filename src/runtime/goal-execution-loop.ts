import type { GoalRecord } from '../contracts/goals.js'
import type { RuntimeEvent } from '../contracts/events.js'
import type { SkillName, SkillResult } from '../contracts/skills.js'

export interface GoalExecutionManagerPort {
  getGoal(goalId: string): GoalRecord | undefined
  completeGoal(goalId: string, result: SkillResult): Promise<void>
}

export interface GoalExecutionExecutorPort {
  execute(name: SkillName, args: unknown): Promise<SkillResult>
}

export interface GoalExecutionEventSource {
  subscribe(listener: (event: RuntimeEvent) => void | Promise<void>): () => void
}

export interface GoalExecutionBinding {
  dispose(): void
}

export interface GoalExecutionDependencies {
  readonly events: GoalExecutionEventSource
  readonly goals: GoalExecutionManagerPort
  readonly executor: GoalExecutionExecutorPort
}

export function wireGoalExecution(
  dependencies: GoalExecutionDependencies
): GoalExecutionBinding {
  const inFlight = new Set<string>()
  let disposed = false

  const unsubscribe = dependencies.events.subscribe(event => {
    if (disposed || event.type !== 'goal_started') return
    if (inFlight.has(event.goalId)) return

    inFlight.add(event.goalId)
    queueMicrotask(() => {
      void executeGoal(event.goalId).catch(() => {
        // The bridge contains all asynchronous failures. Error text is never
        // forwarded to telemetry, chat, goals, or other runtime surfaces.
      })
    })
  })

  async function executeGoal(goalId: string): Promise<void> {
    try {
      const record = dependencies.goals.getGoal(goalId)
      if (!record || record.status !== 'running') return

      let result: SkillResult
      try {
        result = await dependencies.executor.execute(
          record.request.kind,
          structuredClone(record.request.args)
        )
      } catch {
        result = {
          status: 'failed',
          code: 'skill_execution_failed'
        }
      }

      await dependencies.goals.completeGoal(goalId, result)
    } finally {
      inFlight.delete(goalId)
    }
  }

  return {
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
    }
  }
}
