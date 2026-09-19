import type { ComplexityEvidence } from '../agent/routing/contracts.js'
import type { MinecraftPrincipal } from '../minecraft/identity-registry.js'

export type AiTaskSource = 'minecraft' | 'local_admin' | 'system'
export type AiTaskPrincipalKind = MinecraftPrincipal['kind'] | 'local_admin' | 'system_router'
export type AiTaskState = 'active' | 'suspended' | 'completed' | 'blocked' | 'superseded'

export interface AiTask {
  readonly taskId: string
  readonly objective: string
  readonly source: AiTaskSource
  readonly principalKind: AiTaskPrincipalKind
  readonly taskGeneration: number
  readonly minecraftSessionGeneration: number | null
  state: AiTaskState
  activeGoalId: string | null
  readonly baseComplexityEvidence: Readonly<ComplexityEvidence>
  consecutiveReplanCount: number
  totalReplanCount: number
}

export interface CreateAiTaskInput {
  readonly taskId: string
  readonly objective: string
  readonly source: AiTaskSource
  readonly principalKind: AiTaskPrincipalKind
  readonly taskGeneration: number
  readonly minecraftSessionGeneration: number | null
  readonly baseComplexityEvidence: ComplexityEvidence
}

export function createAiTask(input: CreateAiTaskInput): AiTask {
  const taskId = bounded(input.taskId, 'taskId', 128)
  const objective = bounded(input.objective, 'objective', 1000)
  if (!Number.isInteger(input.taskGeneration) || input.taskGeneration < 1) {
    throw new RangeError('taskGeneration must be a positive integer')
  }
  if (
    input.minecraftSessionGeneration !== null &&
    (!Number.isInteger(input.minecraftSessionGeneration) || input.minecraftSessionGeneration < 1)
  ) {
    throw new RangeError('minecraftSessionGeneration must be null or a positive integer')
  }

  return {
    taskId,
    objective,
    source: input.source,
    principalKind: input.principalKind,
    taskGeneration: input.taskGeneration,
    minecraftSessionGeneration: input.minecraftSessionGeneration,
    state: 'active',
    activeGoalId: null,
    baseComplexityEvidence: Object.freeze({ ...input.baseComplexityEvidence }),
    consecutiveReplanCount: 0,
    totalReplanCount: 0
  }
}

export function noteGoalFailure(task: AiTask): void {
  task.consecutiveReplanCount += 1
  task.totalReplanCount += 1
}

export function noteActionSuccess(task: AiTask): void {
  task.consecutiveReplanCount = 0
}

export class AiTaskQueue {
  private readonly tasks: AiTask[] = []

  constructor(private readonly capacity = 8) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 64) {
      throw new RangeError('AiTaskQueue capacity must be an integer between 1 and 64')
    }
  }

  enqueue(task: AiTask): boolean {
    if (this.tasks.length >= this.capacity) return false
    this.tasks.push(task)
    return true
  }

  dequeue(): AiTask | undefined {
    return this.tasks.shift()
  }

  size(): number {
    return this.tasks.length
  }

  clear(): void {
    this.tasks.length = 0
  }

  snapshot(): readonly AiTask[] {
    return this.tasks.map(task => ({
      ...task,
      baseComplexityEvidence: Object.freeze({ ...task.baseComplexityEvidence })
    }))
  }
}

export type ManualRouteGrantState = 'pending' | 'consumed' | 'invalidated'

export interface CreateManualRouteGrantInput {
  readonly requestId: string
  readonly taskId: string
  readonly taskGeneration: number
  readonly minecraftSessionGeneration: number | null
  readonly principalKind: 'minecraft_owner' | 'minecraft_operator' | 'local_admin'
  readonly directive?: string
}

export interface ManualRouteGrant {
  readonly requestId: string
  readonly taskId: string
  readonly taskGeneration: number
  readonly minecraftSessionGeneration: number | null
  readonly principalKind: CreateManualRouteGrantInput['principalKind']
  readonly reserveAuthorized: true
  readonly directive?: string
  readonly state: ManualRouteGrantState
  validFor(taskId: string, taskGeneration: number, minecraftSessionGeneration: number | null): boolean
  consume(taskId: string, taskGeneration: number, minecraftSessionGeneration: number | null): boolean
  invalidate(): void
}

export function createManualRouteGrant(input: CreateManualRouteGrantInput): ManualRouteGrant {
  const requestId = bounded(input.requestId, 'requestId', 128)
  const taskId = bounded(input.taskId, 'taskId', 128)
  if (!Number.isInteger(input.taskGeneration) || input.taskGeneration < 1) {
    throw new RangeError('taskGeneration must be a positive integer')
  }
  if (
    input.minecraftSessionGeneration !== null &&
    (!Number.isInteger(input.minecraftSessionGeneration) || input.minecraftSessionGeneration < 1)
  ) {
    throw new RangeError('minecraftSessionGeneration must be null or a positive integer')
  }
  const directive = input.directive === undefined
    ? undefined
    : bounded(input.directive, 'directive', 1000)

  let state: ManualRouteGrantState = 'pending'
  const matches = (
    candidateTaskId: string,
    candidateTaskGeneration: number,
    candidateSessionGeneration: number | null
  ) =>
    candidateTaskId === taskId &&
    candidateTaskGeneration === input.taskGeneration &&
    candidateSessionGeneration === input.minecraftSessionGeneration

  const grant: ManualRouteGrant = {
    requestId,
    taskId,
    taskGeneration: input.taskGeneration,
    minecraftSessionGeneration: input.minecraftSessionGeneration,
    principalKind: input.principalKind,
    reserveAuthorized: true,
    ...(directive === undefined ? {} : { directive }),
    get state() {
      return state
    },
    validFor(candidateTaskId, candidateTaskGeneration, candidateSessionGeneration) {
      return state === 'pending' && matches(
        candidateTaskId,
        candidateTaskGeneration,
        candidateSessionGeneration
      )
    },
    consume(candidateTaskId, candidateTaskGeneration, candidateSessionGeneration) {
      if (
        state !== 'pending' ||
        !matches(candidateTaskId, candidateTaskGeneration, candidateSessionGeneration)
      ) {
        return false
      }
      state = 'consumed'
      return true
    },
    invalidate() {
      if (state === 'pending') state = 'invalidated'
    }
  }
  return grant
}

export interface DecisionDemand {
  readonly demandId: string
  readonly taskId: string
  readonly causeKeys: ReadonlySet<string>
  readonly reasons: ReadonlySet<string>
  readonly createdAt: number
}

function bounded(value: string, name: string, max: number): string {
  const normalized = value.trim()
  if (normalized.length < 1 || normalized.length > max) {
    throw new RangeError(`${name} must be between 1 and ${max} characters`)
  }
  return normalized
}
