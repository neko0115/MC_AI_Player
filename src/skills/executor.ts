import type { SkillName, SkillResult } from '../contracts/skills.js'
import type { RuntimeEventBus } from '../telemetry/event-bus.js'
import type { SkillRegistry } from './registry.js'

interface SkillExecutorDependencies {
  events?: RuntimeEventBus
  now?: () => number
  cancelWaitTimeoutMs?: number
}

interface ActiveExecution {
  readonly name: SkillName
  readonly controller: AbortController
  cancelReason: string | null
  cancelWatchdogReported: boolean
  completion: Promise<SkillResult>
}

const DEFAULT_CANCEL_WAIT_TIMEOUT_MS = 2_000

export class SkillExecutor {
  private readonly events: RuntimeEventBus | undefined
  private readonly now: () => number
  private readonly cancelWaitTimeoutMs: number
  private active: ActiveExecution | null = null

  constructor(
    private readonly registry: SkillRegistry,
    dependencies: SkillExecutorDependencies = {}
  ) {
    this.events = dependencies.events
    this.now = dependencies.now ?? Date.now
    this.cancelWaitTimeoutMs =
      dependencies.cancelWaitTimeoutMs ??
      DEFAULT_CANCEL_WAIT_TIMEOUT_MS

    if (
      !Number.isFinite(
        this.cancelWaitTimeoutMs
      ) ||
      this.cancelWaitTimeoutMs < 1
    ) {
      throw new RangeError(
        'cancelWaitTimeoutMs must be a positive finite number'
      )
    }
  }

  execute(
    name: SkillName,
    args: unknown,
    executionId?: string
  ): Promise<SkillResult> {
    if (this.active !== null) {
      return Promise.resolve({ status: 'failed', code: 'executor_busy' })
    }

    const definition = this.registry.get(name)
    if (!definition) {
      return Promise.resolve({ status: 'failed', code: 'skill_not_registered' })
    }

    const active: ActiveExecution = {
      name,
      controller: new AbortController(),
      cancelReason: null,
      cancelWatchdogReported: false,
      completion: Promise.resolve({ status: 'failed', code: 'not_started' })
    }
    this.active = active
    active.completion = this.run(
      active,
      definition.execute.bind(definition),
      args,
      executionId
    )
    return active.completion
  }

  async cancelActive(reason: string): Promise<void> {
    const active = this.active
    if (!active) return

    if (!active.controller.signal.aborted) {
      active.cancelReason = sanitizeCode(reason, 'cancelled')
      active.controller.abort(active.cancelReason)
    }

    const completed =
      await settlesWithin(
        active.completion,
        this.cancelWaitTimeoutMs
      )

    if (
      !completed &&
      this.active === active &&
      !active.cancelWatchdogReported
    ) {
      active.cancelWatchdogReported = true
      void this.events?.publish({
        type: 'runtime_watchdog',
        at: this.now(),
        scope: 'skill_cancel',
        code: 'cancel_cleanup_timeout'
      }).catch(() => {
        // Watchdog telemetry is best-effort and
        // must not extend cancellation latency.
      })
    }
  }

  private async run(
    active: ActiveExecution,
    execute: (
      context: { signal: AbortSignal },
      args: unknown
    ) => Promise<SkillResult>,
    args: unknown,
    executionId?: string
  ): Promise<SkillResult> {
    const startedEvent = this.events?.publish({
      type: 'skill_started',
      at: this.now(),
      skill: active.name
    })

    let execution: Promise<SkillResult>
    try {
      execution = execute(
        {
          signal: active.controller.signal,
          ...(executionId ? { executionId } : {})
        },
        args
      )
    } catch (error) {
      execution = Promise.reject(error)
    }

    if (startedEvent) {
      await startedEvent
    }

    let result: SkillResult
    try {
      result = await execution
    } catch {
      result = {
        status: 'failed',
        code: 'skill_exception'
      }
    }

    if (active.controller.signal.aborted) {
      result = {
        status: 'cancelled',
        code: active.cancelReason ?? 'cancelled'
      }
    }

    if (result.status === 'succeeded') {
      await this.events?.publish({
        type: 'skill_completed',
        at: this.now(),
        skill: active.name
      })
    } else if (result.status === 'cancelled') {
      await this.events?.publish({
        type: 'skill_cancelled',
        at: this.now(),
        skill: active.name,
        code: sanitizeCode(result.code, 'cancelled')
      })
    } else {
      await this.events?.publish({
        type: 'skill_failed',
        at: this.now(),
        skill: active.name,
        code: sanitizeCode(result.code, 'failed')
      })
    }

    if (this.active === active) {
      this.active = null
    }
    return result
  }
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

function sanitizeCode(value: string, fallback: string): string {
  const normalized = value.trim().replace(/\s+/g, '_').slice(0, 128)
  return normalized || fallback
}
