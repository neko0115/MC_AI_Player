import type { GoalRecord, GoalRequest, GoalSource, GoalStatus } from '../contracts/goals.js'
import type {
  ItemStackSnapshot,
  PlayerSnapshot,
  Position,
  RuntimeEvent
} from '../contracts/events.js'
import type { SkillName } from '../contracts/skills.js'
import type { MinecraftMemory, MinecraftMemoryType } from '../memory/repository.js'
import type { WorldStateSnapshot } from '../state/world-state.js'

export interface DecisionSkillDescription {
  readonly name: SkillName
  readonly description: string
}

export interface DecisionTaskContext {
  readonly taskId: string
  readonly objective: string
  readonly phase: 'active'
  readonly consecutiveReplans: number
  readonly previousAction: GoalRequest['kind'] | null
  readonly ephemeralDirective?: string
}

export interface DecisionMemorySummary {
  readonly id: string
  readonly worldKey?: never
  readonly type: MinecraftMemoryType
  readonly content: string
  readonly dimension: string | null
  readonly position: Position | null
  readonly tags: readonly string[]
  readonly importance: number
  readonly observedAt: number
  readonly reinforcementCount: number
}

export interface DecisionGoalSummary {
  readonly kind: GoalRequest['kind']
  readonly args: GoalRequest['args']
  readonly source: GoalSource
  readonly status: GoalStatus
}

export interface DecisionSelfState {
  readonly connected: boolean
  readonly spawned: boolean
  readonly health: number
  readonly food: number
  readonly dimension: string | null
  readonly position: Position | null
}

export interface DecisionContext {
  readonly worldKey: string
  readonly task?: DecisionTaskContext
  readonly currentGoal: DecisionGoalSummary | null
  readonly self: DecisionSelfState
  readonly nearbyPlayers: readonly PlayerSnapshot[]
  readonly inventory: ReadonlyArray<{ readonly name: string; readonly count: number }>
  readonly recentEvents: readonly RuntimeEvent[]
  readonly memories: readonly DecisionMemorySummary[]
  readonly skills: readonly DecisionSkillDescription[]
  readonly safetyConstraints: readonly string[]
}

export interface ContextBuilderInput {
  readonly worldKey: string
  readonly task?: DecisionTaskContext
  readonly state: WorldStateSnapshot
  readonly currentGoal: GoalRecord | null
  readonly memories: readonly MinecraftMemory[]
  readonly skills: readonly DecisionSkillDescription[]
  readonly safetyConstraints: readonly string[]
}

export interface ContextBuilderOptions {
  readonly maxNearbyPlayers?: number
  readonly maxInventoryItems?: number
  readonly maxRecentEvents?: number
  readonly maxMemories?: number
  readonly maxMemoryContentChars?: number
  readonly maxMemoryTags?: number
  readonly maxSkills?: number
  readonly maxSkillDescriptionChars?: number
  readonly maxSafetyConstraints?: number
  readonly maxSafetyConstraintChars?: number
  readonly maxTaskObjectiveChars?: number
  readonly maxTaskDirectiveChars?: number
}

interface NormalizedOptions {
  maxNearbyPlayers: number
  maxInventoryItems: number
  maxRecentEvents: number
  maxMemories: number
  maxMemoryContentChars: number
  maxMemoryTags: number
  maxSkills: number
  maxSkillDescriptionChars: number
  maxSafetyConstraints: number
  maxSafetyConstraintChars: number
  maxTaskObjectiveChars: number
  maxTaskDirectiveChars: number
}

const IMPORTANT_EVENT_TYPES = new Set<RuntimeEvent['type']>([
  'disconnected',
  'adapter_error',
  'player_chat',
  'health_changed',
  'goal_completed',
  'goal_cancelled',
  'goal_failed',
  'skill_cancelled',
  'skill_failed',
  'emergency_stop',
  'decision_accepted',
  'decision_rejected',
  'memory_written',
  'stuck'
])

export class ContextBuilder {
  private readonly options: NormalizedOptions

  constructor(options: ContextBuilderOptions = {}) {
    this.options = {
      maxNearbyPlayers: options.maxNearbyPlayers ?? 8,
      maxInventoryItems: options.maxInventoryItems ?? 32,
      maxRecentEvents: options.maxRecentEvents ?? 8,
      maxMemories: options.maxMemories ?? 8,
      maxMemoryContentChars: options.maxMemoryContentChars ?? 500,
      maxMemoryTags: options.maxMemoryTags ?? 8,
      maxSkills: options.maxSkills ?? 32,
      maxSkillDescriptionChars: options.maxSkillDescriptionChars ?? 300,
      maxSafetyConstraints: options.maxSafetyConstraints ?? 16,
      maxSafetyConstraintChars: options.maxSafetyConstraintChars ?? 300,
      maxTaskObjectiveChars: options.maxTaskObjectiveChars ?? 1000,
      maxTaskDirectiveChars: options.maxTaskDirectiveChars ?? 1000
    }
    for (const [name, value] of Object.entries(this.options)) {
      validatePositiveInteger(value, name)
    }
  }

  build(input: ContextBuilderInput): DecisionContext {
    const worldKey = normalizeWorldKey(input.worldKey)
    const selfPosition = clonePosition(input.state.position)
    const task = input.task ? summarizeTask(input.task, this.options) : undefined

    return {
      worldKey,
      ...(task ? { task } : {}),
      currentGoal: summarizeGoal(input.currentGoal),
      self: {
        connected: input.state.connected,
        spawned: input.state.spawned,
        health: input.state.health,
        food: input.state.food,
        dimension: input.state.dimension,
        position: selfPosition
      },
      nearbyPlayers: summarizeNearbyPlayers(
        input.state.nearbyPlayers,
        selfPosition,
        this.options.maxNearbyPlayers
      ),
      inventory: summarizeInventory(
        input.state.inventory,
        this.options.maxInventoryItems
      ),
      recentEvents: input.state.recentEvents
        .filter(event => IMPORTANT_EVENT_TYPES.has(event.type))
        .slice(-this.options.maxRecentEvents)
        .map(cloneEvent),
      memories: input.memories
        .filter(memory => memory.worldKey === worldKey)
        .slice(0, this.options.maxMemories)
        .map(memory => summarizeMemory(memory, this.options)),
      skills: input.skills
        .slice(0, this.options.maxSkills)
        .map(skill => ({
          name: skill.name,
          description: truncate(skill.description.trim(), this.options.maxSkillDescriptionChars)
        })),
      safetyConstraints: input.safetyConstraints
        .map(value => value.trim())
        .filter(Boolean)
        .slice(0, this.options.maxSafetyConstraints)
        .map(value => truncate(value, this.options.maxSafetyConstraintChars))
    }
  }
}

function summarizeTask(
  task: DecisionTaskContext,
  options: NormalizedOptions
): DecisionTaskContext {
  const objective = truncate(task.objective.trim(), options.maxTaskObjectiveChars)
  const directive = task.ephemeralDirective?.trim()
  return {
    taskId: task.taskId,
    objective,
    phase: 'active',
    consecutiveReplans: task.consecutiveReplans,
    previousAction: task.previousAction,
    ...(directive
      ? { ephemeralDirective: truncate(directive, options.maxTaskDirectiveChars) }
      : {})
  }
}

function summarizeGoal(goal: GoalRecord | null): DecisionGoalSummary | null {
  if (!goal) return null
  return {
    kind: goal.request.kind,
    args: structuredClone(goal.request.args) as GoalRequest['args'],
    source: goal.source,
    status: goal.status
  }
}

function summarizeNearbyPlayers(
  players: readonly PlayerSnapshot[],
  selfPosition: Position | null,
  limit: number
): PlayerSnapshot[] {
  const copied = players.map(player => ({
    name: player.name,
    ...('id' in player && player.id ? { id: player.id } : {}),
    position: { ...player.position }
  }))

  if (selfPosition) {
    copied.sort((a, b) => {
      const distanceDelta = squaredDistance(a.position, selfPosition) - squaredDistance(b.position, selfPosition)
      if (distanceDelta !== 0) return distanceDelta
      return a.name.localeCompare(b.name)
    })
  }
  return copied.slice(0, limit)
}

function summarizeInventory(
  items: readonly ItemStackSnapshot[],
  limit: number
): Array<{ name: string; count: number }> {
  const order: string[] = []
  const counts = new Map<string, number>()
  for (const item of items) {
    if (!counts.has(item.name)) order.push(item.name)
    counts.set(item.name, (counts.get(item.name) ?? 0) + item.count)
  }
  return order
    .slice(0, limit)
    .map(name => ({ name, count: counts.get(name) ?? 0 }))
}

function summarizeMemory(
  memory: MinecraftMemory,
  options: NormalizedOptions
): DecisionMemorySummary {
  return {
    id: memory.id,
    type: memory.type,
    content: truncate(memory.content, options.maxMemoryContentChars),
    dimension: memory.dimension,
    position: clonePosition(memory.position),
    tags: memory.tags.slice(0, options.maxMemoryTags),
    importance: memory.importance,
    observedAt: memory.observedAt,
    reinforcementCount: memory.reinforcementCount
  }
}

function cloneEvent(event: RuntimeEvent): RuntimeEvent {
  return structuredClone(event)
}

function clonePosition(position: Position | null): Position | null {
  return position ? { ...position } : null
}

function normalizeWorldKey(value: string): string {
  const normalized = value.trim()
  if (normalized.length < 1 || normalized.length > 256) {
    throw new RangeError('worldKey must be between 1 and 256 characters')
  }
  return normalized
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum)
}

function squaredDistance(a: Position, b: Position): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return dx * dx + dy * dy + dz * dz
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`)
  }
}
