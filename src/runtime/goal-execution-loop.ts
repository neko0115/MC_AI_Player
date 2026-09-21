import type { GoalRecord } from '../contracts/goals.js'
import type { RuntimeEvent } from '../contracts/events.js'
import type { SkillName, SkillResult } from '../contracts/skills.js'

export interface GoalExecutionManagerPort {
  getGoal(goalId: string): GoalRecord | undefined
  completeGoal(goalId: string, result: SkillResult): Promise<void>
}

export interface GoalExecutionExecutorPort {
  execute(
    name: SkillName,
    args: unknown,
    executionId?: string
  ): Promise<SkillResult>
  cancelActive(reason: string): Promise<void>
}

export interface GoalExecutionEventSource {
  subscribe(listener: (event: RuntimeEvent) => void | Promise<void>): () => void
  publish(event: RuntimeEvent): Promise<void>
}

export interface GoalExecutionBinding {
  dispose(): void
}

export interface GoalExecutionDependencies {
  readonly events: GoalExecutionEventSource
  readonly goals: GoalExecutionManagerPort
  readonly executor: GoalExecutionExecutorPort
  readonly stallTimeoutMs?: number
  readonly cancelGraceMs?: number
  readonly now?: () => number
}

const DEFAULT_STALL_TIMEOUT_MS =
  120_000
const DEFAULT_CANCEL_GRACE_MS =
  2_500

export function wireGoalExecution(
  dependencies: GoalExecutionDependencies
): GoalExecutionBinding {
  const inFlight = new Set<string>()
  const pendingResume = new Set<string>()
  const stalledGoals = new Set<string>()
  const watchdogs =
    new Map<
      string,
      ReturnType<typeof setTimeout>
    >()
  const stallTimeoutMs =
    dependencies.stallTimeoutMs ??
    DEFAULT_STALL_TIMEOUT_MS
  const cancelGraceMs =
    dependencies.cancelGraceMs ??
    DEFAULT_CANCEL_GRACE_MS
  const now = dependencies.now ?? Date.now
  let disposed = false

  if (
    !Number.isFinite(stallTimeoutMs) ||
    stallTimeoutMs < 1
  ) {
    throw new RangeError(
      'stallTimeoutMs must be a positive finite number'
    )
  }
  if (
    !Number.isFinite(cancelGraceMs) ||
    cancelGraceMs < 1
  ) {
    throw new RangeError(
      'cancelGraceMs must be a positive finite number'
    )
  }

  const unsubscribe = dependencies.events.subscribe(event => {
    if (disposed) return

    if (
      event.type === 'goal_started' ||
      event.type === 'goal_resumed'
    ) {
      if (inFlight.has(event.goalId)) {
        if (event.type === 'goal_resumed') {
          pendingResume.add(event.goalId)
        }
        armWatchdog(event.goalId)
        return
      }

      scheduleGoal(event.goalId)
      return
    }

    if (
      event.type === 'goal_suspended' ||
      event.type === 'goal_completed' ||
      event.type === 'goal_failed' ||
      event.type === 'goal_cancelled'
    ) {
      clearWatchdog(event.goalId)
      return
    }

    if (
      isProgressEvidence(event)
    ) {
      for (const goalId of inFlight) {
        armWatchdog(goalId)
      }
    }
  })

  function scheduleGoal(goalId: string): void {
    if (disposed || inFlight.has(goalId)) return
    inFlight.add(goalId)
    armWatchdog(goalId)
    queueMicrotask(() => {
      void executeGoal(goalId).catch(() => {
        // The bridge contains all asynchronous failures. Error text is never
        // forwarded to telemetry, chat, goals, or other runtime surfaces.
      })
    })
  }

  function armWatchdog(
    goalId: string
  ): void {
    clearWatchdog(goalId)

    if (disposed) return
    const record =
      dependencies.goals.getGoal(goalId)
    if (
      !record ||
      record.status !== 'running' ||
      !usesProgressWatchdog(record)
    ) {
      return
    }

    watchdogs.set(
      goalId,
      setTimeout(() => {
        watchdogs.delete(goalId)
        void handleWatchdog(goalId)
      }, stallTimeoutMs)
    )
  }

  async function handleWatchdog(
    goalId: string
  ): Promise<void> {
    if (
      disposed ||
      stalledGoals.has(goalId)
    ) {
      return
    }

    const record =
      dependencies.goals.getGoal(goalId)
    if (
      !record ||
      record.status !== 'running' ||
      !usesProgressWatchdog(record)
    ) {
      return
    }

    stalledGoals.add(goalId)
    await dependencies.events.publish({
      type: 'runtime_watchdog',
      at: now(),
      scope: 'goal_execution',
      code: 'no_progress_timeout'
    })

    const cancelling =
      dependencies.executor
        .cancelActive(
          'runtime_watchdog_timeout'
        )
        .catch(() => {
          // Cancellation failure is contained.
        })

    await settlesWithin(
      cancelling,
      cancelGraceMs
    )

    const latest =
      dependencies.goals.getGoal(goalId)
    if (
      latest?.status === 'running'
    ) {
      await dependencies.goals.completeGoal(
        goalId,
        {
          status: 'failed',
          code: 'runtime_watchdog_timeout'
        }
      )
    }
  }

  async function executeGoal(goalId: string): Promise<void> {
    try {
      const record = dependencies.goals.getGoal(goalId)
      if (!record || record.status !== 'running') return

      let result: SkillResult
      try {
        result = await dependencies.executor.execute(
          record.request.kind,
          structuredClone(record.request.args),
          goalId
        )
      } catch {
        result = {
          status: 'failed',
          code: 'skill_execution_failed'
        }
      }

      if (
        stalledGoals.has(goalId)
      ) {
        result = {
          status: 'failed',
          code: 'runtime_watchdog_timeout'
        }
      }

      await dependencies.goals.completeGoal(goalId, result)
    } finally {
      clearWatchdog(goalId)
      stalledGoals.delete(goalId)
      inFlight.delete(goalId)
      if (pendingResume.delete(goalId)) {
        const record = dependencies.goals.getGoal(goalId)
        if (record?.status === 'running') {
          scheduleGoal(goalId)
        }
      }
    }
  }

  function clearWatchdog(
    goalId: string
  ): void {
    const timer = watchdogs.get(goalId)
    if (timer !== undefined) {
      clearTimeout(timer)
      watchdogs.delete(goalId)
    }
  }

  return {
    dispose() {
      if (disposed) return
      disposed = true
      pendingResume.clear()
      for (
        const timer of
        watchdogs.values()
      ) {
        clearTimeout(timer)
      }
      watchdogs.clear()
      unsubscribe()
    }
  }
}

function usesProgressWatchdog(
  record: GoalRecord
): boolean {
  return (
    record.request.kind !== 'stay' &&
    record.request.kind !==
      'follow_player'
  )
}

function isProgressEvidence(
  event: RuntimeEvent
): boolean {
  return (
    event.type === 'position_changed' ||
    event.type === 'inventory_changed' ||
    event.type ===
      'resource_search_phase' ||
    event.type ===
      'cooperative_pickup' ||
    event.type ===
      'server_capability_used'
  )
}

function settlesWithin(
  completion: Promise<unknown>,
  timeoutMs: number
): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false

    const finish = (
      completed: boolean
    ) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(completed)
    }

    const timer = setTimeout(
      () => finish(false),
      timeoutMs
    )

    void completion.then(
      () => finish(true),
      () => finish(true)
    )
  })
}
