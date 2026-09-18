import type { GoalRequest } from '../contracts/goals.js'
import type { Position } from '../contracts/events.js'
import type {
  SkillContext,
  SkillDefinition,
  SkillResult
} from '../contracts/skills.js'
import type {
  PlayerResourceCollection,
  ResourceCandidate,
  ResourceGatheringAdapter,
  ResourceHarvestOptions,
  ResourceNavigationAdapter
} from '../minecraft/gathering.js'
import type {
  ServerCapability,
  ServerCapabilityStatusSource
} from '../minecraft/moxuebridge-capabilities.js'
import {
  resolveResourceProfile,
  type LeafCleanupPolicy,
  type ResourceProfile,
  type ResourceProfileSource
} from '../minecraft/resource-profiles.js'
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
  readonly resourceProfiles?: ResourceProfileSource
}

export class FindResourceSkill implements SkillDefinition<FindResourceArgs> {
  readonly name = 'find_resource' as const
  private readonly maxSearchRadius: number
  private readonly maxCandidatesPerSearch: number
  private readonly resourceProfiles: ResourceProfileSource | undefined

  constructor(
    private readonly resources: ResourceGatheringAdapter,
    private readonly protection: ResourceProtectionPolicy,
    options: FindResourceOptions = {}
  ) {
    this.maxSearchRadius = options.maxSearchRadius ?? 48
    this.maxCandidatesPerSearch = options.maxCandidatesPerSearch ?? 32
    this.resourceProfiles = options.resourceProfiles
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
    const profile = resolveResourceProfile(
      resource,
      this.resourceProfiles
    )

    const radius = args.radius ?? this.maxSearchRadius
    if (!Number.isFinite(radius) || radius < 1 || radius > this.maxSearchRadius) {
      return { status: 'failed', code: 'invalid_search_radius' }
    }
    const origin = this.resources.currentPosition()
    if (!origin) return { status: 'failed', code: 'minecraft_not_ready' }

    const candidates = await this.resources.findResourceBlocks(
      {
        blockNames: profile.blockNames,
        origin,
        radius,
        limit: this.maxCandidatesPerSearch,
        visibility: 'visible'
      },
      signal
    )
    if (signal.aborted) return cancelled(signal)

    const candidate = selectCandidate(
      candidates,
      profile.blockNames,
      origin,
      this.protection,
      new Set()
    )
    if (!candidate) return { status: 'failed', code: 'resource_not_visible' }

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
  readonly maxUncollectedHarvests?: number
  readonly cooperativePickupNoticeThreshold?: number
  readonly leafCleanupPolicyOverride?: LeafCleanupPolicy
}

export interface ServerCapabilityUsageNotice {
  readonly capability: string
  readonly resource: string
  readonly maxChain: number
}

export interface CooperativePickupNotice {
  readonly resource: string
  readonly player: string
  readonly interceptedCount: number
  readonly remaining: number
}

interface GatherResourceDependencies {
  readonly resources: ResourceGatheringAdapter
  readonly navigation: ResourceNavigationAdapter
  readonly safety: SafetyPolicy
  readonly state: () => WorldStateSnapshot
  readonly protection: ResourceProtectionPolicy
  readonly capabilities?: ServerCapabilityStatusSource
  readonly resourceProfiles?: ResourceProfileSource
  readonly options?: GatheringOptions
  readonly onCapabilityUsed?: (notice: ServerCapabilityUsageNotice) => void
  readonly onCooperativePickup?: (notice: CooperativePickupNotice) => void
}

interface NormalizedGatheringOptions {
  initialSearchRadius: number
  maxSearchRadius: number
  searchStep: number
  maxRetries: number
  maxCandidatesPerSearch: number
  maxUncollectedHarvests: number
  cooperativePickupNoticeThreshold: number
  leafCleanupPolicyOverride: LeafCleanupPolicy | null
}

type DropRecoveryOutcome =
  | { readonly kind: 'collected' }
  | { readonly kind: 'collected_by_player'; readonly player: string; readonly count: number }
  | { readonly kind: 'missed' }
  | { readonly kind: 'terminal'; readonly result: SkillResult }

const SKIPPABLE_CANDIDATE_NAVIGATION_FAILURES = new Set([
  'no_path',
  'path_timeout',
  'path_stopped'
])
const DROP_SEARCH_RADIUS = 4
const DROP_PICKUP_ATTEMPTS = 3
const MAX_ACCELERATOR_CHAIN = 256
const LEAF_CLEANUP_RADIUS = 8
const MAX_LEAF_CLEANUP_BLOCKS = 128

export class GatherResourceSkill implements SkillDefinition<GatherArgs> {
  readonly name = 'gather_resource' as const
  private readonly options: NormalizedGatheringOptions
  private readonly suspendedTargets = new Map<
    string,
    { resource: string; targetCount: number }
  >()

  constructor(private readonly dependencies: GatherResourceDependencies) {
    this.options = normalizeOptions(dependencies.options)
  }

  async execute(
    { signal, executionId }: SkillContext,
    args: GatherArgs
  ): Promise<SkillResult> {
    if (signal.aborted) return cancelled(signal)
    const resource = normalizeResourceName(args.resource)
    if (!resource) return { status: 'failed', code: 'invalid_resource' }
    const profile = resolveResourceProfile(
      resource,
      this.dependencies.resourceProfiles
    )
    if (!Number.isInteger(args.quantity) || args.quantity < 1 || args.quantity > 2304) {
      return { status: 'failed', code: 'invalid_quantity' }
    }

    const startingCount = inventoryCountForProfile(
      this.dependencies.resources,
      profile
    )
    const executionKey = executionId?.trim() || null
    const suspendedTarget = executionKey
      ? this.suspendedTargets.get(executionKey)
      : undefined
    const targetCount =
      suspendedTarget?.resource === resource
        ? suspendedTarget.targetCount
        : startingCount + args.quantity

    if (executionKey && suspendedTarget?.resource !== resource) {
      this.rememberSuspendedTarget(
        executionKey,
        resource,
        targetCount
      )
    }

    try {
    const attempted = new Set<string>()
    let radius = this.options.initialSearchRadius
    let failures = 0
    let uncollectedHarvests = 0
    const playerInterceptedCounts = new Map<string, number>()
    let cooperativeNoticeSent = false
    let lastFailureCode: string | null = null

    while (inventoryCountForProfile(this.dependencies.resources, profile) < targetCount) {
      if (signal.aborted) return cancelled(signal)
      const origin = this.dependencies.resources.currentPosition()
      if (!origin) return { status: 'failed', code: 'minecraft_not_ready' }

      const candidates = await this.dependencies.resources.findResourceBlocks(
        {
          blockNames: profile.blockNames,
          origin,
          radius,
          limit: this.options.maxCandidatesPerSearch,
          visibility: 'visible'
        },
        signal
      )
      if (signal.aborted) return cancelled(signal)

      const candidate = selectCandidate(
        candidates,
        profile.blockNames,
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
          : { status: 'failed', code: 'resource_not_visible' }
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
        profile.blockNames,
        { capabilities: ['break_blocks'] },
        this.dependencies.state()
      )
      if (permitDecision.kind !== 'allow') {
        return { status: 'failed', code: permitDecision.code }
      }

      const collectionCursor = this.dependencies.resources.resourceCollectionCursor?.() ?? null
      const beforeHarvest = inventoryCountForProfile(
        this.dependencies.resources,
        profile
      )
      const capabilityStrategy = selectHarvestCapability(
        this.dependencies.capabilities,
        profile,
        candidate.blockName
      )
      let harvestOptions = expectedDropOptions(profile, candidate)
      let activeCapabilityStrategy: CapabilityHarvestStrategy | null = null
      let capabilityPrepared = false

      if (capabilityStrategy) {
        const prepared = await prepareCapabilityHarvest(
          this.dependencies.resources,
          candidate,
          capabilityStrategy,
          signal
        )
        if (prepared.kind === 'cancelled') return prepared.result
        if (prepared.kind === 'ready') {
          capabilityPrepared = true
          harvestOptions = mergeHarvestOptions(
            harvestOptions,
            capabilityStrategy.options
          )
          activeCapabilityStrategy = capabilityStrategy
        }
      }

      if (!capabilityPrepared) {
        const profileTool = await prepareResourceProfileTool(
          this.dependencies.resources,
          candidate,
          profile,
          signal
        )
        if (profileTool?.status === 'cancelled') return profileTool
        if (profileTool && profileTool.status !== 'succeeded') return profileTool
      }

      const harvested = await this.dependencies.resources.harvestResourceBlock(
        candidate,
        permitDecision.permit,
        signal,
        harvestOptions
      )
      if (harvested.status === 'cancelled') return harvested

      const capabilityDigCompleted =
        activeCapabilityStrategy !== null &&
        (
          harvested.status === 'succeeded' ||
          (harvested.status === 'failed' && harvested.code === 'item_not_collected')
        )

      if (capabilityDigCompleted && activeCapabilityStrategy) {
        safelyNotifyCapability(this.dependencies.onCapabilityUsed, {
          capability: activeCapabilityStrategy.capability.id,
          resource,
          maxChain: activeCapabilityStrategy.maxChain
        })

        const sweep = await this.collectAcceleratedDrops(
          candidate,
          profile,
          targetCount,
          activeCapabilityStrategy.maxChain,
          signal
        )
        if (sweep) return sweep

        if (activeCapabilityStrategy.capability.id === 'tree_felling') {
          const cleanup = await this.cleanupDecayingLeaves(
            candidate,
            profile,
            signal
          )
          if (cleanup?.status === 'cancelled') return cleanup
        }

        if (inventoryCountForProfile(this.dependencies.resources, profile) >= targetCount) {
          failures = 0
          lastFailureCode = null
          continue
        }
      }

      if (harvested.status !== 'succeeded') {
        if (harvested.code === 'item_not_collected') {
          const recovery = await this.recoverDroppedResource(
            candidate,
            profile,
            beforeHarvest,
            collectionCursor,
            signal
          )
          if (recovery.kind === 'terminal') return recovery.result
          if (recovery.kind === 'collected') {
            failures = 0
            if (uncollectedHarvests === 0) lastFailureCode = null
            continue
          }

          uncollectedHarvests += 1
          failures = 0
          lastFailureCode = 'item_not_collected'

          if (recovery.kind === 'collected_by_player') {
            const playerInterceptedCount =
              (playerInterceptedCounts.get(recovery.player) ?? 0) + Math.max(1, recovery.count)
            playerInterceptedCounts.set(recovery.player, playerInterceptedCount)
            if (
              !cooperativeNoticeSent &&
              playerInterceptedCount >= this.options.cooperativePickupNoticeThreshold
            ) {
              cooperativeNoticeSent = true
              const remaining = Math.max(
                0,
                targetCount - inventoryCountForProfile(this.dependencies.resources, profile)
              )
              safelyNotify(this.dependencies.onCooperativePickup, {
                resource,
                player: recovery.player,
                interceptedCount: playerInterceptedCount,
                remaining
              })
            }
          }

          if (uncollectedHarvests >= this.options.maxUncollectedHarvests) {
            return { status: 'failed', code: 'item_not_collected' }
          }
          continue
        }

        lastFailureCode = harvested.code
        failures += 1
        if (failures >= this.options.maxRetries) {
          return { status: 'failed', code: lastFailureCode }
        }
        continue
      }

      if (inventoryCountForProfile(this.dependencies.resources, profile) <= beforeHarvest) {
        uncollectedHarvests += 1
        failures = 0
        lastFailureCode = 'item_not_collected'
        if (uncollectedHarvests >= this.options.maxUncollectedHarvests) {
          return { status: 'failed', code: 'item_not_collected' }
        }
        continue
      }

      failures = 0
      if (uncollectedHarvests === 0) lastFailureCode = null
    }

    return { status: 'succeeded', code: 'gathered' }
    } finally {
      if (executionKey && !preserveTargetAfterCancellation(signal)) {
        this.suspendedTargets.delete(executionKey)
      }
    }
  }

  private rememberSuspendedTarget(
    executionId: string,
    resource: string,
    targetCount: number
  ): void {
    while (this.suspendedTargets.size >= 128) {
      const oldest = this.suspendedTargets.keys().next().value
      if (oldest === undefined) break
      this.suspendedTargets.delete(oldest)
    }
    this.suspendedTargets.set(executionId, {
      resource,
      targetCount
    })
  }


  private async cleanupDecayingLeaves(
    origin: ResourceCandidate,
    profile: ResourceProfile,
    signal: AbortSignal
  ): Promise<SkillResult | null> {
    if (
      (this.options.leafCleanupPolicyOverride ?? profile.leafCleanupPolicy) !== 'remove_after_felling' ||
      profile.relatedLeafNames.length === 0 ||
      !this.dependencies.resources.findDecayingLeafBlocks
    ) {
      return null
    }

    const leaves = await this.dependencies.resources.findDecayingLeafBlocks(
      profile.relatedLeafNames,
      origin.position,
      LEAF_CLEANUP_RADIUS,
      MAX_LEAF_CLEANUP_BLOCKS,
      signal
    )
    if (signal.aborted) return cancelled(signal)
    if (leaves.length === 0) return null

    const permitDecision = this.dependencies.safety.issueResourceMutationPermit(
      'gather_resource',
      profile.relatedLeafNames,
      { capabilities: ['break_blocks'] },
      this.dependencies.state()
    )
    if (permitDecision.kind !== 'allow') return null

    for (const leaf of leaves) {
      if (signal.aborted) return cancelled(signal)
      if (this.dependencies.protection.isProtected(leaf.position)) continue

      const navigation = await this.dependencies.navigation.goTo(
        leaf.approachPosition ?? leaf.position,
        { range: 1, canDig: false },
        signal
      )
      if (navigation.status === 'cancelled') return navigation
      if (navigation.status !== 'succeeded') continue

      const removed = await this.dependencies.resources.harvestResourceBlock(
        leaf,
        permitDecision.permit,
        signal,
        { requireCollection: false }
      )
      if (removed.status === 'cancelled') return removed
    }

    return null
  }

  private async collectAcceleratedDrops(
    candidate: ResourceCandidate,
    profile: ResourceProfile,
    targetCount: number,
    maxChain: number,
    signal: AbortSignal
  ): Promise<SkillResult | null> {
    if (!this.dependencies.resources.findDroppedResource) return null

    const attempts = Math.min(Math.max(1, maxChain), MAX_ACCELERATOR_CHAIN)
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal.aborted) return cancelled(signal)
      const before = inventoryCountForProfile(this.dependencies.resources, profile)
      const cursor = this.dependencies.resources.resourceCollectionCursor?.() ?? null
      const recovery = await this.recoverDroppedResource(
        candidate,
        profile,
        before,
        cursor,
        signal
      )

      if (recovery.kind === 'terminal') return recovery.result
      if (recovery.kind === 'collected') continue
      if (recovery.kind === 'collected_by_player') {
        return inventoryCountForProfile(
          this.dependencies.resources,
          profile
        ) >= targetCount
          ? null
          : { status: 'failed', code: 'item_not_collected' }
      }
      break
    }

    return null
  }

  private async recoverDroppedResource(
    candidate: ResourceCandidate,
    profile: ResourceProfile,
    beforeHarvest: number,
    collectionCursor: number | null,
    signal: AbortSignal
  ): Promise<DropRecoveryOutcome> {
    const resources = this.dependencies.resources
    if (resources.findDroppedResource && resources.droppedResourceStatus) {
      let drop = await findExpectedDroppedResource(
        resources,
        profile,
        candidate.position,
        DROP_SEARCH_RADIUS,
        signal
      )
      if (signal.aborted) return { kind: 'terminal', result: cancelled(signal) }

      if (drop) {
        for (let attempt = 0; attempt < DROP_PICKUP_ATTEMPTS; attempt += 1) {
          const navigation = await this.dependencies.navigation.goTo(
            drop.position,
            { range: 0, canDig: false },
            signal
          )
          if (navigation.status === 'cancelled') {
            return { kind: 'terminal', result: navigation }
          }
          if (inventoryCountForProfile(resources, profile) > beforeHarvest) {
            return { kind: 'collected' }
          }

          const status = resources.droppedResourceStatus(drop.entityId)
          if (status.kind === 'collected_by_player') {
            return {
              kind: 'collected_by_player',
              player: status.player,
              count: status.count
            }
          }
          if (status.kind === 'collected_by_bot') {
            return inventoryCountForProfile(resources, profile) > beforeHarvest
              ? { kind: 'collected' }
              : { kind: 'missed' }
          }
          if (status.kind === 'gone') break
          drop = status.drop
        }
      }
    }

    const fastPlayerCollection = this.findPlayerCollectionAfter(
      collectionCursor,
      profile,
      candidate.position
    )
    if (fastPlayerCollection) return fastPlayerCollection

    if (candidate.pickupPosition) {
      const recovery = await this.dependencies.navigation.goTo(
        candidate.pickupPosition,
        { range: 0, canDig: false },
        signal
      )
      if (recovery.status === 'cancelled') {
        return { kind: 'terminal', result: recovery }
      }
      if (inventoryCountForProfile(resources, profile) > beforeHarvest) {
        return { kind: 'collected' }
      }
    }

    return this.findPlayerCollectionAfter(collectionCursor, profile, candidate.position) ?? {
      kind: 'missed'
    }
  }

  private findPlayerCollectionAfter(
    cursor: number | null,
    profile: ResourceProfile,
    origin: Position
  ): Extract<DropRecoveryOutcome, { kind: 'collected_by_player' }> | null {
    const resources = this.dependencies.resources
    if (cursor === null || !resources.findPlayerResourceCollectionAfter) return null

    let collection: PlayerResourceCollection | null = null
    for (const itemName of profile.collectedItemNames) {
      const candidate = resources.findPlayerResourceCollectionAfter(
        cursor,
        itemName,
        origin,
        DROP_SEARCH_RADIUS
      )
      if (
        candidate &&
        (collection === null || candidate.sequence < collection.sequence)
      ) {
        collection = candidate
      }
    }
    if (!collection) return null
    return {
      kind: 'collected_by_player',
      player: collection.player,
      count: collection.count
    }
  }
}


interface CapabilityHarvestStrategy {
  readonly capability: ServerCapability
  readonly options: ResourceHarvestOptions
  readonly correctToolRequired: boolean
  readonly maxChain: number
  readonly toolKind: 'axe' | 'pickaxe' | null
  readonly forbiddenToolEnchantments: readonly string[]
}

type CapabilityPreparation =
  | { readonly kind: 'ready' }
  | { readonly kind: 'fallback' }
  | { readonly kind: 'cancelled'; readonly result: SkillResult }

async function prepareCapabilityHarvest(
  resources: ResourceGatheringAdapter,
  candidate: ResourceCandidate,
  strategy: CapabilityHarvestStrategy,
  signal: AbortSignal
): Promise<CapabilityPreparation> {
  if (!strategy.correctToolRequired) return { kind: 'ready' }
  if (!resources.prepareResourceTool) return { kind: 'fallback' }

  const prepared = await resources.prepareResourceTool(
    candidate,
    signal,
    {
      ...(strategy.toolKind ? { toolKind: strategy.toolKind } : {}),
      forbiddenEnchantments: strategy.forbiddenToolEnchantments
    }
  )
  if (prepared.status === 'cancelled') {
    return { kind: 'cancelled', result: prepared }
  }
  return prepared.status === 'succeeded'
    ? { kind: 'ready' }
    : { kind: 'fallback' }
}

function selectHarvestCapability(
  source: ServerCapabilityStatusSource | undefined,
  profile: ResourceProfile,
  candidateBlockName: string
): CapabilityHarvestStrategy | null {
  if (!source) return null
  if (source.status().state !== 'current') return null
  if (!profile.capabilityId || !profile.minimumOnePerBlock) return null

  const capability = source.get(profile.capabilityId)
  if (!capability?.available) return null

  const maxChain = positiveIntegerConstraint(capability, 'max_chain')
  // A chain accelerator may intentionally over-collect because gather quantity
  // is a minimum fulfillment target. Scope must still be exact and the chain
  // itself must stay inside a separate hard safety bound.
  if (booleanConstraint(capability, 'same_block_only') !== true) return null
  const exactBlock = exactBlockConstraint(capability)
  if (exactBlock === null || exactBlock !== candidateBlockName) return null
  if (maxChain === null || maxChain > MAX_ACCELERATOR_CHAIN) return null

  const trigger = capability.usage.trigger
  if (trigger !== 'break' && trigger !== 'sneak_and_break') return null

  const mustSneak =
    trigger === 'sneak_and_break' ||
    booleanConstraint(capability, 'must_sneak') === true

  const correctToolRequired =
    booleanConstraint(capability, 'correct_tool_required') === true
  const toolKind = toolKindConstraint(capability)
  if (correctToolRequired && toolKind === null) return null
  if (profile.toolKind && toolKind !== profile.toolKind) return null

  return {
    capability,
    options: mustSneak ? { sneak: true } : {},
    correctToolRequired,
    maxChain,
    toolKind,
    forbiddenToolEnchantments:
      profile.acceleratorForbiddenToolEnchantments
  }
}

async function prepareResourceProfileTool(
  resources: ResourceGatheringAdapter,
  candidate: ResourceCandidate,
  profile: ResourceProfile,
  signal: AbortSignal
): Promise<SkillResult | null> {
  if (!profile.toolKind) return null
  if (!resources.prepareResourceTool) {
    return { status: 'failed', code: 'correct_tool_unavailable' }
  }
  return resources.prepareResourceTool(candidate, signal, {
    toolKind: profile.toolKind,
    forbiddenEnchantments: profile.forbiddenToolEnchantments
  })
}

function expectedDropOptions(
  profile: ResourceProfile,
  candidate: ResourceCandidate
): ResourceHarvestOptions | undefined {
  if (
    profile.collectedItemNames.length === 1 &&
    profile.collectedItemNames[0] === candidate.blockName
  ) {
    return undefined
  }
  return {
    expectedItemNames: [...profile.collectedItemNames]
  }
}

function mergeHarvestOptions(
  base: ResourceHarvestOptions | undefined,
  extra: ResourceHarvestOptions
): ResourceHarvestOptions {
  return {
    ...(base ?? {}),
    ...extra,
    ...(base?.expectedItemNames
      ? { expectedItemNames: [...base.expectedItemNames] }
      : {})
  }
}

function inventoryCountForProfile(
  resources: ResourceGatheringAdapter,
  profile: ResourceProfile
): number {
  return profile.collectedItemNames.reduce(
    (sum, itemName) => sum + resources.inventoryCount(itemName),
    0
  )
}

async function findExpectedDroppedResource(
  resources: ResourceGatheringAdapter,
  profile: ResourceProfile,
  origin: Position,
  radius: number,
  signal: AbortSignal
) {
  if (!resources.findDroppedResource) return null
  const matches = []
  for (const itemName of profile.collectedItemNames) {
    const drop = await resources.findDroppedResource(
      itemName,
      origin,
      radius,
      signal
    )
    if (drop) matches.push(drop)
  }
  matches.sort((left, right) => {
    const distanceDelta =
      squaredDistance(left.position, origin) -
      squaredDistance(right.position, origin)
    return distanceDelta !== 0
      ? distanceDelta
      : left.entityId - right.entityId
  })
  return matches[0] ?? null
}

function positiveIntegerConstraint(
  capability: ServerCapability,
  key: string
): number | null {
  const value = capability.constraints[key]
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null
}


function exactBlockConstraint(
  capability: ServerCapability
): string | null {
  const value = capability.constraints.exact_block
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (!normalized) return null
  const separator = normalized.indexOf(':')
  if (separator < 0) return normalized
  return normalized.slice(0, separator) === 'minecraft'
    ? normalized.slice(separator + 1)
    : normalized
}

function toolKindConstraint(
  capability: ServerCapability
): 'axe' | 'pickaxe' | null {
  const value = capability.constraints.tool_kind
  return value === 'axe' || value === 'pickaxe'
    ? value
    : null
}

function booleanConstraint(
  capability: ServerCapability,
  key: string
): boolean | null {
  const value = capability.constraints[key]
  return typeof value === 'boolean' ? value : null
}

function selectCandidate(
  candidates: readonly ResourceCandidate[],
  allowedBlockNames: readonly string[],
  origin: Position,
  protection: ResourceProtectionPolicy,
  attempted: ReadonlySet<string>
): ResourceCandidate | null {
  const eligible = candidates
    .filter(candidate => allowedBlockNames.includes(candidate.blockName))
    .filter(candidate => !protection.isProtected(candidate.position))
    .filter(candidate => !attempted.has(candidateKey(candidate)))
    .map(candidate => ({
      blockName: candidate.blockName,
      position: { ...candidate.position },
      ...(candidate.approachPosition
        ? { approachPosition: { ...candidate.approachPosition } }
        : {}),
      ...(candidate.pickupPosition
        ? { pickupPosition: { ...candidate.pickupPosition } }
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
    maxCandidatesPerSearch: options.maxCandidatesPerSearch ?? 32,
    maxUncollectedHarvests: options.maxUncollectedHarvests ?? 12,
    cooperativePickupNoticeThreshold: options.cooperativePickupNoticeThreshold ?? 3,
    leafCleanupPolicyOverride: options.leafCleanupPolicyOverride ?? null
  }
  validatePositiveInteger(normalized.initialSearchRadius, 'initialSearchRadius')
  validatePositiveInteger(normalized.maxSearchRadius, 'maxSearchRadius')
  validatePositiveInteger(normalized.searchStep, 'searchStep')
  validatePositiveInteger(normalized.maxRetries, 'maxRetries')
  validatePositiveInteger(normalized.maxCandidatesPerSearch, 'maxCandidatesPerSearch')
  validatePositiveInteger(normalized.maxUncollectedHarvests, 'maxUncollectedHarvests')
  validatePositiveInteger(normalized.cooperativePickupNoticeThreshold, 'cooperativePickupNoticeThreshold')
  if (normalized.initialSearchRadius > normalized.maxSearchRadius) {
    throw new RangeError('initialSearchRadius must be <= maxSearchRadius')
  }
  return normalized
}


function safelyNotifyCapability(
  notify: ((notice: ServerCapabilityUsageNotice) => void) | undefined,
  notice: ServerCapabilityUsageNotice
): void {
  if (!notify) return
  try {
    notify(notice)
  } catch {
    // Capability telemetry is advisory only and must never stop gameplay.
  }
}

function safelyNotify(
  notify: ((notice: CooperativePickupNotice) => void) | undefined,
  notice: CooperativePickupNotice
): void {
  if (!notify) return
  try {
    notify(notice)
  } catch {
    // Cooperative notices are telemetry/advisory only and must never stop gameplay.
  }
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`)
  }
}

function preserveTargetAfterCancellation(
  signal: AbortSignal
): boolean {
  return signal.aborted &&
    typeof signal.reason === 'string' &&
    signal.reason.trim() === 'threat_suspended'
}

function cancelled(signal: AbortSignal): SkillResult {
  const reason = typeof signal.reason === 'string' ? signal.reason.trim() : ''
  return {
    status: 'cancelled',
    code: reason ? reason.replace(/\s+/g, '_').slice(0, 128) : 'cancelled'
  }
}