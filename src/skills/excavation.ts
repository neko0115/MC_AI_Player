import type { Position } from '../contracts/events.js'
import type { GoalRequest } from '../contracts/goals.js'
import type {
  SkillContext,
  SkillDefinition,
  SkillResult
} from '../contracts/skills.js'
import type {
  BlockObservation,
  ResourceCandidate,
  ResourceGatheringAdapter,
  ResourceNavigationAdapter
} from '../minecraft/gathering.js'
import {
  resolveResourceProfile,
  type ResourceProfile,
  type ResourceProfileSource
} from '../minecraft/resource-profiles.js'
import type { SafetyPolicy } from '../safety/policy.js'
import type { WorldStateSnapshot } from '../state/world-state.js'
import type { ResourceProtectionPolicy } from './gathering.js'

type ExcavateArgs =
  Extract<GoalRequest, { kind: 'excavate_resource' }>['args']

type ExcavationDirection =
  | 'north'
  | 'south'
  | 'east'
  | 'west'

interface ExcavationDependencies {
  readonly resources: ResourceGatheringAdapter
  readonly navigation: ResourceNavigationAdapter
  readonly safety: SafetyPolicy
  readonly state: () => WorldStateSnapshot
  readonly protection: ResourceProtectionPolicy
  readonly resourceProfiles?: ResourceProfileSource
}

interface ExcavationProgress {
  readonly resource: string
  readonly direction: ExcavationDirection
  readonly maxLength: number
  readonly radius: number
  readonly origin: Position
  nextStep: number
}

const SAFE_EXCAVATION_BLOCKS = Object.freeze([
  'stone',
  'deepslate',
  'granite',
  'diorite',
  'andesite',
  'tuff'
] as const)

const PASSABLE_BLOCKS = new Set([
  'air',
  'cave_air',
  'void_air'
])

const HAZARD_BLOCKS = new Set([
  'water',
  'lava'
])

const DEFAULT_MAX_LENGTH = 8
const DEFAULT_SCAN_RADIUS = 6
const MAX_PROGRESS_RECORDS = 128

export class ExcavateResourceSkill
implements SkillDefinition<ExcavateArgs> {
  readonly name = 'excavate_resource' as const

  private readonly suspendedProgress =
    new Map<string, ExcavationProgress>()

  constructor(
    private readonly dependencies: ExcavationDependencies
  ) {}

  async execute(
    { signal, executionId }: SkillContext,
    args: ExcavateArgs
  ): Promise<SkillResult> {
    if (signal.aborted) return cancelled(signal)

    const resource = normalizeResourceName(args.resource)
    if (!resource) {
      return { status: 'failed', code: 'invalid_resource' }
    }
    if (!isDirection(args.direction)) {
      return { status: 'failed', code: 'invalid_excavation_direction' }
    }

    const maxLength = args.maxLength ?? DEFAULT_MAX_LENGTH
    const radius = args.radius ?? DEFAULT_SCAN_RADIUS
    if (
      !Number.isInteger(maxLength) ||
      maxLength < 1 ||
      maxLength > 16 ||
      !Number.isInteger(radius) ||
      radius < 2 ||
      radius > 8
    ) {
      return { status: 'failed', code: 'invalid_excavation_bounds' }
    }

    const resources = this.dependencies.resources
    if (
      !resources.inspectBlock ||
      !resources.prepareResourceTool
    ) {
      return {
        status: 'failed',
        code: 'excavation_unavailable'
      }
    }

    const profile = resolveResourceProfile(
      resource,
      this.dependencies.resourceProfiles
    )

    const initiallyVisible =
      await this.visibleCandidate(profile, radius, signal)
    if (signal.aborted) return cancelled(signal)
    if (initiallyVisible) {
      return resourceFoundResult(initiallyVisible)
    }

    const current = resources.currentPosition()
    if (!current) {
      return { status: 'failed', code: 'minecraft_not_ready' }
    }

    const executionKey = executionId?.trim() || null
    const existing = executionKey
      ? this.suspendedProgress.get(executionKey)
      : undefined
    const progress =
      existing &&
      existing.resource === resource &&
      existing.direction === args.direction &&
      existing.maxLength === maxLength &&
      existing.radius === radius
        ? existing
        : {
            resource,
            direction: args.direction,
            maxLength,
            radius,
            origin: floorPosition(current),
            nextStep: 1
          }

    if (executionKey && progress !== existing) {
      this.rememberProgress(executionKey, progress)
    }

    const permitDecision =
      this.dependencies.safety.issueResourceMutationPermit(
        'excavate_resource',
        SAFE_EXCAVATION_BLOCKS,
        { capabilities: ['break_blocks'] },
        this.dependencies.state()
      )
    if (permitDecision.kind !== 'allow') {
      return {
        status: 'failed',
        code: permitDecision.code
      }
    }

    try {
      for (
        let step = progress.nextStep;
        step <= progress.maxLength;
        step += 1
      ) {
        if (signal.aborted) return cancelled(signal)

        const anchor = tunnelPosition(
          progress.origin,
          progress.direction,
          step - 1
        )
        const anchorNavigation =
          await this.dependencies.navigation.goTo(
            anchor,
            { range: 1, canDig: false },
            signal
          )
        if (anchorNavigation.status === 'cancelled') {
          return anchorNavigation
        }
        if (anchorNavigation.status !== 'succeeded') {
          return {
            status: 'failed',
            code: anchorNavigation.code
          }
        }

        const beforeSlice =
          await this.visibleCandidate(
            profile,
            progress.radius,
            signal
          )
        if (signal.aborted) return cancelled(signal)
        if (beforeSlice) {
          return resourceFoundResult(beforeSlice)
        }

        const feet = tunnelPosition(
          progress.origin,
          progress.direction,
          step
        )
        const head = {
          ...feet,
          y: feet.y + 1
        }

        if (
          this.dependencies.protection.isProtected(feet) ||
          this.dependencies.protection.isProtected(head)
        ) {
          return {
            status: 'failed',
            code: 'protected_region'
          }
        }

        const hazard = inspectHazardEnvelope(
          resources,
          [feet, head]
        )
        if (hazard === 'unknown') {
          return {
            status: 'failed',
            code: 'excavation_world_unknown'
          }
        }
        if (hazard === 'hazard') {
          return {
            status: 'failed',
            code: 'excavation_hazard_detected'
          }
        }

        for (const cell of [head, feet]) {
          if (signal.aborted) return cancelled(signal)

          const observed = resources.inspectBlock(cell)
          if (!observed) {
            return {
              status: 'failed',
              code: 'excavation_world_unknown'
            }
          }
          if (PASSABLE_BLOCKS.has(observed.name)) continue
          if (HAZARD_BLOCKS.has(observed.name)) {
            return {
              status: 'failed',
              code: 'excavation_hazard_detected'
            }
          }
          if (!isSafeExcavationBlock(observed.name)) {
            return {
              status: 'failed',
              code: 'excavation_blocked'
            }
          }

          const candidate: ResourceCandidate = {
            blockName: observed.name,
            position: { ...observed.position }
          }

          const tool = await resources.prepareResourceTool(
            candidate,
            signal,
            { toolKind: 'pickaxe' }
          )
          if (tool.status === 'cancelled') return tool
          if (tool.status !== 'succeeded') return tool

          const removed = await resources.harvestResourceBlock(
            candidate,
            permitDecision.permit,
            signal,
            { requireCollection: false }
          )
          if (removed.status === 'cancelled') return removed
          if (removed.status !== 'succeeded') return removed

          const after = resources.inspectBlock(cell)
          if (!after) {
            return {
              status: 'failed',
              code: 'excavation_world_unknown'
            }
          }
          if (!PASSABLE_BLOCKS.has(after.name)) {
            return {
              status: 'failed',
              code: 'excavation_not_cleared'
            }
          }
        }

        progress.nextStep = step + 1

        const advance =
          await this.dependencies.navigation.goTo(
            feet,
            { range: 0, canDig: false },
            signal
          )
        if (advance.status === 'cancelled') return advance
        if (advance.status !== 'succeeded') {
          return {
            status: 'failed',
            code: advance.code
          }
        }

        const visible =
          await this.visibleCandidate(
            profile,
            progress.radius,
            signal
          )
        if (signal.aborted) return cancelled(signal)
        if (visible) {
          return resourceFoundResult(visible)
        }
      }

      return {
        status: 'failed',
        code: 'resource_not_found_within_excavation_budget'
      }
    } finally {
      if (
        executionKey &&
        !preserveProgressAfterCancellation(signal)
      ) {
        this.suspendedProgress.delete(executionKey)
      }
    }
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

    return candidates.find(
      candidate =>
        !this.dependencies.protection
          .isProtected(candidate.position)
    ) ?? null
  }

  private rememberProgress(
    executionId: string,
    progress: ExcavationProgress
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

function inspectHazardEnvelope(
  resources: ResourceGatheringAdapter,
  cells: readonly Position[]
): 'clear' | 'hazard' | 'unknown' {
  if (!resources.inspectBlock) return 'unknown'

  const positions = new Map<string, Position>()
  for (const cell of cells) {
    for (const candidate of [
      cell,
      { ...cell, x: cell.x + 1 },
      { ...cell, x: cell.x - 1 },
      { ...cell, y: cell.y + 1 },
      { ...cell, y: cell.y - 1 },
      { ...cell, z: cell.z + 1 },
      { ...cell, z: cell.z - 1 }
    ]) {
      positions.set(positionKey(candidate), candidate)
    }
  }

  for (const position of positions.values()) {
    const observed = resources.inspectBlock(position)
    if (!observed) return 'unknown'
    if (HAZARD_BLOCKS.has(observed.name)) {
      return 'hazard'
    }
  }

  return 'clear'
}

function isSafeExcavationBlock(name: string): boolean {
  return (SAFE_EXCAVATION_BLOCKS as readonly string[])
    .includes(name)
}

function tunnelPosition(
  origin: Position,
  direction: ExcavationDirection,
  step: number
): Position {
  const vector = directionVector(direction)
  return {
    x: origin.x + vector.x * step,
    y: origin.y,
    z: origin.z + vector.z * step
  }
}

function directionVector(
  direction: ExcavationDirection
): { x: number; z: number } {
  switch (direction) {
    case 'north':
      return { x: 0, z: -1 }
    case 'south':
      return { x: 0, z: 1 }
    case 'east':
      return { x: 1, z: 0 }
    case 'west':
      return { x: -1, z: 0 }
  }
}

function floorPosition(position: Position): Position {
  return {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z)
  }
}

function resourceFoundResult(
  candidate: ResourceCandidate
): SkillResult {
  return {
    status: 'succeeded',
    code: 'resource_found',
    summary:
      `${candidate.blockName}@${candidate.position.x},` +
      `${candidate.position.y},${candidate.position.z}`
  }
}

function isDirection(
  value: string
): value is ExcavationDirection {
  return (
    value === 'north' ||
    value === 'south' ||
    value === 'east' ||
    value === 'west'
  )
}

function normalizeResourceName(
  value: string
): string | null {
  const name = value.trim().toLowerCase()
  if (
    name.length < 1 ||
    name.length > 128 ||
    name === '*'
  ) {
    return null
  }
  return /^[a-z0-9_.:-]+$/.test(name)
    ? name
    : null
}

function positionKey(position: Position): string {
  return `${position.x},${position.y},${position.z}`
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

function cancelled(signal: AbortSignal): SkillResult {
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
