import type { Bot } from 'mineflayer'
import type { SkillResult } from '../contracts/skills.js'
import type {
  CraftItemRequest,
  ProcessItemRequest,
  ProductionRuntime,
  ResolvedWorkstation
} from './production.js'
import { PRODUCTION_RUNTIME_PORT } from './production.js'
import type {
  MineflayerRuntimeExtension,
  MineflayerRuntimeExtensionContext
} from './runtime-extension.js'

export type ProductionBotProvider = () => Bot | null

export interface MineflayerProductionOptions {
  readonly pollIntervalMs?: number
  readonly maxProcessTimeoutMs?: number
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
}

interface NormalizedProductionOptions {
  readonly pollIntervalMs: number
  readonly maxProcessTimeoutMs: number
  readonly sleep: (ms: number) => Promise<void>
  readonly now: () => number
}

interface RegistryItemLike {
  readonly id: number
  readonly name: string
}

interface RecipeItemLike {
  readonly id: number | null
  readonly count?: number | null
}

interface RecipeLike {
  readonly result?: RecipeItemLike | null
  readonly ingredients?: readonly (RecipeItemLike | null)[] | null
  readonly inShape?: readonly (readonly (RecipeItemLike | null)[])[] | null
}

const DEFAULT_POLL_INTERVAL_MS = 100
const DEFAULT_MAX_PROCESS_TIMEOUT_MS = 30 * 60 * 1000
const MIN_PROCESS_TIMEOUT_MS = 5_000
const PROCESS_GRACE_MS = 15_000

export class MineflayerProductionRuntime implements ProductionRuntime {
  private readonly options: NormalizedProductionOptions

  constructor(
    private readonly getBot: ProductionBotProvider,
    options: MineflayerProductionOptions = {}
  ) {
    this.options = {
      pollIntervalMs:
        options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      maxProcessTimeoutMs:
        options.maxProcessTimeoutMs ?? DEFAULT_MAX_PROCESS_TIMEOUT_MS,
      sleep:
        options.sleep ??
        (ms => new Promise(resolve => setTimeout(resolve, ms))),
      now: options.now ?? Date.now
    }

    if (
      !Number.isFinite(this.options.pollIntervalMs) ||
      this.options.pollIntervalMs <= 0 ||
      !Number.isFinite(this.options.maxProcessTimeoutMs) ||
      this.options.maxProcessTimeoutMs <= 0
    ) {
      throw new Error('invalid Mineflayer production options')
    }
  }

  async craft(
    request: CraftItemRequest,
    signal: AbortSignal
  ): Promise<SkillResult> {
    if (signal.aborted) return cancelled(signal)

    const bot = this.getBot()
    if (!bot?.inventory || !bot.entity?.position) {
      return { status: 'failed', code: 'minecraft_not_ready' }
    }

    const outputItem = resolveRegistryItem(bot, request.item)
    if (!outputItem) {
      return { status: 'failed', code: 'unknown_output_item' }
    }

    const tableResolution = resolveCraftingTable(bot, request.workstation)
    if (tableResolution.kind === 'failure') {
      return tableResolution.result
    }

    const expectedOutput =
      request.outputCountPerBatch * request.batches
    if (
      !Number.isSafeInteger(expectedOutput) ||
      expectedOutput < 1
    ) {
      return { status: 'failed', code: 'invalid_craft_quantity' }
    }

    const candidates = bot.recipesFor(
      outputItem.id,
      null,
      expectedOutput,
      tableResolution.block
    )
    const recipe = candidates.find(candidate =>
      recipeMatchesRequest(
        bot,
        candidate as unknown as RecipeLike,
        request
      )
    )
    if (!recipe) {
      return {
        status: 'failed',
        code: 'selected_recipe_unavailable'
      }
    }

    const before = inventoryCount(bot, outputItem.name)
    let disconnected = false
    const onEnd = () => {
      disconnected = true
    }
    bot.once('end', onEnd)

    try {
      await bot.craft(
        recipe,
        request.batches,
        tableResolution.block ?? undefined
      )

      if (signal.aborted) return cancelled(signal)
      if (disconnected) {
        return { status: 'failed', code: 'disconnected' }
      }

      const produced =
        inventoryCount(bot, outputItem.name) - before
      if (produced < expectedOutput) {
        return {
          status: 'failed',
          code: 'craft_output_mismatch'
        }
      }

      return { status: 'succeeded', code: 'crafted' }
    } catch (error) {
      if (signal.aborted) return cancelled(signal)
      if (disconnected) {
        return { status: 'failed', code: 'disconnected' }
      }
      return {
        status: 'failed',
        code: productionFailureCode(error, 'craft_failed')
      }
    } finally {
      bot.off('end', onEnd)
    }
  }

  async process(
    request: ProcessItemRequest,
    signal: AbortSignal
  ): Promise<SkillResult> {
    if (signal.aborted) return cancelled(signal)

    if (request.kind === 'stonecutting') {
      return {
        status: 'failed',
        code: 'stonecutting_runtime_unavailable'
      }
    }

    if (!workstationSupportsKind(request.workstation, request.kind)) {
      return {
        status: 'failed',
        code: 'workstation_kind_mismatch'
      }
    }

    if (request.cookTimeTicks === null) {
      return {
        status: 'failed',
        code: 'processing_cook_time_missing'
      }
    }

    const bot = this.getBot()
    if (!bot?.inventory || !bot.entity?.position) {
      return { status: 'failed', code: 'minecraft_not_ready' }
    }

    const inputItem = resolveRegistryItem(bot, request.input)
    const outputItem = resolveRegistryItem(bot, request.output)
    const fuelItem =
      request.fuel === undefined
        ? null
        : resolveRegistryItem(bot, request.fuel)

    if (!inputItem) {
      return { status: 'failed', code: 'unknown_input_item' }
    }
    if (!outputItem) {
      return { status: 'failed', code: 'unknown_output_item' }
    }
    if (request.fuel !== undefined && !fuelItem) {
      return { status: 'failed', code: 'unknown_fuel_item' }
    }
    if (
      request.fuel === undefined ||
      request.fuelQuantity === undefined
    ) {
      return { status: 'failed', code: 'processing_fuel_missing' }
    }

    const inputQuantity =
      request.inputCountPerBatch * request.batches
    const expectedOutput =
      request.outputCountPerBatch * request.batches
    if (
      !Number.isSafeInteger(inputQuantity) ||
      inputQuantity < 1 ||
      !Number.isSafeInteger(expectedOutput) ||
      expectedOutput < 1
    ) {
      return {
        status: 'failed',
        code: 'invalid_processing_quantity'
      }
    }

    if (inventoryCount(bot, inputItem.name) < inputQuantity) {
      return { status: 'failed', code: 'insufficient_input' }
    }
    if (
      !fuelItem ||
      inventoryCount(bot, fuelItem.name) <
        request.fuelQuantity
    ) {
      return { status: 'failed', code: 'insufficient_fuel' }
    }

    const workstation = resolveWorkstationBlock(
      bot,
      request.workstation
    )
    if (workstation.kind === 'failure') {
      return workstation.result
    }

    let furnace:
      | Awaited<ReturnType<Bot['openFurnace']>>
      | null = null
    let closed = false
    let disconnected = false

    const close = async (): Promise<void> => {
      if (closed || furnace === null) return
      closed = true
      try {
        await furnace.close()
      } catch {}
    }
    const onAbort = () => {
      void close()
    }
    const onEnd = () => {
      disconnected = true
      void close()
    }

    signal.addEventListener('abort', onAbort, { once: true })
    bot.once('end', onEnd)

    try {
      furnace = await bot.openFurnace(workstation.block)
      if (signal.aborted) return cancelled(signal)
      if (disconnected) {
        return { status: 'failed', code: 'disconnected' }
      }

      if (
        furnaceSlotItem(furnace, 'input') !== null ||
        furnaceSlotItem(furnace, 'fuel') !== null ||
        furnaceSlotItem(furnace, 'output') !== null
      ) {
        return {
          status: 'failed',
          code: 'workstation_busy'
        }
      }

      await furnace.putInput(
        inputItem.id,
        null,
        inputQuantity
      )
      if (signal.aborted) return cancelled(signal)

      await furnace.putFuel(
        fuelItem.id,
        null,
        request.fuelQuantity
      )
      if (signal.aborted) return cancelled(signal)

      const timeoutMs = processingTimeoutMs(
        request.cookTimeTicks,
        request.batches,
        this.options.maxProcessTimeoutMs
      )
      const deadline = this.options.now() + timeoutMs
      let collected = 0

      while (collected < expectedOutput) {
        if (signal.aborted) return cancelled(signal)
        if (disconnected) {
          return { status: 'failed', code: 'disconnected' }
        }

        const current = furnaceSlotItem(furnace, 'output')
        if (current !== null) {
          if (current.name !== outputItem.name) {
            return {
              status: 'failed',
              code: 'processing_output_mismatch'
            }
          }

          const taken = await furnace.takeOutput()
          if (!taken || taken.name !== outputItem.name) {
            return {
              status: 'failed',
              code: 'processing_output_mismatch'
            }
          }
          collected += taken.count
          continue
        }

        if (this.options.now() >= deadline) {
          return {
            status: 'failed',
            code: 'processing_timeout'
          }
        }
        await this.options.sleep(this.options.pollIntervalMs)
      }

      if (collected !== expectedOutput) {
        return {
          status: 'failed',
          code: 'processing_output_mismatch'
        }
      }

      return { status: 'succeeded', code: 'processed' }
    } catch (error) {
      if (signal.aborted) return cancelled(signal)
      if (disconnected) {
        return { status: 'failed', code: 'disconnected' }
      }
      return {
        status: 'failed',
        code: productionFailureCode(
          error,
          'processing_failed'
        )
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      bot.off('end', onEnd)
      await close()
    }
  }
}

export function createMineflayerProductionExtension(
  options: MineflayerProductionOptions = {}
): MineflayerRuntimeExtension {
  return {
    id: 'production',
    install(context: MineflayerRuntimeExtensionContext) {
      context.ports.register(
        PRODUCTION_RUNTIME_PORT,
        new MineflayerProductionRuntime(
          context.readyBot,
          options
        )
      )
    }
  }
}

function resolveCraftingTable(
  bot: Bot,
  workstation: ResolvedWorkstation | null
):
  | { readonly kind: 'success'; readonly block: ReturnType<Bot['blockAt']> }
  | { readonly kind: 'failure'; readonly result: SkillResult } {
  if (workstation === null) {
    return { kind: 'success', block: null }
  }
  if (workstation.kind !== 'crafting_table') {
    return {
      kind: 'failure',
      result: {
        status: 'failed',
        code: 'workstation_kind_mismatch'
      }
    }
  }
  return resolveWorkstationBlock(bot, workstation)
}

function resolveWorkstationBlock(
  bot: Bot,
  workstation: ResolvedWorkstation
):
  | {
      readonly kind: 'success'
      readonly block: NonNullable<ReturnType<Bot['blockAt']>>
    }
  | { readonly kind: 'failure'; readonly result: SkillResult } {
  const point = bot.entity.position.clone()
  point.set(
    workstation.position.x,
    workstation.position.y,
    workstation.position.z
  )
  const block = bot.blockAt(point)
  if (!block) {
    return {
      kind: 'failure',
      result: {
        status: 'failed',
        code: 'workstation_block_missing'
      }
    }
  }

  if (
    !workstation.expectedBlockNames.some(expected =>
      blockNameMatches(expected, block.name)
    )
  ) {
    return {
      kind: 'failure',
      result: {
        status: 'failed',
        code: 'workstation_block_mismatch'
      }
    }
  }

  return { kind: 'success', block }
}

function workstationSupportsKind(
  workstation: ResolvedWorkstation,
  kind: ProcessItemRequest['kind']
): boolean {
  if (kind === 'smelting') {
    return workstation.kind === 'furnace'
  }
  if (kind === 'blasting') {
    return workstation.kind === 'blast_furnace'
  }
  if (kind === 'smoking') {
    return workstation.kind === 'smoker'
  }
  return workstation.kind === 'stonecutter'
}

function recipeMatchesRequest(
  bot: Bot,
  recipe: RecipeLike,
  request: CraftItemRequest
): boolean {
  const result = recipe.result
  const expectedOutput = resolveRegistryItem(bot, request.item)
  if (
    !result ||
    result.id === null ||
    !expectedOutput ||
    result.id !== expectedOutput.id ||
    (result.count ?? 1) !== request.outputCountPerBatch
  ) {
    return false
  }

  const actualInputs = recipeInputCounts(bot, recipe)
  if (actualInputs === null) return false

  const expectedInputs = new Map<string, number>()
  for (const input of request.inputs) {
    const item = resolveRegistryItem(bot, input.item)
    if (!item) return false
    expectedInputs.set(
      item.name,
      (expectedInputs.get(item.name) ?? 0) + input.count
    )
  }

  return mapsEqual(actualInputs, expectedInputs)
}

function recipeInputCounts(
  bot: Bot,
  recipe: RecipeLike
): Map<string, number> | null {
  const entries =
    recipe.ingredients && recipe.ingredients.length > 0
      ? recipe.ingredients
      : recipe.inShape?.flat() ?? []

  const counts = new Map<string, number>()
  for (const entry of entries) {
    if (!entry || entry.id === null || entry.id < 0) continue
    const item = registryItemById(bot, entry.id)
    if (!item) return null
    counts.set(
      item.name,
      (counts.get(item.name) ?? 0) + (entry.count ?? 1)
    )
  }
  return counts
}

function mapsEqual(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number>
): boolean {
  if (left.size !== right.size) return false
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false
  }
  return true
}

function resolveRegistryItem(
  bot: Bot,
  namespacedId: string
): RegistryItemLike | null {
  const normalized = namespacedId.trim().toLowerCase()
  const separator = normalized.indexOf(':')
  const path =
    separator >= 0
      ? normalized.slice(separator + 1)
      : normalized

  const registry = bot.registry as unknown as {
    readonly itemsByName?: Readonly<
      Record<string, RegistryItemLike | undefined>
    >
  }
  const byName = registry.itemsByName ?? {}
  return byName[normalized] ?? byName[path] ?? null
}

function registryItemById(
  bot: Bot,
  id: number
): RegistryItemLike | null {
  const registry = bot.registry as unknown as {
    readonly items?: Readonly<
      Record<number, RegistryItemLike | undefined>
    >
  }
  return registry.items?.[id] ?? null
}

function inventoryCount(
  bot: Bot,
  itemName: string
): number {
  return bot.inventory
    .items()
    .filter(item => item.name === itemName)
    .reduce((sum, item) => sum + item.count, 0)
}

function furnaceSlotItem(
  furnace: Awaited<ReturnType<Bot['openFurnace']>>,
  slot: 'input' | 'fuel' | 'output'
): { readonly name: string; readonly count: number } | null {
  const item =
    slot === 'input'
      ? furnace.inputItem()
      : slot === 'fuel'
        ? furnace.fuelItem()
        : furnace.outputItem()
  return item
    ? { name: item.name, count: item.count }
    : null
}

function processingTimeoutMs(
  cookTimeTicks: number,
  batches: number,
  maximum: number
): number {
  const estimated =
    cookTimeTicks * 50 * batches + PROCESS_GRACE_MS
  return Math.min(
    maximum,
    Math.max(MIN_PROCESS_TIMEOUT_MS, estimated)
  )
}

function blockNameMatches(
  expected: string,
  actual: string
): boolean {
  const normalized = expected.trim().toLowerCase()
  const separator = normalized.indexOf(':')
  const path =
    separator >= 0
      ? normalized.slice(separator + 1)
      : normalized
  return actual === normalized || actual === path
}

function productionFailureCode(
  error: unknown,
  fallback: string
): string {
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase()

  if (
    message.includes('disconnected') ||
    message.includes('socket') ||
    message.includes('ended')
  ) {
    return 'disconnected'
  }
  if (
    message.includes('ingredient') ||
    message.includes('material')
  ) {
    return 'insufficient_input'
  }
  return fallback
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
