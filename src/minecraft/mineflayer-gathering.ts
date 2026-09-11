import type { Bot } from 'mineflayer'
import type { Position } from '../contracts/events.js'
import type { SkillResult } from '../contracts/skills.js'
import {
  isResourceMutationPermit,
  type ResourceMutationPermit
} from '../safety/policy.js'
import type {
  ResourceCandidate,
  ResourceGatheringAdapter,
  ResourceSearchRequest
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

const RESOURCE_NAME_PATTERN = /^[a-z0-9_.:-]+$/
const MAX_HARVEST_REACH = 4.5
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

export class MineflayerGatheringRuntime implements ResourceGatheringAdapter {
  private readonly options: NormalizedOptions

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

  async findResourceBlocks(
    request: ResourceSearchRequest,
    signal: AbortSignal
  ): Promise<readonly ResourceCandidate[]> {
    if (signal.aborted) return []
    const bot = this.readyBot()
    if (!bot) return []

    const blockNames = normalizeBlockNames(request.blockNames)
    if (
      blockNames === null ||
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

  async harvestResourceBlock(
    target: ResourceCandidate,
    permit: ResourceMutationPermit,
    signal: AbortSignal
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

    const before = this.inventoryCount(target.blockName)
    let disconnected = false
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
      await bot.dig(block)
      if (signal.aborted) return cancelled(signal)
      if (disconnected) return { status: 'failed', code: 'disconnected' }

      const collected = await this.waitForInventoryIncrease(
        target.blockName,
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
      signal.removeEventListener('abort', onAbort)
      bot.off('end', onEnd)
    }
  }

  private readyBot(): Bot | null {
    const bot = this.getBot()
    return bot?.entity?.position && bot.inventory ? bot : null
  }

  private async waitForInventoryIncrease(
    itemName: string,
    before: number,
    signal: AbortSignal,
    disconnected: () => boolean
  ): Promise<boolean> {
    if (this.inventoryCount(itemName) > before) return true
    const deadline = Date.now() + this.options.collectionTimeoutMs
    while (Date.now() < deadline) {
      if (signal.aborted || disconnected()) return false
      await this.options.sleep(this.options.collectionPollMs)
      if (this.inventoryCount(itemName) > before) return true
    }
    return this.inventoryCount(itemName) > before
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
