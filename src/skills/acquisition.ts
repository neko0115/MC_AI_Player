import type { Position } from '../contracts/events.js'
import type { GoalRequest } from '../contracts/goals.js'
import type {
  SkillContext,
  SkillDefinition,
  SkillResult
} from '../contracts/skills.js'
import type {
  MinecraftMemory,
  MinecraftMemoryRepository
} from '../memory/repository.js'
import type {
  ResourceCandidate,
  ResourceGatheringAdapter,
  ResourceNavigationAdapter
} from '../minecraft/gathering.js'
import {
  resolveResourceProfile,
  type ResourceProfile,
  type ResourceProfileSource
} from '../minecraft/resource-profiles.js'
import type { RuntimeEventBus } from '../telemetry/event-bus.js'
import type { ExcavateResourceSkill } from './excavation.js'
import type {
  ExploreResourceSkill,
  GatherResourceSkill
} from './gathering.js'

type AcquireArgs =
  Extract<GoalRequest, { kind: 'acquire_resource' }>['args']

interface AcquisitionDependencies {
  readonly resources: ResourceGatheringAdapter
  readonly navigation: ResourceNavigationAdapter
  readonly memory: MinecraftMemoryRepository
  readonly worldKey: string
  readonly state: () => {
    readonly dimension: string | null
  }
  readonly gather: Pick<GatherResourceSkill, 'execute'>
  readonly explore: Pick<ExploreResourceSkill, 'execute'>
  readonly excavate: Pick<ExcavateResourceSkill, 'execute'>
  readonly resourceProfiles?: ResourceProfileSource
  readonly events?: RuntimeEventBus
  readonly now?: () => number
}

interface AcquisitionProgress {
  readonly resource: string
  readonly targetCount: number
  readonly searchOrigin: Position
  readonly visitedMemoryIds: Set<string>
  exploreCompleted: boolean
  excavationDirectionIndex: number
}

const DEFAULT_EXPLORE_RADIUS = 24
const DEFAULT_EXPLORE_STEPS = 8
const DEFAULT_EXCAVATE_LENGTH = 8
const MEMORY_SCAN_RADIUS = 8
const MAX_PROGRESS_RECORDS = 128

const EXCAVATION_DIRECTIONS = [
  'north',
  'east',
  'south',
  'west'
] as const

const RECOVERABLE_GATHER_FAILURES = new Set([
  'resource_not_visible',
  'resource_changed',
  'no_path',
  'path_timeout',
  'path_stopped'
])

const RECOVERABLE_EXPLORE_FAILURES = new Set([
  'resource_not_visible',
  'exploration_exhausted'
])

const RECOVERABLE_EXCAVATION_FAILURES = new Set([
  'resource_not_found_within_excavation_budget',
  'excavation_blocked',
  'excavation_hazard_detected',
  'excavation_world_unknown',
  'no_path',
  'path_timeout',
  'path_stopped'
])

export class AcquireResourceSkill
implements SkillDefinition<AcquireArgs> {
  readonly name = 'acquire_resource' as const

  private readonly now: () => number
  private readonly suspendedProgress =
    new Map<string, AcquisitionProgress>()

  constructor(
    private readonly dependencies: AcquisitionDependencies
  ) {
    this.now = dependencies.now ?? Date.now
  }

  async execute(
    { signal, executionId }: SkillContext,
    args: AcquireArgs
  ): Promise<SkillResult> {
    if (signal.aborted) return cancelled(signal)

    const resource = normalizeResourceName(args.resource)
    if (!resource) {
      return { status: 'failed', code: 'invalid_resource' }
    }
    if (
      !Number.isInteger(args.quantity) ||
      args.quantity < 1 ||
      args.quantity > 2304
    ) {
      return { status: 'failed', code: 'invalid_quantity' }
    }

    const exploreRadius =
      args.exploreRadius ?? DEFAULT_EXPLORE_RADIUS
    const exploreSteps =
      args.exploreSteps ?? DEFAULT_EXPLORE_STEPS
    const excavateLength =
      args.excavateLength ?? DEFAULT_EXCAVATE_LENGTH

    if (
      !Number.isInteger(exploreRadius) ||
      exploreRadius < 4 ||
      exploreRadius > 64 ||
      !Number.isInteger(exploreSteps) ||
      exploreSteps < 1 ||
      exploreSteps > 16 ||
      !Number.isInteger(excavateLength) ||
      excavateLength < 1 ||
      excavateLength > 16
    ) {
      return {
        status: 'failed',
        code: 'invalid_acquisition_bounds'
      }
    }

    const profile = resolveResourceProfile(
      resource,
      this.dependencies.resourceProfiles
    )
    const currentPosition =
      this.dependencies.resources.currentPosition()
    if (!currentPosition) {
      return { status: 'failed', code: 'minecraft_not_ready' }
    }

    const executionKey = executionId?.trim() || null
    const existing = executionKey
      ? this.suspendedProgress.get(executionKey)
      : undefined

    const currentCount = inventoryCountForProfile(
      this.dependencies.resources,
      profile
    )
    const progress =
      existing?.resource === resource
        ? existing
        : {
            resource,
            targetCount: currentCount + args.quantity,
            searchOrigin: floorPosition(currentPosition),
            visitedMemoryIds: new Set<string>(),
            exploreCompleted: false,
            excavationDirectionIndex: 0
          }

    if (executionKey && progress !== existing) {
      this.rememberProgress(executionKey, progress)
    }

    try {
      while (
        inventoryCountForProfile(
          this.dependencies.resources,
          profile
        ) < progress.targetCount
      ) {
        if (signal.aborted) return cancelled(signal)

        await this.emitPhase(profile.requestedResource, 'visible')
        const visible = await this.visibleCandidate(
          profile,
          MEMORY_SCAN_RADIUS,
          signal
        )
        if (signal.aborted) return cancelled(signal)
        if (visible) {
          await this.rememberCandidate(profile, visible)
          const gathered = await this.gatherRemaining(
            profile,
            progress.targetCount,
            signal,
            executionId
          )
          if (gathered.status === 'cancelled') return gathered
          if (gathered.status === 'succeeded') {
            return { status: 'succeeded', code: 'acquired' }
          }
          if (!RECOVERABLE_GATHER_FAILURES.has(gathered.code)) {
            return gathered
          }
        }

        const memoryResult = await this.tryKnownMemories(
          profile,
          progress,
          signal,
          executionId
        )
        if (memoryResult?.status === 'cancelled') {
          return memoryResult
        }
        if (memoryResult?.status === 'succeeded') {
          return { status: 'succeeded', code: 'acquired' }
        }
        if (
          memoryResult &&
          !RECOVERABLE_GATHER_FAILURES.has(memoryResult.code)
        ) {
          return memoryResult
        }

        if (!progress.exploreCompleted) {
          await this.emitPhase(profile.requestedResource, 'explore')
          const explored = await this.dependencies.explore.execute(
            { signal, ...(executionId ? { executionId } : {}) },
            {
              resource,
              radius: exploreRadius,
              maxSteps: exploreSteps
            }
          )
          if (explored.status === 'cancelled') return explored
          progress.exploreCompleted = true

          if (explored.status === 'succeeded') {
            const found = await this.visibleCandidate(
              profile,
              exploreRadius,
              signal
            )
            if (signal.aborted) return cancelled(signal)
            if (found) {
              await this.rememberCandidate(profile, found)
              const gathered = await this.gatherRemaining(
                profile,
                progress.targetCount,
                signal,
                executionId
              )
              if (gathered.status === 'cancelled') return gathered
              if (gathered.status === 'succeeded') {
                return { status: 'succeeded', code: 'acquired' }
              }
              if (!RECOVERABLE_GATHER_FAILURES.has(gathered.code)) {
                return gathered
              }
            }
          } else if (
            !RECOVERABLE_EXPLORE_FAILURES.has(explored.code)
          ) {
            return explored
          }
        }

        const excavation = await this.tryExcavationDirections(
          profile,
          progress,
          excavateLength,
          signal,
          executionId
        )
        if (excavation?.status === 'cancelled') return excavation
        if (excavation?.status === 'succeeded') {
          return { status: 'succeeded', code: 'acquired' }
        }
        if (
          excavation &&
          !RECOVERABLE_GATHER_FAILURES.has(excavation.code) &&
          !RECOVERABLE_EXCAVATION_FAILURES.has(excavation.code)
        ) {
          return excavation
        }

        return {
          status: 'failed',
          code: 'resource_search_exhausted'
        }
      }

      return { status: 'succeeded', code: 'acquired' }
    } finally {
      if (
        executionKey &&
        !preserveProgressAfterCancellation(signal)
      ) {
        this.suspendedProgress.delete(executionKey)
      }
    }
  }

  private async tryKnownMemories(
    profile: ResourceProfile,
    progress: AcquisitionProgress,
    signal: AbortSignal,
    executionId?: string
  ): Promise<SkillResult | null> {
    await this.emitPhase(profile.requestedResource, 'memory')
    const dimension = this.dependencies.state().dimension
    const memories = this.dependencies.memory.search({
      worldKey: this.dependencies.worldKey,
      types: ['resource'],
      ...(dimension ? { dimension } : {}),
      limit: 50
    })

    const current =
      this.dependencies.resources.currentPosition()
    if (!current) {
      return { status: 'failed', code: 'minecraft_not_ready' }
    }

    const matching = memories
      .filter(memory =>
        memory.position !== null &&
        !progress.visitedMemoryIds.has(memory.id) &&
        memoryMatchesProfile(memory, profile)
      )
      .sort((left, right) =>
        squaredDistance(left.position!, current) -
        squaredDistance(right.position!, current)
      )

    for (const memory of matching) {
      if (signal.aborted) return cancelled(signal)
      if (!memory.position) continue

      const navigation = await this.dependencies.navigation.goTo(
        memory.position,
        { range: 1, canDig: false },
        signal
      )
      if (navigation.status === 'cancelled') return navigation

      progress.visitedMemoryIds.add(memory.id)
      if (navigation.status !== 'succeeded') continue

      const visible = await this.visibleCandidate(
        profile,
        MEMORY_SCAN_RADIUS,
        signal
      )
      if (signal.aborted) return cancelled(signal)
      if (!visible) continue

      await this.rememberCandidate(profile, visible)
      const gathered = await this.gatherRemaining(
        profile,
        progress.targetCount,
        signal,
        executionId
      )
      if (gathered.status === 'succeeded') return gathered
      if (gathered.status === 'cancelled') return gathered
      if (!RECOVERABLE_GATHER_FAILURES.has(gathered.code)) {
        return gathered
      }
    }

    return null
  }

  private async tryExcavationDirections(
    profile: ResourceProfile,
    progress: AcquisitionProgress,
    excavateLength: number,
    signal: AbortSignal,
    executionId?: string
  ): Promise<SkillResult | null> {
    while (
      progress.excavationDirectionIndex <
      EXCAVATION_DIRECTIONS.length
    ) {
      if (signal.aborted) return cancelled(signal)

      const direction =
        EXCAVATION_DIRECTIONS[
          progress.excavationDirectionIndex
        ]
      if (!direction) break

      const returned =
        await this.dependencies.navigation.goTo(
          progress.searchOrigin,
          { range: 1, canDig: false },
          signal
        )
      if (returned.status === 'cancelled') return returned
      if (returned.status !== 'succeeded') {
        return returned
      }

      await this.emitPhase(
        profile.requestedResource,
        'excavate',
        direction
      )
      const excavated =
        await this.dependencies.excavate.execute(
          { signal, ...(executionId ? { executionId } : {}) },
          {
            resource: progress.resource,
            direction,
            maxLength: excavateLength,
            radius: MEMORY_SCAN_RADIUS
          }
        )

      if (excavated.status === 'cancelled') return excavated
      progress.excavationDirectionIndex += 1

      if (excavated.status === 'succeeded') {
        const visible = await this.visibleCandidate(
          profile,
          MEMORY_SCAN_RADIUS,
          signal
        )
        if (signal.aborted) return cancelled(signal)
        if (visible) {
          await this.rememberCandidate(profile, visible)
          const gathered = await this.gatherRemaining(
            profile,
            progress.targetCount,
            signal,
            executionId
          )
          if (gathered.status === 'succeeded') return gathered
          if (gathered.status === 'cancelled') return gathered
          if (!RECOVERABLE_GATHER_FAILURES.has(gathered.code)) {
            return gathered
          }
        }
        continue
      }

      if (!RECOVERABLE_EXCAVATION_FAILURES.has(excavated.code)) {
        return excavated
      }
    }

    return null
  }

  private async gatherRemaining(
    profile: ResourceProfile,
    targetCount: number,
    signal: AbortSignal,
    executionId?: string
  ): Promise<SkillResult> {
    const current = inventoryCountForProfile(
      this.dependencies.resources,
      profile
    )
    const remaining = Math.max(0, targetCount - current)
    if (remaining === 0) {
      return { status: 'succeeded', code: 'gathered' }
    }

    await this.emitPhase(profile.requestedResource, 'gather')
    return this.dependencies.gather.execute(
      { signal, ...(executionId ? { executionId } : {}) },
      {
        resource: profile.requestedResource,
        quantity: remaining
      }
    )
  }

  private async visibleCandidate(
    profile: ResourceProfile,
    radius: number,
    signal: AbortSignal
  ): Promise<ResourceCandidate | null> {
    const origin =
      this.dependencies.resources.currentPosition()
    if (!origin) return null

    const candidates =
      await this.dependencies.resources.findResourceBlocks(
        {
          blockNames: profile.blockNames,
          origin,
          radius,
          limit: 16,
          visibility: 'visible'
        },
        signal
      )
    if (signal.aborted) return null

    return candidates[0] ?? null
  }

  private async rememberCandidate(
    profile: ResourceProfile,
    candidate: ResourceCandidate
  ): Promise<void> {
    const dimension = this.dependencies.state().dimension
    const keys = resourceKeys(profile)
    const tags = [
      'resource',
      ...keys.filter(key => key.length <= 64)
    ].slice(0, 32)

    const memory = this.dependencies.memory.remember({
      worldKey: this.dependencies.worldKey,
      type: 'resource',
      content:
        `Known resource ${profile.requestedResource}; ` +
        `blocks=${profile.blockNames.join(',')}; ` +
        `drops=${profile.collectedItemNames.join(',')}`,
      ...(dimension ? { dimension } : {}),
      position: { ...candidate.position },
      tags,
      importance: 0.7,
      observedAt: this.now()
    })

    await this.dependencies.events?.publish({
      type: 'memory_written',
      at: this.now(),
      memoryId: memory.id
    })
  }

  private async emitPhase(
    resource: string,
    phase:
      | 'visible'
      | 'memory'
      | 'explore'
      | 'excavate'
      | 'gather',
    direction?: 'north' | 'south' | 'east' | 'west'
  ): Promise<void> {
    await this.dependencies.events?.publish({
      type: 'resource_search_phase',
      at: this.now(),
      resource,
      phase,
      ...(direction ? { direction } : {})
    })
  }

  private rememberProgress(
    executionId: string,
    progress: AcquisitionProgress
  ): void {
    while (
      this.suspendedProgress.size >= MAX_PROGRESS_RECORDS
    ) {
      const oldest =
        this.suspendedProgress.keys().next().value
      if (oldest === undefined) break
      this.suspendedProgress.delete(oldest)
    }
    this.suspendedProgress.set(executionId, progress)
  }
}

function memoryMatchesProfile(
  memory: MinecraftMemory,
  profile: ResourceProfile
): boolean {
  const tags = new Set(
    memory.tags.map(tag => tag.toLowerCase())
  )
  const content = memory.content.toLowerCase()
  return resourceKeys(profile)
    .some(
      key =>
        tags.has(key) ||
        content.includes(key)
    )
}

function resourceKeys(
  profile: ResourceProfile
): string[] {
  return [...new Set([
    profile.requestedResource,
    ...profile.blockNames,
    ...profile.collectedItemNames
  ].map(value => value.trim().toLowerCase()))]
}

function inventoryCountForProfile(
  resources: ResourceGatheringAdapter,
  profile: ResourceProfile
): number {
  return profile.collectedItemNames.reduce(
    (total, item) =>
      total + resources.inventoryCount(item),
    0
  )
}

function floorPosition(
  position: Position
): Position {
  return {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z)
  }
}

function squaredDistance(
  left: Position,
  right: Position
): number {
  const dx = left.x - right.x
  const dy = left.y - right.y
  const dz = left.z - right.z
  return dx * dx + dy * dy + dz * dz
}

function normalizeResourceName(
  value: string
): string | null {
  const normalized = value.trim().toLowerCase()
  if (
    normalized.length < 1 ||
    normalized.length > 128 ||
    normalized === '*'
  ) {
    return null
  }
  return /^[a-z0-9_.:-]+$/.test(normalized)
    ? normalized
    : null
}

function preserveProgressAfterCancellation(
  signal: AbortSignal
): boolean {
  return (
    signal.aborted &&
    typeof signal.reason === 'string' &&
    signal.reason.trim() === 'threat_suspended'
  )
}

function cancelled(
  signal: AbortSignal
): SkillResult {
  const reason =
    typeof signal.reason === 'string'
      ? signal.reason.trim()
      : ''
  return {
    status: 'cancelled',
    code:
      reason
        ? reason.replace(/\s+/g, '_').slice(0, 128)
        : 'cancelled'
  }
}
