import { randomUUID } from 'node:crypto'
import type {
  GoalRecord,
  GoalRequest,
  GoalSource,
  GoalStatus
} from '../contracts/goals.js'
import type { SkillResult } from '../contracts/skills.js'
import type { RuntimeEventBus } from '../telemetry/event-bus.js'

export interface GoalSkillController {
  cancelActive(reason: string): Promise<void>
}

interface GoalManagerDependencies {
  skillController: GoalSkillController
  events?: RuntimeEventBus
  nextGoalId?: () => string
  now?: () => number
}

export class GoalManager {
  private readonly records = new Map<string, GoalRecord>()
  private readonly queue: string[] = []
  private readonly events: RuntimeEventBus | undefined
  private readonly nextGoalId: () => string
  private readonly now: () => number
  private activeGoalId: string | null = null

  constructor(private readonly dependencies: GoalManagerDependencies) {
    this.events = dependencies.events
    this.nextGoalId = dependencies.nextGoalId ?? randomUUID
    this.now = dependencies.now ?? Date.now
  }

  async submit(request: GoalRequest, source: GoalSource): Promise<GoalRecord> {
    const timestamp = this.now()
    const record: GoalRecord = {
      goalId: this.nextGoalId(),
      request,
      status: 'queued',
      source,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    this.records.set(record.goalId, record)

    const active = this.activeRecord()
    if (!active) {
      await this.start(record)
      return cloneRecord(record)
    }

    if (source === 'player' && active.source === 'ai') {
      await this.cancelActiveGoal('preempted_by_player')
      await this.start(record)
      return cloneRecord(record)
    }

    this.queue.push(record.goalId)
    return cloneRecord(record)
  }

  activeGoal(): GoalRecord | null {
    const record = this.activeRecord()
    return record ? cloneRecord(record) : null
  }

  queuedGoals(): ReadonlyArray<GoalRecord> {
    return this.queue
      .map(goalId => this.records.get(goalId))
      .filter((record): record is GoalRecord => Boolean(record))
      .map(cloneRecord)
  }

  getGoal(goalId: string): GoalRecord | undefined {
    const record = this.records.get(goalId)
    return record ? cloneRecord(record) : undefined
  }

  async preemptActive(reason: string): Promise<boolean> {
    const active = this.activeRecord()
    if (!active || active.status !== 'running') return false
    await this.cancelActiveGoal(reason)
    return true
  }

  async completeGoal(goalId: string, result: SkillResult): Promise<void> {
    const record = this.records.get(goalId)
    if (!record || record.status !== 'running' || this.activeGoalId !== goalId) {
      return
    }

    if (result.status === 'succeeded') {
      this.transition(record, 'succeeded')
      await this.events?.publish({
        type: 'goal_completed',
        at: this.now(),
        goalId: record.goalId
      })
    } else if (result.status === 'cancelled') {
      this.transition(record, 'cancelled')
      await this.events?.publish({
        type: 'goal_cancelled',
        at: this.now(),
        goalId: record.goalId,
        code: sanitizeCode(result.code, 'cancelled')
      })
    } else {
      this.transition(record, 'failed')
      await this.events?.publish({
        type: 'goal_failed',
        at: this.now(),
        goalId: record.goalId,
        code: sanitizeCode(result.code, 'failed')
      })
    }

    this.activeGoalId = null
    await this.startNextQueued()
  }

  async emergencyStop(reason: string): Promise<void> {
    const safeReason = sanitizeCode(reason, 'emergency_stop')
    await this.events?.publish({
      type: 'emergency_stop',
      at: this.now(),
      reason: reason.trim().slice(0, 500) || 'emergency stop'
    })

    await this.dependencies.skillController.cancelActive(safeReason)

    const active = this.activeRecord()
    if (active?.status === 'running') {
      this.transition(active, 'cancelled')
      await this.events?.publish({
        type: 'goal_cancelled',
        at: this.now(),
        goalId: active.goalId,
        code: safeReason
      })
    }
    this.activeGoalId = null

    while (this.queue.length > 0) {
      const queuedId = this.queue.shift()
      if (!queuedId) continue
      const queued = this.records.get(queuedId)
      if (queued?.status === 'queued') {
        this.transition(queued, 'cancelled')
      }
    }
  }

  private async cancelActiveGoal(reason: string): Promise<void> {
    const active = this.activeRecord()
    if (!active || active.status !== 'running') return

    const safeReason = sanitizeCode(reason, 'cancelled')
    await this.dependencies.skillController.cancelActive(safeReason)

    if (this.activeGoalId !== active.goalId || active.status !== 'running') {
      return
    }

    this.transition(active, 'cancelled')
    this.activeGoalId = null
    await this.events?.publish({
      type: 'goal_cancelled',
      at: this.now(),
      goalId: active.goalId,
      code: safeReason
    })
  }

  private async start(record: GoalRecord): Promise<void> {
    this.transition(record, 'running')
    this.activeGoalId = record.goalId
    await this.events?.publish({
      type: 'goal_started',
      at: this.now(),
      goalId: record.goalId
    })
  }

  private async startNextQueued(): Promise<void> {
    while (this.queue.length > 0 && this.activeGoalId === null) {
      const nextId = this.queue.shift()
      if (!nextId) continue
      const next = this.records.get(nextId)
      if (!next || next.status !== 'queued') continue
      await this.start(next)
    }
  }

  private activeRecord(): GoalRecord | null {
    if (!this.activeGoalId) return null
    return this.records.get(this.activeGoalId) ?? null
  }

  private transition(record: GoalRecord, status: GoalStatus): void {
    record.status = status
    record.updatedAt = this.now()
  }
}

function cloneRecord(record: GoalRecord): GoalRecord {
  return {
    ...record,
    request: record.request
  }
}

function sanitizeCode(value: string, fallback: string): string {
  const normalized = value.trim().replace(/\s+/g, '_').slice(0, 128)
  return normalized || fallback
}
