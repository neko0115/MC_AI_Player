import type { ContextBuilder } from '../agent/context-builder.js'
import { registeredDecisionSkills } from '../agent/skill-catalog.js'
import {
  analyzeInstructionComplexity,
  assessComplexity,
  createRoutePlan
} from '../agent/routing/complexity.js'
import type {
  ComplexityEvidence,
  LogicalDecisionExecutor,
  LogicalDecisionResult
} from '../agent/routing/contracts.js'
import type { DecisionGate } from '../agent/decision-gate.js'
import type { MinecraftServerIdentityMode } from '../config.js'
import type { RuntimeEvent } from '../contracts/events.js'
import type { GoalRequest } from '../contracts/goals.js'
import type { GoalManager } from '../goals/goal-manager.js'
import type { MinecraftMemoryRepository } from '../memory/repository.js'
import type {
  MinecraftIdentityRegistry,
  MinecraftManualAccessPolicy,
  MinecraftPrincipal
} from '../minecraft/identity-registry.js'
import type { ServerCapabilityStatusSource } from '../minecraft/moxuebridge-capabilities.js'
import type { ServerResourceCatalogSource } from '../minecraft/moxuebridge-resources.js'
import { parseManualAiCommand } from '../minecraft/manual-ai-command.js'
import type { SkillRegistry } from '../skills/registry.js'
import type { WorldStateCache } from '../state/world-state-cache.js'
import type { RuntimeEventBus } from '../telemetry/event-bus.js'
import {
  AiTaskQueue,
  createAiTask,
  createManualRouteGrant,
  noteActionSuccess,
  noteGoalFailure,
  type AiTask,
  type ManualRouteGrant
} from './ai-task.js'
import { TriggerClassifier } from './trigger-classifier.js'
import type {
  WorkspaceChatInstructionRouter,
  WorkspaceChatRouteResult
} from '../workspace/chat-router.js'
import {
  formatWorkspaceChatReply
} from '../workspace/chat-reply.js'
import type {
  MinecraftChatOutput
} from '../minecraft/chat-output.js'

export interface DecisionCoordinatorStatus {
  readonly coordinatorState: 'running' | 'stopped'
  readonly activeTaskId: string | null
  readonly activeGoalId: string | null
  readonly pendingTaskCount: number
  readonly decisionInFlight: boolean
  readonly execution: 'idle' | 'decision_pending' | 'decision_in_flight' | 'goal_running'
  readonly aiAvailability: 'available' | 'unavailable'
}

export interface AdminDeepThinkRequest {
  readonly instruction: string
  readonly targetGoalId?: string
}

export type CoordinatorCommandResult =
  | { readonly kind: 'accepted'; readonly taskId: string }
  | { readonly kind: 'rejected'; readonly code: string }

export interface DecisionCoordinatorOptions {
  readonly events: RuntimeEventBus
  readonly state: WorldStateCache
  readonly goals: GoalManager
  readonly memory: MinecraftMemoryRepository
  readonly registry: SkillRegistry
  readonly serverCapabilities?: ServerCapabilityStatusSource
  readonly serverResources?: ServerResourceCatalogSource
  readonly identity: MinecraftIdentityRegistry
  readonly identityMode: MinecraftServerIdentityMode
  readonly manualAccess: MinecraftManualAccessPolicy
  readonly worldKey: string
  readonly botUsername: string
  readonly logicalExecutor: LogicalDecisionExecutor
  readonly workspaceChatRouter?: WorkspaceChatInstructionRouter
  readonly chatOutput?: MinecraftChatOutput
  readonly decisionGate: DecisionGate
  readonly contextBuilder: ContextBuilder
  readonly safetyConstraints: readonly string[]
  readonly nextTaskId: () => string
  readonly nextDecisionId: () => string
  readonly now?: () => number
  readonly decisionTimeoutMs?: number
  readonly workspaceRouteTimeoutMs?: number
}

const DEFAULT_DECISION_TIMEOUT_MS = 45_000
const DEFAULT_WORKSPACE_ROUTE_TIMEOUT_MS = 35_000
const MAX_TASK_REPLANS = 6
const GAMEPLAY_ACK_MESSAGE =
  '收到，我開始處理。'
const GAMEPLAY_COMPLETE_MESSAGE =
  '完成了。'
const GAMEPLAY_FAILED_MESSAGE =
  '這個任務目前無法完成。'
const GAMEPLAY_TIMEOUT_MESSAGE =
  '這個任務等太久沒有進展，我先停止了。'

export class DecisionCoordinator {
  private readonly classifier: TriggerClassifier
  private readonly pendingTasks = new AiTaskQueue(8)
  private readonly now: () => number
  private readonly decisionTimeoutMs: number
  private readonly workspaceRouteTimeoutMs: number
  private readonly manualGrants = new Map<string, ManualRouteGrant>()
  private readonly grantRequiredTasks = new Set<string>()
  private unsubscribe: (() => void) | null = null
  private mailboxTail: Promise<void> = Promise.resolve()
  private telemetryTail: Promise<void> = Promise.resolve()
  private activeTask: AiTask | null = null
  private decisionAbort: AbortController | null = null
  private decisionWatchdogTimer:
    ReturnType<typeof setTimeout> | null = null
  private activeDecisionEpoch: number | null = null
  private decisionEpoch = 0
  private running = false
  private execution: DecisionCoordinatorStatus['execution'] = 'idle'
  private aiAvailability: DecisionCoordinatorStatus['aiAvailability'] = 'available'
  private minecraftReady = false
  private taskGeneration = 0
  private grantSequence = 0
  private previousAction: GoalRequest['kind'] | null = null
  private readonly failureEvidence = new Set<'stuck' | 'skill_failed'>()
  private pendingDecisionEvidence: ComplexityEvidence = {}
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null
  private recoveryRetryAt: number | null = null
  private pendingResumeTimer: ReturnType<typeof setTimeout> | null = null
  private workspaceChatTail: Promise<void> = Promise.resolve()
  private workspaceChatSequence = 0
  private readonly workspaceChatAborts =
    new Map<number, AbortController>()

  constructor(private readonly options: DecisionCoordinatorOptions) {
    this.classifier = new TriggerClassifier({ botUsername: options.botUsername })
    this.now = options.now ?? Date.now
    this.decisionTimeoutMs =
      options.decisionTimeoutMs ??
      DEFAULT_DECISION_TIMEOUT_MS
    this.workspaceRouteTimeoutMs =
      options.workspaceRouteTimeoutMs ??
      DEFAULT_WORKSPACE_ROUTE_TIMEOUT_MS

    if (
      !Number.isFinite(
        this.decisionTimeoutMs
      ) ||
      this.decisionTimeoutMs < 1
    ) {
      throw new RangeError(
        'decisionTimeoutMs must be a positive finite number'
      )
    }
    if (
      !Number.isFinite(
        this.workspaceRouteTimeoutMs
      ) ||
      this.workspaceRouteTimeoutMs < 1
    ) {
      throw new RangeError(
        'workspaceRouteTimeoutMs must be a positive finite number'
      )
    }

    const initial = options.state.snapshot()
    this.minecraftReady = initial.connected && initial.spawned
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
    this.invalidateInFlightDecision('coordinator_disposed')
    this.abortWorkspaceChatRouting('coordinator_disposed')
    this.clearRecoveryTimer(true)
    this.clearPendingResumeTimer()
    this.invalidateManualGrants()
    this.pendingTasks.clear()
    this.clearActiveTaskState()
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

  submitAdminDeepThink(request: AdminDeepThinkRequest): Promise<CoordinatorCommandResult> {
    return this.enqueueCommand(() => this.handleAdminDeepThink(request))
  }

  invalidateManualGrants(): void {
    for (const grant of this.manualGrants.values()) grant.invalidate()
  }

  clearAiWork(reason = 'ai_work_cleared'): Promise<void> {
    return this.enqueueCommand(async () => {
      await this.handleClearAiWork(reason)
    })
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
    decisionEpoch: number,
    result: LogicalDecisionResult
  ): void {
    this.mailboxTail = this.mailboxTail
      .then(() => this.handleDecisionResult(
        taskId,
        taskGeneration,
        decisionEpoch,
        result
      ))
      .catch(() => {
        // Provider completion is contained by the coordinator boundary.
      })
  }

  private enqueueRecovery(taskId: string, taskGeneration: number): void {
    this.mailboxTail = this.mailboxTail
      .then(() => this.handleRecovery(taskId, taskGeneration))
      .catch(() => {
        // A failed recovery transition must not poison later mailbox work.
      })
  }

  private enqueueCommand<T>(command: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.mailboxTail = this.mailboxTail
        .then(async () => {
          try {
            resolve(await command())
          } catch (error) {
            reject(error)
          }
        })
        .catch(() => {
          // The command promise above owns its own rejection.
        })
    })
  }

  private publishTelemetry(event: RuntimeEvent): void {
    this.telemetryTail = this.telemetryTail
      .then(() => this.options.events.publish(event))
      .catch(() => {
        // Observability must never change coordinator/gameplay semantics.
      })
  }

  private async handleEvent(event: RuntimeEvent): Promise<void> {
    if (!this.running) return

    if (event.type === 'connected') {
      this.options.identity.beginSession()
      this.minecraftReady = false
      return
    }

    if (event.type === 'spawned') {
      this.minecraftReady = true
      const task = this.activeTask
      if (task?.state === 'suspended') {
        task.state = 'active'
        task.activeGoalId = null
        this.execution = 'idle'
        if (this.aiAvailability === 'unavailable') {
          this.execution = 'decision_pending'
          if (this.recoveryRetryAt !== null) this.scheduleRecovery(this.recoveryRetryAt)
        } else {
          this.dispatchActiveTask()
        }
      }
      return
    }

    if (event.type === 'player_seen') {
      this.options.identity.observePlayer(event.player.name, event.player.id)
      return
    }

    if (event.type === 'player_left') {
      this.options.identity.removePlayer(event.player, event.playerId)
      return
    }

    if (event.type === 'disconnected') {
      this.minecraftReady = false
      this.options.identity.endSession()
      this.invalidateMinecraftManualGrants()
      this.invalidateInFlightDecision('minecraft_disconnected')
      this.abortWorkspaceChatRouting('minecraft_disconnected')
      this.clearRecoveryTimer(false)
      this.clearPendingResumeTimer()
      const task = this.activeTask
      if (task) {
        if (task.activeGoalId) {
          await this.options.goals.preemptActive('minecraft_disconnected')
          task.activeGoalId = null
        }
        task.state = 'suspended'
        this.execution = 'decision_pending'
      } else {
        this.execution = 'idle'
      }
      return
    }

    if (event.type === 'emergency_stop') {
      this.invalidateInFlightDecision('emergency_stop')
      this.abortWorkspaceChatRouting('emergency_stop')
      this.clearRecoveryTimer(true)
      this.clearPendingResumeTimer()
      if (this.activeTask) this.markTaskSuperseded(this.activeTask, 'emergency_stop')
      this.clearActiveTaskState()
      this.execution = 'idle'
      return
    }

    if (event.type === 'goal_started') {
      const goal = this.options.goals.getGoal(event.goalId)
      if (goal?.source === 'player') {
        this.supersedeActiveTaskForPlayerGoal()
        return
      }
    }

    if (
      event.type === 'goal_cancelled' &&
      event.code === 'preempted_by_player' &&
      this.activeTask?.activeGoalId === event.goalId
    ) {
      this.supersedeActiveTaskForPlayerGoal()
      return
    }

    if (
      this.activeTask === null &&
      (event.type === 'goal_completed' || event.type === 'goal_failed' || event.type === 'goal_cancelled')
    ) {
      if (this.pendingTasks.size() > 0) this.schedulePendingTaskResume()
      return
    }

    if (event.type === 'player_chat') {
      const manual = parseManualAiCommand(event.message)
      if (manual) {
        await this.handleMinecraftManualCommand(event, manual)
        return
      }
    }

    const classification = this.classifier.classify(event, {
      taskId: this.activeTask?.taskId ?? '',
      activeGoalId: this.activeTask?.activeGoalId ?? null
    })

    switch (classification.kind) {
      case 'failure_evidence':
        this.failureEvidence.add(classification.reason)
        return

      case 'goal_completed': {
        const task = this.activeTask
        if (!task || task.activeGoalId !== classification.goalId) return
        this.previousAction = this.options.goals.getGoal(classification.goalId)?.request.kind ?? null
        task.activeGoalId = null
        noteActionSuccess(task)
        this.failureEvidence.clear()
        this.pendingDecisionEvidence = {}
        this.execution = 'idle'
        this.dispatchActiveTask()
        return
      }

      case 'replan': {
        const task = this.activeTask
        if (!task || task.activeGoalId !== classification.goalId) return
        this.previousAction = this.options.goals.getGoal(classification.goalId)?.request.kind ?? null
        task.activeGoalId = null
        noteGoalFailure(task)
        if (
          task.totalReplanCount >=
          MAX_TASK_REPLANS
        ) {
          this.failureEvidence.clear()
          this.pendingDecisionEvidence = {}
          this.blockTask(
            task,
            'replan_limit_exceeded'
          )
          return
        }

        this.pendingDecisionEvidence = {
          goalFailed: true,
          ...(this.failureEvidence.has('stuck') ? { stuck: true } : {})
        }
        this.failureEvidence.clear()
        this.execution = 'idle'
        this.dispatchActiveTask()
        return
      }

      case 'explicit_instruction':
        break

      default:
        return
    }

    const principal = this.options.identity.resolveChat({
      mode: this.options.identityMode,
      player: classification.player,
      ...(classification.playerId === undefined
        ? {}
        : { playerId: classification.playerId }),
      policy: this.options.manualAccess
    })

    const sessionGeneration =
      this.currentMinecraftSessionGeneration()

    const workspaceActorPrincipal =
      this.options.identity
        .resolveObservedPlayerId({
          mode:
            this.options.identityMode,
          player:
            classification.player,
          ...(classification.playerId === undefined
            ? {}
            : {
                playerId:
                  classification.playerId
              })
        })

    this.replyGameplayMessage(
      GAMEPLAY_ACK_MESSAGE
    )

    if (
      this.options.workspaceChatRouter &&
      workspaceActorPrincipal !== null
    ) {
      this.startWorkspaceChatRouting(
        {
          instruction:
            classification.instruction,
          player:
            classification.player,
          actorPrincipal:
            workspaceActorPrincipal,
          principalKind:
            principal.kind,
          sessionGeneration,
          baseComplexityEvidence:
            classification.baseComplexityEvidence
        }
      )
      return
    }

    await this.acceptGameplayInstruction({
      instruction:
        classification.instruction,
      principalKind:
        principal.kind,
      sessionGeneration,
      baseComplexityEvidence:
        classification.baseComplexityEvidence
    })
  }

  private startWorkspaceChatRouting(
    pending: PendingWorkspaceChat
  ): void {
    const router =
      this.options.workspaceChatRouter
    if (!router) return

    const sequence =
      ++this.workspaceChatSequence
    const abort =
      new AbortController()
    this.workspaceChatAborts.set(
      sequence,
      abort
    )

    const state =
      this.options.state.snapshot()
    const player =
      state.nearbyPlayers.find(
        candidate =>
          candidate.id ===
            pending.actorPrincipal ||
          candidate.name ===
            pending.player
      )

    const request = {
      utterance:
        pending.instruction,
      actorPrincipal:
        pending.actorPrincipal,
      dimension:
        state.dimension,
      playerPosition:
        player?.position ?? null
    }

    this.workspaceChatTail =
      this.workspaceChatTail
        .then(async () => {
          if (
            abort.signal.aborted ||
            !this.running
          ) {
            return
          }

          let result:
            WorkspaceChatRouteResult
          let timeout:
            ReturnType<typeof setTimeout> |
            null = null
          let abortListener:
            (() => void) | null = null
          try {
            const cancelled =
              new Promise<
                WorkspaceChatRouteResult
              >(resolve => {
                abortListener = () => {
                  resolve({
                    kind: 'rejected',
                    code:
                      'workspace_chat_cancelled'
                  })
                }
                abort.signal
                  .addEventListener(
                    'abort',
                    abortListener,
                    { once: true }
                  )
              })

            result =
              await Promise.race([
                router.route(
                  request,
                  abort.signal
                ),
                cancelled,
                new Promise<
                  WorkspaceChatRouteResult
                >(resolve => {
                  timeout = setTimeout(
                    () => {
                      if (
                        abort.signal
                          .aborted
                      ) {
                        resolve({
                          kind:
                            'rejected',
                          code:
                            'workspace_chat_cancelled'
                        })
                        return
                      }

                      this.publishTelemetry({
                        type:
                          'runtime_watchdog',
                        at: this.now(),
                        scope:
                          'workspace_route',
                        code:
                          'workspace_route_timeout'
                      })
                      resolve({
                        kind: 'rejected',
                        code:
                          'workspace_route_timeout'
                      })
                      abort.abort(
                        'workspace_route_timeout'
                      )
                    },
                    this.workspaceRouteTimeoutMs
                  )
                })
              ])
          } catch {
            result = {
              kind: 'fallback'
            }
          } finally {
            if (timeout !== null) {
              clearTimeout(timeout)
            }
            if (
              abortListener !== null
            ) {
              abort.signal
                .removeEventListener(
                  'abort',
                  abortListener
                )
            }
          }

          this.enqueueWorkspaceChatResult(
            sequence,
            pending,
            result
          )
        })
        .catch(() => {
          // Workspace semantic routing is isolated from
          // later addressed-chat requests.
        })
  }

  private enqueueWorkspaceChatResult(
    sequence: number,
    pending: PendingWorkspaceChat,
    result: WorkspaceChatRouteResult
  ): void {
    this.mailboxTail =
      this.mailboxTail
        .then(() =>
          this.handleWorkspaceChatResult(
            sequence,
            pending,
            result
          )
        )
        .catch(() => {
          // One failed Workspace result must not poison
          // later coordinator transitions.
        })
  }

  private async handleWorkspaceChatResult(
    sequence: number,
    pending: PendingWorkspaceChat,
    result: WorkspaceChatRouteResult
  ): Promise<void> {
    this.workspaceChatAborts.delete(
      sequence
    )

    if (
      !this.running ||
      pending.sessionGeneration !==
        this.currentMinecraftSessionGeneration()
    ) {
      return
    }

    if (result.kind !== 'fallback') {
      this.replyToWorkspaceResult(
        result
      )
      return
    }

    await this.acceptGameplayInstruction(
      pending
    )
  }

  private async acceptGameplayInstruction(
    input: PendingGameplayInstruction
  ): Promise<void> {
    const task = this.createTask(
      input.instruction,
      'minecraft',
      input.principalKind,
      input.sessionGeneration,
      input.baseComplexityEvidence
    )
    await this.acceptNewTask(task)
  }

  private replyToWorkspaceResult(
    result: WorkspaceChatRouteResult
  ): void {
    const output =
      this.options.chatOutput
    if (!output) return

    const message =
      formatWorkspaceChatReply(
        result
      )
    if (!message) return

    try {
      output.sendMessage(message)
    } catch {
      // Player feedback must not change already
      // completed Workspace state transitions.
    }
  }

  private abortWorkspaceChatRouting(
    reason: string
  ): void {
    for (
      const controller of
      this.workspaceChatAborts.values()
    ) {
      controller.abort(reason)
    }
    this.workspaceChatAborts.clear()
  }

  private dispatchActiveTask(force = false): void {
    const task = this.activeTask
    if (
      !this.running ||
      task === null ||
      task.state !== 'active' ||
      !this.minecraftReady ||
      this.execution === 'decision_in_flight'
    ) {
      return
    }

    const grant = this.manualGrants.get(task.taskId)
    const grantSession = grant?.principalKind === 'local_admin'
      ? null
      : this.currentMinecraftSessionGeneration()
    const grantValid = grant?.validFor(
      task.taskId,
      task.taskGeneration,
      grantSession
    ) === true

    if (this.grantRequiredTasks.has(task.taskId) && !grantValid) {
      this.blockTask(task, 'manual_grant_invalid')
      return
    }

    if (this.aiAvailability === 'unavailable' && !force && !grantValid) {
      if (this.recoveryRetryAt === null) {
        this.blockTask(
          task,
          'ai_unavailable_no_retry'
        )
        return
      }
      this.execution = 'decision_pending'
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
        previousAction: this.previousAction,
        ...(grantValid && grant?.directive
          ? { ephemeralDirective: grant.directive }
          : {})
      },
      state,
      currentGoal: this.options.goals.activeGoal(),
      memories: this.options.memory.search({
        worldKey: this.options.worldKey,
        limit: 8
      }),
      skills: registeredDecisionSkills(this.options.registry),
      serverCapabilities:
        this.options.serverCapabilities?.status().state === 'current'
          ? this.options.serverCapabilities.snapshot()
          : [],
      ...(this.options.serverResources
        ? { serverResources: this.options.serverResources.snapshot() }
        : {}),
      safetyConstraints: this.options.safetyConstraints
    })

    const assessment = assessComplexity({
      ...task.baseComplexityEvidence,
      ...this.pendingDecisionEvidence,
      replanCount: task.consecutiveReplanCount,
      ...(grantValid ? { manualDeep: true } : {})
    })
    const routePlan = createRoutePlan(
      this.options.nextDecisionId(),
      assessment,
      grantValid
    )
    this.publishTelemetry({
      type: 'complexity_assessment',
      at: this.now(),
      decisionId: routePlan.decisionId,
      taskId: task.taskId,
      score: assessment.score,
      routeClass: assessment.routeClass,
      thinking: assessment.thinking,
      reasons: [...assessment.reasons],
      highReason: assessment.highReason
    })
    this.pendingDecisionEvidence = {}

    if (grantValid) {
      if (!grant?.consume(task.taskId, task.taskGeneration, grantSession)) return
      this.grantRequiredTasks.delete(task.taskId)
    }

    this.clearRecoveryTimer(true)
    const abort = new AbortController()
    const epoch = ++this.decisionEpoch
    this.decisionAbort = abort
    this.activeDecisionEpoch = epoch
    this.execution = 'decision_in_flight'
    this.armDecisionWatchdog(
      task,
      epoch,
      abort
    )

    void this.options.logicalExecutor
      .execute({ context, routePlan }, abort.signal)
      .then(result => {
        this.enqueueDecisionResult(task.taskId, task.taskGeneration, epoch, result)
      })
      .catch(() => {
        this.enqueueDecisionResult(task.taskId, task.taskGeneration, epoch, {
          kind: 'invalid_response',
          code: 'logical_executor_failed'
        })
      })
  }

  private async handleDecisionResult(
    taskId: string,
    taskGeneration: number,
    decisionEpoch: number,
    result: LogicalDecisionResult
  ): Promise<void> {
    if (!this.running || this.activeDecisionEpoch !== decisionEpoch) return
    this.clearDecisionWatchdog()
    const task = this.activeTask
    if (
      task === null ||
      task.taskId !== taskId ||
      task.taskGeneration !== taskGeneration ||
      task.state !== 'active'
    ) {
      return
    }

    this.activeDecisionEpoch = null
    this.decisionAbort = null
    this.execution = 'idle'

    if (result.kind === 'unavailable') {
      this.setAiAvailability('unavailable', result.retryAt)
      this.recoveryRetryAt = result.retryAt
      if (result.retryAt === null) {
        this.blockTask(
          task,
          'ai_unavailable_no_retry'
        )
        return
      }
      this.execution = 'decision_pending'
      this.scheduleRecovery(result.retryAt)
      return
    }

    if (result.kind === 'safety_blocked') {
      this.blockTask(task, result.code)
      return
    }

    if (result.kind === 'configuration_error' || result.kind === 'invalid_response') {
      this.blockTask(task, result.code)
      return
    }

    if (result.kind !== 'success') return

    this.setAiAvailability('available', null)
    this.recoveryRetryAt = null
    const gated = await this.options.decisionGate.accept(
      result.providerResult,
      this.options.state.snapshot(),
      name => this.options.registry.has(name)
    )

    if (
      this.activeTask === null ||
      this.activeTask.taskId !== taskId ||
      this.activeTask.taskGeneration !== taskGeneration ||
      this.activeTask.state !== 'active'
    ) {
      return
    }

    if (gated.kind === 'action') {
      const goal = await this.options.goals.submit(gated.goal, 'ai')
      if (
        this.activeTask === null ||
        this.activeTask.taskId !== taskId ||
        this.activeTask.taskGeneration !== taskGeneration ||
        this.activeTask.state !== 'active'
      ) {
        return
      }
      this.activeTask.activeGoalId = goal.goalId
      this.failureEvidence.clear()
      this.execution = 'goal_running'
      return
    }

    if (gated.kind === 'complete') {
      this.completeTask(task)
      return
    }

    if (gated.kind === 'blocked') {
      this.blockTask(task, gated.reason)
      return
    }

    this.blockTask(task, gated.code)
  }

  private async handleMinecraftManualCommand(
    event: Extract<RuntimeEvent, { type: 'player_chat' }>,
    command: NonNullable<ReturnType<typeof parseManualAiCommand>>
  ): Promise<void> {
    const principal = this.options.identity.resolveChat({
      mode: this.options.identityMode,
      player: event.player,
      ...(event.playerId === undefined ? {} : { playerId: event.playerId }),
      policy: this.options.manualAccess
    })
    if (!isPrivilegedMinecraftPrincipal(principal)) return

    if (command.kind === 'deep_current') {
      const task = this.activeTask
      if (!task || task.state !== 'active') return
      this.setManualGrant(task, principal.kind, command.directive)
      if (this.execution === 'idle' || this.execution === 'decision_pending') {
        this.dispatchActiveTask(true)
      }
      return
    }

    const task = this.createTask(
      command.instruction,
      'minecraft',
      principal.kind,
      this.currentMinecraftSessionGeneration(),
      analyzeInstructionComplexity(command.instruction)
    )
    this.setManualGrant(task, principal.kind)
    this.grantRequiredTasks.add(task.taskId)
    await this.acceptNewTask(task)
  }

  private async handleAdminDeepThink(
    request: AdminDeepThinkRequest
  ): Promise<CoordinatorCommandResult> {
    const instruction = normalizeInstruction(request.instruction)
    if (!instruction) return { kind: 'rejected', code: 'invalid_instruction' }

    if (request.targetGoalId !== undefined) {
      const goalId = request.targetGoalId.trim()
      const task = this.activeTask
      if (!goalId || !task || task.state !== 'active' || task.activeGoalId !== goalId) {
        return { kind: 'rejected', code: 'target_goal_not_active' }
      }
      this.setManualGrant(task, 'local_admin', instruction)
      if (this.execution === 'idle' || this.execution === 'decision_pending') {
        this.dispatchActiveTask(true)
      }
      return { kind: 'accepted', taskId: task.taskId }
    }

    const task = this.createTask(
      instruction,
      'local_admin',
      'local_admin',
      null,
      analyzeInstructionComplexity(instruction)
    )
    this.setManualGrant(task, 'local_admin')
    this.grantRequiredTasks.add(task.taskId)
    await this.acceptNewTask(task)
    return { kind: 'accepted', taskId: task.taskId }
  }

  private async handleClearAiWork(reason: string): Promise<void> {
    this.invalidateInFlightDecision(reason)
    this.clearRecoveryTimer(true)
    this.clearPendingResumeTimer()
    this.invalidateManualGrants()
    this.pendingTasks.clear()
    const task = this.activeTask
    if (task) {
      this.markTaskSuperseded(task, safeEventCode(reason, 'ai_work_cleared'))
      if (task.activeGoalId) {
        const active = this.options.goals.activeGoal()
        if (active?.goalId === task.activeGoalId && active.source === 'ai') {
          await this.options.goals.preemptActive(reason)
        }
      }
    }
    this.clearActiveTaskState()
    this.execution = 'idle'
    this.setAiAvailability('available', null)
  }

  private async handleRecovery(taskId: string, taskGeneration: number): Promise<void> {
    if (!this.running || !this.minecraftReady) return
    const task = this.activeTask
    if (
      !task ||
      task.taskId !== taskId ||
      task.taskGeneration !== taskGeneration ||
      task.state !== 'active'
    ) return

    this.recoveryRetryAt = null
    this.setAiAvailability('available', null)
    this.execution = 'idle'
    this.dispatchActiveTask(true)
  }

  private scheduleRecovery(retryAt: number): void {
    this.clearRecoveryTimer(false)
    this.recoveryRetryAt = retryAt
    if (!this.running || !this.minecraftReady || !this.activeTask) return
    const taskId = this.activeTask.taskId
    const taskGeneration = this.activeTask.taskGeneration
    const delay = Math.max(0, retryAt - this.now())
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null
      this.enqueueRecovery(taskId, taskGeneration)
    }, delay)
  }

  private schedulePendingTaskResume(): void {
    if (this.pendingResumeTimer !== null) return
    this.pendingResumeTimer = setTimeout(() => {
      this.pendingResumeTimer = null
      this.mailboxTail = this.mailboxTail
        .then(() => {
          this.startNextPendingTask()
        })
        .catch(() => {
          // A failed resume check must not poison later mailbox work.
        })
    }, 0)
  }

  private clearPendingResumeTimer(): void {
    if (this.pendingResumeTimer !== null) clearTimeout(this.pendingResumeTimer)
    this.pendingResumeTimer = null
  }

  private clearRecoveryTimer(clearRetryAt: boolean): void {
    if (this.recoveryTimer !== null) clearTimeout(this.recoveryTimer)
    this.recoveryTimer = null
    if (clearRetryAt) this.recoveryRetryAt = null
  }

  private invalidateInFlightDecision(reason: string): void {
    this.clearDecisionWatchdog()
    this.decisionAbort?.abort(reason)
    this.decisionAbort = null
    this.activeDecisionEpoch = null
  }

  private armDecisionWatchdog(
    task: AiTask,
    epoch: number,
    abort: AbortController
  ): void {
    this.clearDecisionWatchdog()
    this.decisionWatchdogTimer =
      setTimeout(() => {
        this.decisionWatchdogTimer =
          null
        const activeTask =
          this.activeTask
        if (
          !this.running ||
          this.activeDecisionEpoch !==
            epoch ||
          activeTask === null ||
          activeTask.taskId !==
            task.taskId ||
          activeTask.taskGeneration !==
            task.taskGeneration
        ) {
          return
        }

        this.publishTelemetry({
          type: 'runtime_watchdog',
          at: this.now(),
          scope: 'decision',
          code: 'decision_timeout'
        })
        this.enqueueDecisionResult(
          task.taskId,
          task.taskGeneration,
          epoch,
          {
            kind: 'invalid_response',
            code: 'decision_timeout'
          }
        )
        abort.abort(
          'decision_timeout'
        )
      }, this.decisionTimeoutMs)
  }

  private clearDecisionWatchdog(): void {
    if (
      this.decisionWatchdogTimer !==
      null
    ) {
      clearTimeout(
        this.decisionWatchdogTimer
      )
    }
    this.decisionWatchdogTimer =
      null
  }

  private replyGameplayMessage(
    message: string
  ): void {
    const output =
      this.options.chatOutput
    if (!output) return

    try {
      output.sendMessage(message)
    } catch {
      // Player-visible progress must never
      // change gameplay state.
    }
  }

  private invalidateMinecraftManualGrants(): void {
    for (const grant of this.manualGrants.values()) {
      if (grant.principalKind !== 'local_admin') grant.invalidate()
    }
  }

  private setManualGrant(
    task: AiTask,
    principalKind: 'minecraft_owner' | 'minecraft_operator' | 'local_admin',
    directive?: string
  ): void {
    this.manualGrants.get(task.taskId)?.invalidate()
    const grant = createManualRouteGrant({
      requestId: `grant-${++this.grantSequence}`,
      taskId: task.taskId,
      taskGeneration: task.taskGeneration,
      minecraftSessionGeneration: principalKind === 'local_admin'
        ? null
        : this.currentMinecraftSessionGeneration(),
      principalKind,
      ...(directive === undefined ? {} : { directive })
    })
    this.manualGrants.set(task.taskId, grant)
  }

  private createTask(
    objective: string,
    source: 'minecraft' | 'local_admin' | 'system',
    principalKind: AiTask['principalKind'],
    minecraftSessionGeneration: number | null,
    evidence: ComplexityEvidence
  ): AiTask {
    return createAiTask({
      taskId: this.options.nextTaskId(),
      objective,
      source,
      principalKind,
      taskGeneration: ++this.taskGeneration,
      minecraftSessionGeneration,
      baseComplexityEvidence: evidence
    })
  }

  private async acceptNewTask(task: AiTask): Promise<void> {
    if (this.activeTask !== null) {
      if (await this.supersedeContinuousGoal(task)) return
      if (!this.pendingTasks.enqueue(task)) {
        this.publishTelemetry({
          type: 'task_blocked',
          at: this.now(),
          taskId: task.taskId,
          code: 'task_queue_full'
        })
        this.manualGrants.get(task.taskId)?.invalidate()
        this.manualGrants.delete(task.taskId)
        this.grantRequiredTasks.delete(task.taskId)
        if (task.source === 'minecraft') {
          this.replyGameplayMessage(
            GAMEPLAY_FAILED_MESSAGE
          )
        }
      }
      return
    }

    this.activateTask(task)
    this.dispatchActiveTask()
  }

  private async supersedeContinuousGoal(nextTask: AiTask): Promise<boolean> {
    const task = this.activeTask
    if (!task || this.execution !== 'goal_running' || !task.activeGoalId) return false

    const goal = this.options.goals.getGoal(task.activeGoalId)
    if (!goal || (goal.request.kind !== 'stay' && goal.request.kind !== 'follow_player')) {
      return false
    }

    await this.options.goals.preemptActive('superseded_by_ai_task')
    this.markTaskSuperseded(task, 'superseded_by_ai_task')
    this.invalidateGrantForTask(task.taskId)
    this.clearActiveTaskState()
    this.execution = 'idle'
    this.activateTask(nextTask)
    this.dispatchActiveTask()
    return true
  }

  private supersedeActiveTaskForPlayerGoal(): void {
    const task = this.activeTask
    if (!task) return
    this.invalidateInFlightDecision('preempted_by_player')
    this.clearRecoveryTimer(true)
    this.markTaskSuperseded(task, 'preempted_by_player')
    this.clearActiveTaskState()
    this.execution = 'idle'
  }

  private startNextPendingTask(): void {
    if (
      !this.running ||
      this.activeTask !== null ||
      this.options.goals.activeGoal() !== null
    ) return
    const next = this.pendingTasks.dequeue()
    if (!next) return
    this.activateTask(next)
    this.execution = 'idle'
    this.dispatchActiveTask()
  }

  private activateTask(task: AiTask): void {
    this.activeTask = task
    this.previousAction = null
    this.failureEvidence.clear()
    this.pendingDecisionEvidence = {}
    this.publishTelemetry({
      type: 'task_started',
      at: this.now(),
      taskId: task.taskId,
      source: task.source
    })
  }

  private completeTask(task: AiTask): void {
    task.state = 'completed'
    this.publishTelemetry({
      type: 'task_completed',
      at: this.now(),
      taskId: task.taskId
    })
    if (task.source === 'minecraft') {
      this.replyGameplayMessage(
        GAMEPLAY_COMPLETE_MESSAGE
      )
    }
    this.clearActiveTaskState()
    this.execution = 'idle'
    this.startNextPendingTask()
  }

  private blockTask(task: AiTask, code: string): void {
    task.state = 'blocked'
    const safeCode =
      safeEventCode(
        code,
        'task_blocked'
      )
    this.publishTelemetry({
      type: 'task_blocked',
      at: this.now(),
      taskId: task.taskId,
      code: safeCode
    })
    if (task.source === 'minecraft') {
      this.replyGameplayMessage(
        safeCode === 'decision_timeout'
          ? GAMEPLAY_TIMEOUT_MESSAGE
          : GAMEPLAY_FAILED_MESSAGE
      )
    }
    this.clearActiveTaskState()
    this.execution = 'idle'
    this.startNextPendingTask()
  }

  private markTaskSuperseded(task: AiTask, code: string): void {
    task.state = 'superseded'
    this.publishTelemetry({
      type: 'task_superseded',
      at: this.now(),
      taskId: task.taskId,
      code: safeEventCode(code, 'task_superseded')
    })
  }

  private setAiAvailability(
    next: DecisionCoordinatorStatus['aiAvailability'],
    retryAt: number | null
  ): void {
    if (this.aiAvailability === next) return
    this.aiAvailability = next
    this.publishTelemetry({
      type: 'ai_availability_changed',
      at: this.now(),
      available: next === 'available',
      retryAt
    })
  }

  private clearActiveTaskState(): void {
    const taskId = this.activeTask?.taskId
    this.activeTask = null
    this.previousAction = null
    this.failureEvidence.clear()
    this.pendingDecisionEvidence = {}
    if (taskId) this.invalidateGrantForTask(taskId)
  }

  private invalidateGrantForTask(taskId: string): void {
    this.manualGrants.get(taskId)?.invalidate()
    this.manualGrants.delete(taskId)
    this.grantRequiredTasks.delete(taskId)
  }

  private currentMinecraftSessionGeneration(): number | null {
    const generation = this.options.identity.currentSessionGeneration()
    return generation > 0 ? generation : null
  }
}

interface PendingGameplayInstruction {
  readonly instruction: string
  readonly principalKind:
    AiTask['principalKind']
  readonly sessionGeneration:
    number | null
  readonly baseComplexityEvidence:
    ComplexityEvidence
}

interface PendingWorkspaceChat
extends PendingGameplayInstruction {
  readonly player: string
  readonly actorPrincipal: string
}

function isPrivilegedMinecraftPrincipal(
  principal: MinecraftPrincipal
): principal is Extract<MinecraftPrincipal, { kind: 'minecraft_owner' | 'minecraft_operator' }> {
  return principal.kind === 'minecraft_owner' || principal.kind === 'minecraft_operator'
}

function normalizeInstruction(value: string): string | null {
  const normalized = value.trim()
  return normalized.length >= 1 && normalized.length <= 1000 ? normalized : null
}

function safeEventCode(value: string, fallback: string): string {
  const normalized = value.trim().replace(/\s+/g, '_').slice(0, 128)
  return normalized || fallback
}
