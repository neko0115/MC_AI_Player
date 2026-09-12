import type { ContextBuilder } from '../agent/context-builder.js'
import { registeredDecisionSkills } from '../agent/skill-catalog.js'
import { assessComplexity, createRoutePlan } from '../agent/routing/complexity.js'
import type {
  LogicalDecisionExecutor,
  LogicalDecisionResult
} from '../agent/routing/contracts.js'
import type { DecisionGate } from '../agent/decision-gate.js'
import type { MinecraftServerIdentityMode } from '../config.js'
import type { RuntimeEvent } from '../contracts/events.js'
import type { GoalManager } from '../goals/goal-manager.js'
import type { MinecraftMemoryRepository } from '../memory/repository.js'
import type {
  MinecraftIdentityRegistry,
  MinecraftManualAccessPolicy
} from '../minecraft/identity-registry.js'
import type { SkillRegistry } from '../skills/registry.js'
import type { WorldStateCache } from '../state/world-state-cache.js'
import type { RuntimeEventBus } from '../telemetry/event-bus.js'
import {
  AiTaskQueue,
  createAiTask,
  type AiTask
} from './ai-task.js'
import { TriggerClassifier } from './trigger-classifier.js'

export interface DecisionCoordinatorStatus {
  readonly coordinatorState: 'running' | 'stopped'
  readonly activeTaskId: string | null
  readonly activeGoalId: string | null
  readonly pendingTaskCount: number
  readonly decisionInFlight: boolean
  readonly execution: 'idle' | 'decision_pending' | 'decision_in_flight' | 'goal_running'
  readonly aiAvailability: 'available' | 'unavailable'
}

export interface DecisionCoordinatorOptions {
  readonly events: RuntimeEventBus
  readonly state: WorldStateCache
  readonly goals: GoalManager
  readonly memory: MinecraftMemoryRepository
  readonly registry: SkillRegistry
  readonly identity: MinecraftIdentityRegistry
  readonly identityMode: MinecraftServerIdentityMode
  readonly manualAccess: MinecraftManualAccessPolicy
  readonly worldKey: string
  readonly botUsername: string
  readonly logicalExecutor: LogicalDecisionExecutor
  readonly decisionGate: DecisionGate
  readonly contextBuilder: ContextBuilder
  readonly safetyConstraints: readonly string[]
  readonly nextTaskId: () => string
  readonly nextDecisionId: () => string
  readonly now?: () => number
}

export class DecisionCoordinator {
  private readonly classifier: TriggerClassifier
  private readonly pendingTasks = new AiTaskQueue(8)
  private readonly now: () => number
  private unsubscribe: (() => void) | null = null
  private mailboxTail: Promise<void> = Promise.resolve()
  private activeTask: AiTask | null = null
  private decisionAbort: AbortController | null = null
  private running = false
  private execution: DecisionCoordinatorStatus['execution'] = 'idle'
  private aiAvailability: DecisionCoordinatorStatus['aiAvailability'] = 'available'
  private taskGeneration = 0

  constructor(private readonly options: DecisionCoordinatorOptions) {
    this.classifier = new TriggerClassifier({ botUsername: options.botUsername })
    this.now = options.now ?? Date.now
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.unsubscribe = this.options.events.subscribe(event => {
      this.enqueueEvent(structuredClone(event))
    })
  }

  dispose(): void {
    if (!this.running) return
    this.running = false
    this.unsubscribe?.()
    this.unsubscribe = null
    this.decisionAbort?.abort('coordinator_disposed')
    this.decisionAbort = null
    this.pendingTasks.clear()
    this.activeTask = null
    this.execution = 'idle'
  }

  status(): DecisionCoordinatorStatus {
    return {
      coordinatorState: this.running ? 'running' : 'stopped',
      activeTaskId: this.activeTask?.taskId ?? null,
      activeGoalId: this.activeTask?.activeGoalId ?? null,
      pendingTaskCount: this.pendingTasks.size(),
      decisionInFlight: this.execution === 'decision_in_flight',
      execution: this.execution,
      aiAvailability: this.aiAvailability
    }
  }

  private enqueueEvent(event: RuntimeEvent): void {
    this.mailboxTail = this.mailboxTail
      .then(() => this.handleEvent(event))
      .catch(() => {
        // One malformed/failed transition must not poison later mailbox work.
      })
  }

  private enqueueDecisionResult(
    taskId: string,
    taskGeneration: number,
    result: LogicalDecisionResult
  ): void {
    this.mailboxTail = this.mailboxTail
      .then(() => this.handleDecisionResult(taskId, taskGeneration, result))
      .catch(() => {
        // Provider completion is contained by the coordinator boundary.
      })
  }

  private async handleEvent(event: RuntimeEvent): Promise<void> {
    if (!this.running) return

    if (event.type === 'emergency_stop') {
      this.decisionAbort?.abort('emergency_stop')
      this.decisionAbort = null
      if (this.activeTask) this.activeTask.state = 'superseded'
      this.activeTask = null
      this.execution = 'idle'
      return
    }

    const classification = this.classifier.classify(event, {
      taskId: this.activeTask?.taskId ?? '',
      activeGoalId: this.activeTask?.activeGoalId ?? null
    })

    if (classification.kind !== 'explicit_instruction') return

    const principal = this.options.identity.resolveChat({
      mode: this.options.identityMode,
      player: classification.player,
      ...(classification.playerId === undefined
        ? {}
        : { playerId: classification.playerId }),
      policy: this.options.manualAccess
    })

    const task = createAiTask({
      taskId: this.options.nextTaskId(),
      objective: classification.instruction,
      source: 'minecraft',
      principalKind: principal.kind,
      taskGeneration: ++this.taskGeneration,
      minecraftSessionGeneration: this.options.identity.currentSessionGeneration(),
      baseComplexityEvidence: classification.baseComplexityEvidence
    })

    if (this.activeTask !== null) {
      this.pendingTasks.enqueue(task)
      return
    }

    this.activeTask = task
    this.dispatchActiveTask()
  }

  private dispatchActiveTask(): void {
    const task = this.activeTask
    if (
      !this.running ||
      task === null ||
      this.execution === 'decision_in_flight'
    ) {
      return
    }

    const state = this.options.state.snapshot()
    const context = this.options.contextBuilder.build({
      worldKey: this.options.worldKey,
      task: {
        taskId: task.taskId,
        objective: task.objective,
        phase: 'active',
        consecutiveReplans: task.consecutiveReplanCount,
        previousAction: null
      },
      state,
      currentGoal: this.options.goals.activeGoal(),
      memories: this.options.memory.search({
        worldKey: this.options.worldKey,
        limit: 8
      }),
      skills: registeredDecisionSkills(this.options.registry),
      safetyConstraints: this.options.safetyConstraints
    })

    const assessment = assessComplexity({
      ...task.baseComplexityEvidence,
      replanCount: task.consecutiveReplanCount
    })
    const routePlan = createRoutePlan(
      this.options.nextDecisionId(),
      assessment,
      false
    )

    const abort = new AbortController()
    this.decisionAbort = abort
    this.execution = 'decision_in_flight'

    void this.options.logicalExecutor
      .execute({ context, routePlan }, abort.signal)
      .then(result => {
        this.enqueueDecisionResult(task.taskId, task.taskGeneration, result)
      })
      .catch(() => {
        this.enqueueDecisionResult(task.taskId, task.taskGeneration, {
          kind: 'invalid_response',
          code: 'logical_executor_failed'
        })
      })
  }

  private async handleDecisionResult(
    taskId: string,
    taskGeneration: number,
    result: LogicalDecisionResult
  ): Promise<void> {
    if (!this.running) return
    const task = this.activeTask
    if (
      task === null ||
      task.taskId !== taskId ||
      task.taskGeneration !== taskGeneration
    ) {
      return
    }

    this.decisionAbort = null
    this.execution = 'idle'

    if (result.kind === 'unavailable') {
      this.aiAvailability = 'unavailable'
      return
    }

    if (result.kind !== 'success') return

    this.aiAvailability = 'available'
    const gated = await this.options.decisionGate.accept(
      result.providerResult,
      this.options.state.snapshot(),
      name => this.options.registry.has(name)
    )

    if (
      this.activeTask === null ||
      this.activeTask.taskId !== taskId ||
      this.activeTask.taskGeneration !== taskGeneration
    ) {
      return
    }

    if (gated.kind === 'action') {
      const goal = await this.options.goals.submit(gated.goal, 'ai')
      if (
        this.activeTask === null ||
        this.activeTask.taskId !== taskId ||
        this.activeTask.taskGeneration !== taskGeneration
      ) {
        return
      }
      this.activeTask.activeGoalId = goal.goalId
      this.execution = 'goal_running'
      return
    }

    if (gated.kind === 'complete') {
      task.state = 'completed'
      this.activeTask = null
      this.execution = 'idle'
    }
  }
}
