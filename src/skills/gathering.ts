import type { GoalRequest } from '../contracts/goals.js'
import type { Position } from '../contracts/events.js'
import type { SkillDefinition, SkillResult } from '../contracts/skills.js'
import type {
  ResourceCandidate,
  ResourceGatheringAdapter,
  ResourceNavigationAdapter
} from '../minecraft/gathering.js'
import type { SafetyPolicy } from '../safety/policy.js'
import type { WorldStateSnapshot } from '../state/world-state.js'

type GatherArgs = Extract<GoalRequest, { kind: 'gather_resource' }>['args']

export interface FindResourceArgs {
  readonly resource: string
  readonly radius?: number
}

export interface ProtectedRegion {
  readonly min: Position
  readonly max: Position
}

export interface ResourceProtectionPolicy {
  isProtected(position: Position): boolean
}

export class RegionProtectionPolicy implements ResourceProtectionPolicy {
  private readonly regions: readonly ProtectedRegion[]

  constructor(regions: readonly ProtectedRegion[]) {
    this.regions = regions.map(region => {
      if (
        region.min.x > region.max.x ||
        region.min.y > region.max.y ||
        region.min.z > region.max.z
      ) {
        throw new RangeError('protected region min must be <= max on every axis')
      }
      return {
        min: { ...region.min },
        max: { ...region.max }
      }
    })
  }

  isProtected(position: Position): boolean {
    return this.regions.some(
      region =>
        position.x >= region.min.x &&
        position.x <= region.max.x &&
        position.y >= region.min.y &&
        position.y <= region.max.y &&
        position.z >= region.min.z &&
        position.z <= region.max.z
    )
  }
}

interface FindResourceOptions {
  readonly maxSearchRadius?: number
  readonly maxCandidatesPerSearch?: number
}

export class FindResourceSkill implements SkillDefinition<FindResourceArgs> {
  readonly name = 'find_resource' as const
  private readonly maxSearchRadius: number
  private readonly maxCandidatesPerSearch: number

  constructor(
    private readonly resources: ResourceGatheringAdapter,
    private readonly protection: ResourceProtectionPolicy,
    options: FindResourceOptions = {}
  ) {
    this.maxSearchRadius = options.maxSearchRadius ?? 48
    this.maxCandidatesPerSearch = options.maxCandidatesPerSearch ?? 32
    validatePositiveInteger(this.maxSearchRadius, 'maxSearchRadius')
    validatePositiveInteger(this.maxCandidatesPerSearch, 'maxCandidatesPerSearch')
  }

  async execute(
    { signal }: { signal: AbortSignal },
    args: FindResourceArgs
  ): Promise<SkillResult> {
    if (signal.aborted) return cancelled(signal)
    const resource = normalizeResourceName(args.resource)
    if (!resource) return { status: 'failed', code: 'invalid_resource' }

    const radius = args.radius ?? this.maxSearchRadius
    if (!Number.isFinite(radius) || radius < 1 || radius > this.maxSearchRadius) {
      return { status: 'failed', code: 'invalid_search_radius' }
    }
    const origin = this.resources.currentPosition()
    if (!origin) return { status: 'failed', code: 'minecraft_not_ready' }

    const candidates = await this.resources.findResourceBlocks(
      {
        blockNames: [resource],
        origin,
        radius,
        limit: this.maxCandidatesPerSearch
      },
      signal
    )
    if (signal.aborted) return cancelled(signal)

    const candidate = selectCandidate(candidates, resource, origin, this.protection, new Set())
    if (!candidate) return { status: 'failed', code: 'resource_not_found' }

    return {
      status: 'succeeded',
      code: 'resource_found',
      summary: `${candidate.blockName}@${candidate.position.x},${candidate.position.y},${candidate.position.z}`
    }
  }
}

export interface GatheringOptions {
  readonly initialSearchRadius?: number
  readonly maxSearchRadius?: number
  readonly searchStep?: number
  readonly maxRetries?: number
  readonly maxCandidatesPerSearch?: number
}

interface GatherResourceDependencies {
  readonly resources: ResourceGatheringAdapter
  readonly navigation: ResourceNavigationAdapter
  readonly safety: SafetyPolicy
  readonly state: () => WorldStateSnapshot
  readonly protection: ResourceProtectionPolicy
  readonly options?: GatheringOptions
}

interface NormalizedGatheringOptions {
  initialSearchRadius: number
  maxSearchRadius: number
  searchStep: number
  maxRetries: number
  maxCandidatesPerSearch: number
}

const SKIPPABLE_CANDIDATE_NAVIGATION_FAILURES = new Set([
  'no_path',
  'path_timeout',
  'path_stopped'
])

export class GatherResourceSkill implements SkillDefinition<GatherArgs> {
  readonly name = 'gather_resource' as const
  private readonly options: NormalizedGatheringOptions

  constructor(private readonly dependencies: GatherResourceDependencies) {
    this.options = normalizeOptions(dependencies.options)
  }

  async execute(
    { signal }: { signal: AbortSignal },
    args: GatherArgs
  ): Promise<SkillResult> {
    if (signal.aborted) return cancelled(signal)
    const resource = normalizeResourceName(args.resource)
    if (!resource) return { status: 'failed', code: 'invalid_resource' }
    if (!Number.isInteger(args.quantity) || args.quantity < 1 || args.quantity > 2304) {
      return { status: 'failed', code: 'invalid_quantity' }
    }

    const startingCount = this.dependencies.resources.inventoryCount(resource)
    const targetCount = startingCount + args.quantity
    const attempted = new Set<string>()
    let radius = this.options.initialSearchRadius
    let failures = 0
    let lastFailureCode: string | null = null

    while (this.dependencies.resources.inventoryCount(resource) < targetCount) {
      if (signal.aborted) return cancelled(signal)
      const origin = this.dependencies.resources.currentPosition()
      if (!origin) return { status: 'failed', code: 'minecraft_not_ready' }

      const candidates = await this.dependencies.resources.findResourceBlocks(
        {
          blockNames: [resource],
          origin,
          radius,
          limit: this.options.maxCandidatesPerSearch
        },
        signal
      )
      if (signal.aborted) return cancelled(signal)

      const candidate = selectCandidate(
        candidates,
        resource,
        origin,
        this.dependencies.protection,
        attempted
      )
      if (!candidate) {
        if (radius < this.options.maxSearchRadius) {
          radius = Math.min(this.options.maxSearchRadius, radius + this.options.searchStep)
          continue
        }
        return lastFailureCode
          ? { status: 'failed', code: lastFailureCode }
          : { status: 'failed', code: 'resource_not_found' }
      }
      attempted.add(candidateKey(candidate))

      const approach = candidate.approachPosition ?? candidate.position
      const navigation = await this.dependencies.navigation.goTo(
        approach,
        { range: 1, canDig: false },
        signal
      )
      if (navigation.status === 'cancelled') return navigation
      if (navigation.status !== 'succeeded') {
        lastFailureCode = navigation.code
        if (!SKIPPABLE_CANDIDATE_NAVIGATION_FAILURES.has(navigation.code)) {
          return { status: 'failed', code: navigation.code }
        }
        continue
      }

      const permitDecision = this.dependencies.safety.issueResourceMutationPermit(
        'gather_resource',
        [resource],
        { capabilities: ['break_blocks'] },
        this.dependencies.state()
      )
      if (permitDecision.kind !== 'allow') {
        return { status: 'failed', code: permitDecision.code }
      }

      const beforeHarvest = this.dependencies.resources.inventoryCount(resource)
      const harvested = await this.dependencies.resources.harvestResourceBlock(
        candidate,
        permitDecision.permit,
        signal
      )
      if (harvested.status === 'cancelled') return harvested

      if (harvested.status !== 'succeeded') {
        if (harvested.code === 'item_not_collected') {
          const recovery = await this.dependencies.navigation.goTo(
            approach,
            { range: 1, canDig: false },
            signal
          )
          if (recovery.status === 'cancelled') return recovery
          if (
            recovery.status === 'succeeded' &&
            this.dependencies.resources.inventoryCount(resource) > beforeHarvest
          ) {
            failures = 0
            lastFailureCode = null
            continue
          }
          lastFailureCode = recovery.status === 'failed' ? recovery.code : harvested.code
        } else {
          lastFailureCode = harvested.code
        }

        failures += 1
        if (failures >= this.options.maxRetries) {
          return { status: 'failed', code: lastFailureCode }
        }
        continue
      }

      if (this.dependencies.resources.inventoryCount(resource) <= beforeHarvest) {
        lastFailureCode = 'item_not_collected'
        failures += 1
        if (failures >= this.options.maxRetries) {
          return { status: 'failed', code: lastFailureCode }
        }
        continue
      }

      failures = 0
      lastFailureCode = null
    }

    return { status: 'succeeded', code: 'gathered' }
  }
}

function selectCandidate(
  candidates: readonly ResourceCandidate[],
  resource: string,
  origin: Position,
  protection: ResourceProtectionPolicy,
  attempted: ReadonlySet<string>
): ResourceCandidate | null {
  const eligible = candidates
    .filter(candidate => candidate.blockName === resource)
    .filter(candidate => !protection.isProtected(candidate.position))
    .filter(candidate => !attempted.has(candidateKey(candidate)))
    .map(candidate => ({
      blockName: candidate.blockName,
      position: { ...candidate.position },
      ...(candidate.approachPosition
        ? { approachPosition: { ...candidate.approachPosition } }
        : {})
    }))

  eligible.sort((a, b) => {
    const aApproach = a.approachPosition ?? a.position
    const bApproach = b.approachPosition ?? b.position
    const distanceDelta = squaredDistance(aApproach, origin) - squaredDistance(bApproach, origin)
    if (distanceDelta !== 0) return distanceDelta
    return candidateKey(a).localeCompare(candidateKey(b))
  })
  return eligible[0] ?? null
}

function candidateKey(candidate: ResourceCandidate): string {
  const { x, y, z } = candidate.position
  return `${candidate.blockName}:${x},${y},${z}`
}

function squaredDistance(a: Position, b: Position): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return dx * dx + dy * dy + dz * dz
}

function normalizeResourceName(value: string): string | null {
  const name = value.trim()
  if (name.length < 1 || name.length > 128 || name === '*') return null
  return /^[a-z0-9_.:-]+$/.test(name) ? name : null
}

function normalizeOptions(options: GatheringOptions = {}): NormalizedGatheringOptions {
  const normalized = {
    initialSearchRadius: options.initialSearchRadius ?? 16,
    maxSearchRadius: options.maxSearchRadius ?? 48,
    searchStep: options.searchStep ?? 16,
    maxRetries: options.maxRetries ?? 3,
    maxCandidatesPerSearch: options.maxCandidatesPerSearch ?? 32
  }
  validatePositiveInteger(normalized.initialSearchRadius, 'initialSearchRadius')
  validatePositiveInteger(normalized.maxSearchRadius, 'maxSearchRadius')
  validatePositiveInteger(normalized.searchStep, 'searchStep')
  validatePositiveInteger(normalized.maxRetries, 'maxRetries')
  validatePositiveInteger(normalized.maxCandidatesPerSearch, 'maxCandidatesPerSearch')
  if (normalized.initialSearchRadius > normalized.maxSearchRadius) {
    throw new RangeError('initialSearchRadius must be <= maxSearchRadius')
  }
  return normalized
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`)
  }
}

function cancelled(signal: AbortSignal): SkillResult {
  const reason = typeof signal.reason === 'string' ? signal.reason.trim() : ''
  return {
    status: 'cancelled',
    code: reason ? reason.replace(/\s+/g, '_').slice(0, 128) : 'cancelled'
  }
}
