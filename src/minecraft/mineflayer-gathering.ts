import type { Bot } from 'mineflayer'
import type { Position } from '../contracts/events.js'
import type { SkillResult } from '../contracts/skills.js'
import {
  isResourceMutationPermit,
  type ResourceMutationPermit
} from '../safety/policy.js'
import type {
  DroppedResource,
  DroppedResourceStatus,
  ExplorationSearchRequest,
  PlayerResourceCollection,
  ResourceCandidate,
  ResourceGatheringAdapter,
  ResourceHarvestOptions,
  ResourceSearchRequest,
  ResourceToolPreparationOptions
} from './gathering.js'

export type GatheringBotProvider = () => Bot | null

interface MineflayerGatheringOptions {
  readonly maxSearchRadius?: number
  readonly maxCandidatesPerSearch?: number
  readonly collectionTimeoutMs?: number
  readonly collectionPollMs?: number
  readonly sleep?: (ms: number) => Promise<void>
}

interface NormalizedOptions {
  maxSearchRadius: number
  maxCandidatesPerSearch: number
  collectionTimeoutMs: number
  collectionPollMs: number
  sleep: (ms: number) => Promise<void>
}

type DropCollectionRecord =
  | { readonly kind: 'collected_by_player'; readonly player: string; readonly count: number }
  | { readonly kind: 'collected_by_bot'; readonly count: number }

const RESOURCE_NAME_PATTERN = /^[a-z0-9_.:-]+$/
const MAX_HARVEST_REACH = 4.5
const MAX_DROP_SEARCH_RADIUS = 8
const MAX_DROP_COLLECTION_RECORDS = 128
const HARVEST_VERTICAL_OFFSETS = [0, -1, -2, -3] as const
const HARVEST_HORIZONTAL_OFFSETS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1]
] as const
const UNSAFE_PASSABLE_BLOCKS = new Set(['water', 'lava', 'powder_snow'])
const TOOL_MATERIAL_PREFERENCE = [
  'netherite',
  'diamond',
  'iron',
  'stone',
  'golden',
  'wooden'
] as const

export class MineflayerGatheringRuntime implements ResourceGatheringAdapter {
  private readonly options: NormalizedOptions
  private trackedBot: Bot | null = null
  private playerCollectListener: ((collector: any, collected: any) => void) | null = null
  private readonly dropCollections = new Map<number, DropCollectionRecord>()
  private readonly playerResourceCollections: PlayerResourceCollection[] = []
  private collectionSequence = 0

  constructor(
    private readonly getBot: GatheringBotProvider,
    options: MineflayerGatheringOptions = {}
  ) {
    this.options = {
      maxSearchRadius: options.maxSearchRadius ?? 96,
      maxCandidatesPerSearch: options.maxCandidatesPerSearch ?? 128,
      collectionTimeoutMs: options.collectionTimeoutMs ?? 2500,
      collectionPollMs: options.collectionPollMs ?? 50,
      sleep: options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    }
    validatePositiveInteger(this.options.maxSearchRadius, 'maxSearchRadius')
    validatePositiveInteger(this.options.maxCandidatesPerSearch, 'maxCandidatesPerSearch')
    validateNonNegativeFinite(this.options.collectionTimeoutMs, 'collectionTimeoutMs')
    validatePositiveFinite(this.options.collectionPollMs, 'collectionPollMs')
  }

  currentPosition() {
    const bot = this.readyBot()
    if (!bot) return null
    const { x, y, z } = bot.entity.position
    return { x, y, z }
  }

  inventoryCount(itemName: string): number {
    const bot = this.readyBot()
    if (!bot) return 0
    return bot.inventory
      .items()
      .filter(item => item.name === itemName)
      .reduce((sum, item) => sum + item.count, 0)
  }

  resourceCollectionCursor(): number {
    this.readyBot()
    return this.collectionSequence
  }

  findPlayerResourceCollectionAfter(
    cursor: number,
    itemName: string,
    origin: Position,
    radius: number
  ): PlayerResourceCollection | null {
    if (
      !Number.isInteger(cursor) ||
      cursor < 0 ||
      !isResourceName(itemName) ||
      !isFinitePosition(origin) ||
      !Number.isFinite(radius) ||
      radius <= 0 ||
      radius > MAX_DROP_SEARCH_RADIUS
    ) {
      return null
    }
    if (!this.readyBot()) return null

    const match = this.playerResourceCollections.find(collection =>
      collection.sequence > cursor &&
      collection.itemName === itemName &&
      squaredDistance(collection.position, origin) <= radius * radius
    )
    return match ? clonePlayerCollection(match) : null
  }

  async findResourceBlocks(
    request: ResourceSearchRequest,
    signal: AbortSignal
  ): Promise<readonly ResourceCandidate[]> {
    if (signal.aborted) return []
    const bot = this.readyBot()
    if (!bot) return []

    const blockNames = normalizeBlockNames(request.blockNames)
    const visibility = request.visibility ?? 'visible'
    if (
      blockNames === null ||
      (visibility !== 'visible' && visibility !== 'loaded') ||
      !isFinitePosition(request.origin) ||
      !Number.isFinite(request.radius) ||
      request.radius < 1 ||
      request.radius > this.options.maxSearchRadius ||
      !Number.isInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > this.options.maxCandidatesPerSearch
    ) {
      return []
    }

    const point = bot.entity.position.clone()
    point.set(request.origin.x, request.origin.y, request.origin.z)
    let positions: ReturnType<Bot['findBlocks']>
    try {
      positions = bot.findBlocks({
        point,
        matching: block => blockNames.includes(block.name),
        maxDistance: request.radius,
        count: request.limit
      })
    } catch {
      return []
    }

    if (signal.aborted) return []
    const candidates: ResourceCandidate[] = []
    for (const position of positions.slice(0, request.limit)) {
      if (signal.aborted) return []
      const block = bot.blockAt(position)
      if (!block || !blockNames.includes(block.name)) continue
      if (visibility === 'visible' && !bot.canSeeBlock(block)) continue

      const targetPosition = {
        x: block.position.x,
        y: block.position.y,
        z: block.position.z
      }

      if (!hasGeometry(block)) {
        candidates.push({
          blockName: block.name,
          position: targetPosition
        })
        continue
      }

      const approachPosition = findSafeHarvestApproach(bot, targetPosition)
      if (!approachPosition) continue
      const pickupPosition = findSafePostHarvestPickupPosition(bot, targetPosition)
      candidates.push({
        blockName: block.name,
        position: targetPosition,
        approachPosition,
        ...(pickupPosition ? { pickupPosition } : {})
      })
    }
    return candidates
  }

  async findExplorationWaypoints(
    request: ExplorationSearchRequest,
    signal: AbortSignal
  ): Promise<readonly Position[]> {
    if (signal.aborted) return []
    const bot = this.readyBot()
    if (!bot) return []

    if (
      !isFinitePosition(request.origin) ||
      !Number.isFinite(request.radius) ||
      request.radius < 4 ||
      request.radius > this.options.maxSearchRadius ||
      !Number.isInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > this.options.maxCandidatesPerSearch
    ) {
      return []
    }

    const point = bot.entity.position.clone()
    point.set(
      request.origin.x,
      request.origin.y,
      request.origin.z
    )

    let positions: ReturnType<Bot['findBlocks']>
    try {
      positions = bot.findBlocks({
        point,
        matching: block => isPassableSpace(block),
        maxDistance: request.radius,
        count: Math.min(
          this.options.maxCandidatesPerSearch,
          request.limit * 8
        )
      })
    } catch {
      return []
    }

    const unique = new Map<string, Position>()
    for (const position of positions) {
      if (signal.aborted) return []
      const target = {
        x: position.x,
        y: position.y,
        z: position.z
      }
      if (
        Math.sqrt(squaredDistance(target, request.origin)) < 3
      ) {
        continue
      }

      const feet = blockAtPosition(bot, target)
      const head = blockAtPosition(bot, {
        x: target.x,
        y: target.y + 1,
        z: target.z
      })
      const support = blockAtPosition(bot, {
        x: target.x,
        y: target.y - 1,
        z: target.z
      })

      if (!feet || !head || !support) continue
      if (!isPassableSpace(feet) || !isPassableSpace(head)) continue
      if (!isSafeSupport(support)) continue
      if (!hasClearStandingSpaceLineOfSight(bot, target)) continue

      unique.set(
        `${target.x},${target.y},${target.z}`,
        target
      )
    }

    return [...unique.values()]
      .sort((left, right) => {
        const distanceDelta =
          squaredDistance(right, request.origin) -
          squaredDistance(left, request.origin)
        if (distanceDelta !== 0) return distanceDelta
        return positionKey(left).localeCompare(positionKey(right))
      })
      .slice(0, request.limit)
  }

  async findDecayingLeafBlocks(
    leafNames: readonly string[],
    origin: Position,
    radius: number,
    limit: number,
    signal: AbortSignal
  ): Promise<readonly ResourceCandidate[]> {
    if (signal.aborted) return []
    const bot = this.readyBot()
    if (!bot) return []

    const names = normalizeBlockNames(leafNames)
    if (
      names === null ||
      !isFinitePosition(origin) ||
      !Number.isFinite(radius) ||
      radius < 1 ||
      radius > MAX_DROP_SEARCH_RADIUS ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > this.options.maxCandidatesPerSearch
    ) {
      return []
    }

    const point = bot.entity.position.clone()
    point.set(origin.x, origin.y, origin.z)

    let positions: ReturnType<Bot['findBlocks']>
    try {
      positions = bot.findBlocks({
        point,
        matching: block => names.includes(block.name),
        maxDistance: radius,
        count: this.options.maxCandidatesPerSearch
      })
    } catch {
      return []
    }

    const candidates: ResourceCandidate[] = []
    for (const position of positions) {
      if (signal.aborted || candidates.length >= limit) return candidates
      const block = bot.blockAt(position)
      if (!block || !names.includes(block.name)) continue

      const properties = blockProperties(block)
      const persistent = properties.persistent
      const distance = Number(properties.distance)
      const isPersistent =
        persistent === true || String(persistent).toLowerCase() === 'true'

      if (isPersistent || !Number.isFinite(distance) || distance < 7) continue

      const targetPosition = {
        x: block.position.x,
        y: block.position.y,
        z: block.position.z
      }
      const approachPosition = hasGeometry(block)
        ? findSafeHarvestApproach(bot, targetPosition)
        : targetPosition

      if (!approachPosition) continue

      candidates.push({
        blockName: block.name,
        position: targetPosition,
        approachPosition
      })
    }

    return candidates
  }

  async findDroppedResource(
    itemName: string,
    origin: Position,
    radius: number,
    signal: AbortSignal
  ): Promise<DroppedResource | null> {
    if (signal.aborted) return null
    if (
      !isResourceName(itemName) ||
      !isFinitePosition(origin) ||
      !Number.isFinite(radius) ||
      radius <= 0 ||
      radius > MAX_DROP_SEARCH_RADIUS
    ) {
      return null
    }

    const bot = this.readyBot()
    if (!bot) return null

    const candidates: DroppedResource[] = []
    for (const entity of Object.values(bot.entities)) {
      if (signal.aborted) return null
      const drop = droppedResourceFromEntity(entity)
      if (!drop || drop.itemName !== itemName) continue
      if (squaredDistance(drop.position, origin) > radius * radius) continue
      candidates.push(drop)
    }

    candidates.sort((a, b) => {
      const distanceDelta = squaredDistance(a.position, origin) - squaredDistance(b.position, origin)
      return distanceDelta !== 0 ? distanceDelta : a.entityId - b.entityId
    })
    return candidates[0] ?? null
  }

  droppedResourceStatus(entityId: number): DroppedResourceStatus {
    const collected = this.dropCollections.get(entityId)
    if (collected) return { ...collected }

    const bot = this.readyBot()
    if (!bot) return { kind: 'gone' }
    const entity = bot.entities[entityId]
    const drop = entity ? droppedResourceFromEntity(entity) : null
    return drop ? { kind: 'present', drop } : { kind: 'gone' }
  }

  async prepareResourceTool(
    target: ResourceCandidate,
    signal: AbortSignal,
    options: ResourceToolPreparationOptions = {}
  ): Promise<SkillResult> {
    if (signal.aborted) return cancelled(signal)
    if (!isResourceName(target.blockName) || !isFinitePosition(target.position)) {
      return { status: 'failed', code: 'invalid_resource_target' }
    }

    const bot = this.readyBot()
    if (!bot) return { status: 'failed', code: 'minecraft_not_ready' }

    const point = bot.entity.position.clone()
    point.set(target.position.x, target.position.y, target.position.z)
    const block = bot.blockAt(point)
    if (!block) return { status: 'failed', code: 'resource_missing' }
    if (block.name !== target.blockName) {
      return { status: 'failed', code: 'resource_changed' }
    }

    const harvestTools = (
      block as unknown as { harvestTools?: Readonly<Record<string, boolean>> }
    ).harvestTools
    const acceptedTypes = new Set(
      Object.keys(harvestTools ?? {})
        .map(value => Number(value))
        .filter(value => Number.isInteger(value) && value >= 0)
    )

    const forbiddenEnchantments = normalizeEnchantments(
      options.forbiddenEnchantments ?? []
    )
    const inventory = bot.inventory.items()
      .filter(item => !hasForbiddenEnchantment(item, forbiddenEnchantments))

    const accepted = acceptedTypes.size > 0
      ? inventory.filter(item => acceptedTypes.has(item.type))
      : inventory

    const tool = selectSemanticTool(accepted, options.toolKind)
      ?? (acceptedTypes.size > 0 ? accepted[0] : undefined)

    if (!tool) {
      return options.toolKind || acceptedTypes.size > 0
        ? { status: 'failed', code: 'correct_tool_unavailable' }
        : { status: 'succeeded', code: 'tool_not_required' }
    }

    try {
      await bot.equip(tool, 'hand')
      if (signal.aborted) return cancelled(signal)
      return { status: 'succeeded', code: 'correct_tool_equipped' }
    } catch {
      if (signal.aborted) return cancelled(signal)
      return { status: 'failed', code: 'tool_equip_failed' }
    }
  }

  async harvestResourceBlock(
    target: ResourceCandidate,
    permit: ResourceMutationPermit,
    signal: AbortSignal,
    options: ResourceHarvestOptions = {}
  ): Promise<SkillResult> {
    if (signal.aborted) return cancelled(signal)
    if (
      !isResourceMutationPermit(permit) ||
      !permit.allowedBlockNames.includes(target.blockName)
    ) {
      return { status: 'failed', code: 'mutation_not_permitted' }
    }
    if (!isResourceName(target.blockName) || !isFinitePosition(target.position)) {
      return { status: 'failed', code: 'invalid_resource_target' }
    }

    const bot = this.readyBot()
    if (!bot) return { status: 'failed', code: 'minecraft_not_ready' }

    const point = bot.entity.position.clone()
    point.set(target.position.x, target.position.y, target.position.z)
    const block = bot.blockAt(point)
    if (!block) return { status: 'failed', code: 'resource_missing' }
    if (block.name !== target.blockName) {
      return { status: 'failed', code: 'resource_changed' }
    }
    if (!permit.allowedBlockNames.includes(block.name)) {
      return { status: 'failed', code: 'mutation_not_permitted' }
    }
    if (!bot.canDigBlock(block)) {
      return { status: 'failed', code: 'resource_not_diggable' }
    }

    const expectedItemNames = normalizeExpectedItemNames(
      options.expectedItemNames ?? [target.blockName]
    )
    if (expectedItemNames === null) {
      return { status: 'failed', code: 'invalid_harvest_options' }
    }
    const before = this.inventoryCountMany(expectedItemNames)
    let disconnected = false
    let sneaking = false
    const onAbort = () => {
      try {
        bot.stopDigging()
      } catch {}
    }
    const onEnd = () => {
      disconnected = true
      try {
        bot.stopDigging()
      } catch {}
    }

    signal.addEventListener('abort', onAbort, { once: true })
    bot.once('end', onEnd)

    try {
      if (options.sneak === true) {
        bot.setControlState('sneak', true)
        sneaking = true
      }
      await bot.dig(block)
      if (signal.aborted) return cancelled(signal)
      if (disconnected) return { status: 'failed', code: 'disconnected' }
      if (options.requireCollection === false) {
        return { status: 'succeeded', code: 'removed' }
      }

      const collected = await this.waitForInventoryIncrease(
        expectedItemNames,
        before,
        signal,
        () => disconnected
      )
      if (signal.aborted) return cancelled(signal)
      if (disconnected) return { status: 'failed', code: 'disconnected' }
      if (!collected) return { status: 'failed', code: 'item_not_collected' }
      return { status: 'succeeded', code: 'collected' }
    } catch (error) {
      if (signal.aborted) return cancelled(signal)
      if (disconnected) return { status: 'failed', code: 'disconnected' }
      return { status: 'failed', code: digFailureCode(error) }
    } finally {
      if (sneaking) {
        try {
          bot.setControlState('sneak', false)
        } catch {}
      }
      signal.removeEventListener('abort', onAbort)
      bot.off('end', onEnd)
    }
  }

  private readyBot(): Bot | null {
    const bot = this.getBot()
    if (!bot?.entity?.position || !bot.inventory) return null
    this.ensureDropTracking(bot)
    return bot
  }

  private ensureDropTracking(bot: Bot): void {
    if (this.trackedBot === bot) return

    if (this.trackedBot && this.playerCollectListener) {
      this.trackedBot.off('playerCollect', this.playerCollectListener)
    }
    this.trackedBot = bot
    this.dropCollections.clear()
    this.playerResourceCollections.length = 0
    this.collectionSequence = 0

    const listener = (collector: any, collected: any) => {
      const entityId = Number(collected?.id)
      if (!Number.isInteger(entityId) || entityId < 0) return
      const drop = droppedResourceFromEntity(collected)
      const count = drop?.count ?? 1

      const collectorId = Number(collector?.id)
      const selfId = Number((bot.entity as { id?: number }).id)
      const collectorName = typeof collector?.username === 'string'
        ? collector.username.trim().slice(0, 64)
        : ''
      const isSelf =
        (Number.isInteger(selfId) && collectorId === selfId) ||
        (collectorName.length > 0 && collectorName === bot.username)

      if (isSelf) {
        this.rememberDropCollection(entityId, { kind: 'collected_by_bot', count })
      } else if (collectorName.length > 0) {
        this.rememberDropCollection(entityId, {
          kind: 'collected_by_player',
          player: collectorName,
          count
        })
        if (drop) {
          this.collectionSequence += 1
          this.playerResourceCollections.push({
            ...drop,
            sequence: this.collectionSequence,
            player: collectorName
          })
          while (this.playerResourceCollections.length > MAX_DROP_COLLECTION_RECORDS) {
            this.playerResourceCollections.shift()
          }
        }
      }
    }

    this.playerCollectListener = listener
    bot.on('playerCollect', listener)
  }

  private rememberDropCollection(entityId: number, record: DropCollectionRecord): void {
    this.dropCollections.set(entityId, record)
    while (this.dropCollections.size > MAX_DROP_COLLECTION_RECORDS) {
      const oldest = this.dropCollections.keys().next().value
      if (oldest === undefined) break
      this.dropCollections.delete(oldest)
    }
  }

  private inventoryCountMany(itemNames: readonly string[]): number {
    return itemNames.reduce(
      (sum, itemName) => sum + this.inventoryCount(itemName),
      0
    )
  }

  private async waitForInventoryIncrease(
    itemNames: readonly string[],
    before: number,
    signal: AbortSignal,
    disconnected: () => boolean
  ): Promise<boolean> {
    if (this.inventoryCountMany(itemNames) > before) return true
    const deadline = Date.now() + this.options.collectionTimeoutMs
    while (Date.now() < deadline) {
      if (signal.aborted || disconnected()) return false
      await this.options.sleep(this.options.collectionPollMs)
      if (this.inventoryCountMany(itemNames) > before) return true
    }
    return this.inventoryCountMany(itemNames) > before
  }
}



function normalizeExpectedItemNames(
  values: readonly string[]
): string[] | null {
  if (values.length < 1 || values.length > 32) return null
  const normalized = [...new Set(values.map(value => value.trim()))]
  return normalized.every(isResourceName) ? normalized : null
}

function normalizeEnchantments(values: readonly string[]): Set<string> {
  return new Set(
    values
      .map(value => value.trim().toLowerCase())
      .filter(Boolean)
      .map(value => value.includes(':') ? value.slice(value.indexOf(':') + 1) : value)
  )
}

function hasForbiddenEnchantment(
  item: { readonly enchants?: readonly { readonly name?: string }[] },
  forbidden: ReadonlySet<string>
): boolean {
  if (forbidden.size === 0) return false
  return (item.enchants ?? []).some(enchantment => {
    const raw = enchantment.name?.trim().toLowerCase() ?? ''
    const name = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw
    return forbidden.has(name)
  })
}

function blockProperties(block: unknown): Record<string, unknown> {
  const candidate = block as { getProperties?: () => unknown }
  if (typeof candidate.getProperties !== 'function') return {}
  try {
    const properties = candidate.getProperties()
    return properties && typeof properties === 'object'
      ? properties as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function selectSemanticTool<T extends { readonly name: string }>(
  items: readonly T[],
  toolKind: 'axe' | 'pickaxe' | undefined
): T | undefined {
  if (!toolKind) return undefined
  for (const material of TOOL_MATERIAL_PREFERENCE) {
    const exactName = `${material}_${toolKind}`
    const match = items.find(item => item.name === exactName)
    if (match) return match
  }
  return items.find(item => item.name.endsWith(`_${toolKind}`))
}

function droppedResourceFromEntity(entity: any): DroppedResource | null {
  if (!entity || typeof entity.getDroppedItem !== 'function') return null
  const item = entity.getDroppedItem()
  if (!item || !isResourceName(item.name)) return null
  const count = Number(item.count)
  const entityId = Number(entity.id)
  const position = entity.position
  if (
    !Number.isInteger(entityId) ||
    entityId < 0 ||
    !Number.isInteger(count) ||
    count < 1 ||
    !position ||
    !isFinitePosition(position)
  ) {
    return null
  }
  return {
    entityId,
    itemName: item.name,
    count,
    position: {
      x: position.x,
      y: position.y,
      z: position.z
    }
  }
}

function clonePlayerCollection(collection: PlayerResourceCollection): PlayerResourceCollection {
  return {
    sequence: collection.sequence,
    entityId: collection.entityId,
    itemName: collection.itemName,
    count: collection.count,
    position: { ...collection.position },
    player: collection.player
  }
}

function findSafeHarvestApproach(bot: Bot, target: Position): Position | null {
  for (const yOffset of HARVEST_VERTICAL_OFFSETS) {
    for (const [xOffset, zOffset] of HARVEST_HORIZONTAL_OFFSETS) {
      const stance = {
        x: target.x + xOffset,
        y: target.y + yOffset,
        z: target.z + zOffset
      }
      if (!withinHarvestReach(stance, target)) continue

      const support = blockAtPosition(bot, {
        x: stance.x,
        y: stance.y - 1,
        z: stance.z
      })
      const feet = blockAtPosition(bot, stance)
      const head = blockAtPosition(bot, {
        x: stance.x,
        y: stance.y + 1,
        z: stance.z
      })
      if (!support || !feet || !head) continue
      if (!isSafeSupport(support)) continue
      if (!isPassableSpace(feet) || !isPassableSpace(head)) continue
      return stance
    }
  }
  return null
}

function findSafePostHarvestPickupPosition(bot: Bot, target: Position): Position | null {
  const support = blockAtPosition(bot, {
    x: target.x,
    y: target.y - 1,
    z: target.z
  })
  const head = blockAtPosition(bot, {
    x: target.x,
    y: target.y + 1,
    z: target.z
  })
  if (!support || !head) return null
  if (!isSafeSupport(support) || !isPassableSpace(head)) return null
  return { ...target }
}

function hasClearStandingSpaceLineOfSight(
  bot: Bot,
  target: Position
): boolean {
  const eye = bot.entity.position.offset(
    0,
    bot.entity.eyeHeight ?? 1.62,
    0
  )
  const targetPoint = bot.entity.position.clone()
  targetPoint.set(
    target.x + 0.5,
    target.y + 1,
    target.z + 0.5
  )

  const delta = targetPoint.minus(eye)
  const distance = eye.distanceTo(targetPoint)
  if (!Number.isFinite(distance) || distance <= 0) return false

  const hit = bot.world.raycast(
    eye,
    delta.normalize(),
    distance
  )
  return hit === null
}

function blockAtPosition(bot: Bot, position: Position): ReturnType<Bot['blockAt']> {
  const point = bot.entity.position.clone()
  point.set(position.x, position.y, position.z)
  return bot.blockAt(point)
}

function withinHarvestReach(stance: Position, target: Position): boolean {
  const eye = {
    x: stance.x + 0.5,
    y: stance.y + 1.62,
    z: stance.z + 0.5
  }
  const center = {
    x: target.x + 0.5,
    y: target.y + 0.5,
    z: target.z + 0.5
  }
  return Math.hypot(
    center.x - eye.x,
    center.y - eye.y,
    center.z - eye.z
  ) <= MAX_HARVEST_REACH
}

function positionKey(position: Position): string {
  return `${position.x},${position.y},${position.z}`
}

function squaredDistance(a: Position, b: Position): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return dx * dx + dy * dy + dz * dz
}

function hasGeometry(block: { boundingBox?: unknown }): boolean {
  return typeof block.boundingBox === 'string'
}

function isSafeSupport(block: { name: string; boundingBox?: unknown }): boolean {
  if (block.boundingBox !== 'block') return false
  return !isTreeCanopyBlock(block.name)
}

function isPassableSpace(block: { name: string; boundingBox?: unknown }): boolean {
  return block.boundingBox === 'empty' && !UNSAFE_PASSABLE_BLOCKS.has(block.name)
}

function isTreeCanopyBlock(name: string): boolean {
  return /(?:_leaves|_log|_stem|_hyphae)$/.test(name) || name === 'mangrove_roots'
}

function normalizeBlockNames(names: readonly string[]): string[] | null {
  if (names.length < 1 || names.length > 32) return null
  const normalized = [...new Set(names.map(name => name.trim()))]
  return normalized.every(isResourceName) ? normalized : null
}

function isResourceName(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && value !== '*' && RESOURCE_NAME_PATTERN.test(value)
}

function isFinitePosition(value: { x: number; y: number; z: number }): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`)
}

function validateNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a non-negative finite number`)
}

function validatePositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number`)
}

function digFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  if (message.includes('diggable') || message.includes('cannot dig')) return 'resource_not_diggable'
  if (message.includes('socket') || message.includes('disconnect') || message.includes('ended')) {
    return 'disconnected'
  }
  return 'dig_failed'
}

function cancelled(signal: AbortSignal): SkillResult {
  const reason = typeof signal.reason === 'string' ? signal.reason.trim() : ''
  return {
    status: 'cancelled',
    code: reason ? reason.replace(/\s+/g, '_').slice(0, 128) : 'cancelled'
  }
}
