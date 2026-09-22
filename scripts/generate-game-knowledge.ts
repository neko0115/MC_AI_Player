import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import minecraftData from 'minecraft-data'
import {
  parseGameKnowledgePack,
  type FuelFact,
  type GameKnowledgePack,
  type ItemFact,
  type ProcessingFact,
  type RecipeFact,
  type ToolFact,
  type WorkstationFact,
  type WorldAcquisitionFact
} from '../src/knowledge/contracts.js'

interface SourceItem {
  readonly id: number
  readonly name: string
  readonly stackSize: number
  readonly maxDurability?: number
}

type SourceRecipeItem =
  | number
  | readonly [number | null, number?]
  | {
      readonly id: number | null
      readonly count?: number
    }
  | null

interface SourceRecipe {
  readonly result: SourceRecipeItem
  readonly inShape?: readonly (readonly SourceRecipeItem[])[]
  readonly ingredients?: readonly SourceRecipeItem[]
}

interface SourceDrop {
  readonly drop: number | {
    readonly id: number
    readonly metadata?: number
  }
  readonly minCount?: number
  readonly maxCount?: number
}

interface SourceBlock {
  readonly id: number
  readonly name: string
  readonly drops: readonly (number | SourceDrop)[]
  readonly material?: string
  readonly harvestTools?: Readonly<Record<string, boolean>>
}

export interface ProductionMinecraftData {
  readonly itemsArray: readonly SourceItem[]
  readonly blocksArray: readonly SourceBlock[]
  readonly recipes: Readonly<Record<number, readonly SourceRecipe[]>>
}

export interface ProductionKnowledgeOverlay {
  readonly worldAcquisition?: readonly WorldAcquisitionFact[]
  readonly recipes?: readonly RecipeFact[]
  readonly processing?: readonly ProcessingFact[]
  readonly fuels?: readonly FuelFact[]
  readonly tools?: readonly ToolFact[]
  readonly workstations?: readonly WorkstationFact[]
}

export function generateProductionKnowledge(
  version: string,
  data: ProductionMinecraftData,
  overlay: ProductionKnowledgeOverlay = {}
): GameKnowledgePack {
  const items = normalizeItems(data.itemsArray)
  const itemNames = new Map(
    data.itemsArray.map(item => [item.id, item.name] as const)
  )

  const generated: GameKnowledgePack = {
    schemaVersion: 1,
    edition: 'java',
    minecraftVersion: version,
    items,
    worldAcquisition: mergeFacts(
      normalizeWorldAcquisition(data.blocksArray, itemNames),
      overlay.worldAcquisition ?? [],
      fact => fact.id,
      'world acquisition'
    ),
    recipes: mergeFacts(
      normalizeRecipes(data.recipes, itemNames),
      overlay.recipes ?? [],
      fact => fact.id,
      'recipe'
    ),
    processing: mergeFacts(
      [],
      overlay.processing ?? [],
      fact => fact.id,
      'processing'
    ),
    fuels: mergeFacts(
      [],
      overlay.fuels ?? [],
      fact => fact.item,
      'fuel'
    ),
    tools: mergeFacts(
      normalizeTools(data.itemsArray),
      overlay.tools ?? [],
      fact => fact.item,
      'tool'
    ),
    workstations: mergeFacts(
      defaultWorkstations(items),
      overlay.workstations ?? [],
      fact => fact.id,
      'workstation'
    )
  }

  return parseGameKnowledgePack(generated)
}

export function normalizeItems(
  source: readonly SourceItem[]
): ItemFact[] {
  return source
    .filter(item =>
      Number.isInteger(item.id) &&
      item.id >= 0 &&
      typeof item.name === 'string' &&
      item.name.length > 0 &&
      Number.isInteger(item.stackSize) &&
      item.stackSize > 0
    )
    .map(item => ({
      id: namespaced(item.name),
      stackSize: item.stackSize
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

export function normalizeRecipes(
  source: Readonly<Record<number, readonly SourceRecipe[]>>,
  itemNames: ReadonlyMap<number, string>
): RecipeFact[] {
  const candidates: Array<{
    readonly output: { readonly item: string; readonly count: number }
    readonly inputs: readonly { readonly item: string; readonly count: number }[]
    readonly workstation: string
    readonly fingerprint: string
  }> = []

  for (const recipes of Object.values(source)) {
    for (const recipe of recipes) {
      const output = resolveRecipeItem(recipe.result, itemNames)
      if (!output) continue

      const slots = recipe.inShape
        ? recipe.inShape.flat()
        : recipe.ingredients ?? []
      const inputs = aggregateIngredients(slots, itemNames)
      if (!inputs || inputs.length === 0) continue

      const workstation = recipeFitsInventoryGrid(recipe)
        ? 'minecraft:inventory_crafting'
        : 'minecraft:crafting_table'
      const fingerprint = [
        output.item,
        String(output.count),
        workstation,
        ...inputs.map(
          input => `${input.item}*${input.count}`
        )
      ].join('|')

      candidates.push({
        output,
        inputs,
        workstation,
        fingerprint
      })
    }
  }

  candidates.sort((left, right) =>
    left.fingerprint.localeCompare(right.fingerprint)
  )

  const deduped = new Map<string, typeof candidates[number]>()
  for (const candidate of candidates) {
    if (!deduped.has(candidate.fingerprint)) {
      deduped.set(candidate.fingerprint, candidate)
    }
  }

  const perOutput = new Map<string, number>()
  return [...deduped.values()].map(candidate => {
    const index = perOutput.get(candidate.output.item) ?? 0
    perOutput.set(candidate.output.item, index + 1)
    return {
      id:
        `minecraft:craft/${namespacePath(candidate.output.item)}/${index}`,
      output: candidate.output,
      inputs: candidate.inputs,
      workstation: candidate.workstation
    }
  })
}

export function normalizeWorldAcquisition(
  blocks: readonly SourceBlock[],
  itemNames: ReadonlyMap<number, string>
): WorldAcquisitionFact[] {
  const facts: WorldAcquisitionFact[] = []
  const itemIds = new Set(
    [...itemNames.values()].map(namespaced)
  )

  for (const block of blocks) {
    if (
      typeof block.name !== 'string' ||
      block.name.length === 0 ||
      block.drops.length !== 1
    ) {
      continue
    }

    const drop = deterministicDrop(block.drops[0]!, itemNames)
    if (!drop) continue

    const acceptedItems = Object.entries(
      block.harvestTools ?? {}
    )
      .filter(([, accepted]) => accepted)
      .map(([id]) => itemNames.get(Number(id)))
      .filter((name): name is string => Boolean(name))
      .map(namespaced)
      .sort()

    const toolClass = toolClassFromMaterial(block.material)
    const blockItem = namespaced(block.name)
    const forbiddenEnchantments =
      itemIds.has(blockItem) && drop.item !== blockItem
        ? ['silk_touch']
        : []

    facts.push({
      id:
        `minecraft:mine/${block.name}/${namespacePath(drop.item)}`,
      resource: namespaced(block.name),
      output: drop,
      blockIds: [namespaced(block.name)],
      minimumOnePerBlock: true,
      tool: {
        ...(acceptedItems.length > 0
          ? { acceptedItems }
          : {}),
        class: toolClass,
        minimumTier: null,
        minimumTierRank: null,
        requiredEnchantments: [],
        forbiddenEnchantments
      }
    })
  }

  return facts.sort((left, right) =>
    left.id.localeCompare(right.id)
  )
}

export function normalizeTools(
  items: readonly SourceItem[]
): ToolFact[] {
  const facts: ToolFact[] = []

  for (const item of items) {
    const toolClass = toolClassFromItemName(item.name)
    if (!toolClass) continue

    const tier =
      item.name.slice(
        0,
        -(toolClass.length + 1)
      ) || null

    facts.push({
      item: namespaced(item.name),
      class: toolClass,
      tier,
      tierRank: null,
      maxDurability:
        Number.isInteger(item.maxDurability) &&
        (item.maxDurability ?? 0) > 0
          ? item.maxDurability!
          : null
    })
  }

  return facts.sort((left, right) =>
    left.item.localeCompare(right.item)
  )
}

function defaultWorkstations(
  items: readonly ItemFact[]
): WorkstationFact[] {
  const itemIds = new Set(items.map(item => item.id))
  const facts: WorkstationFact[] = [{
    id: 'minecraft:inventory_crafting',
    item: null,
    blockIds: [],
    supportedKinds: ['crafting']
  }]

  if (itemIds.has('minecraft:crafting_table')) {
    facts.push({
      id: 'minecraft:crafting_table',
      item: 'minecraft:crafting_table',
      blockIds: ['minecraft:crafting_table'],
      supportedKinds: ['crafting']
    })
  }

  return facts
}

function deterministicDrop(
  value: number | SourceDrop,
  itemNames: ReadonlyMap<number, string>
): { readonly item: string; readonly count: number } | null {
  if (typeof value === 'number') {
    const name = itemNames.get(value)
    return name
      ? { item: namespaced(name), count: 1 }
      : null
  }

  const id =
    typeof value.drop === 'number'
      ? value.drop
      : value.drop.id
  const name = itemNames.get(id)
  const minimum = value.minCount ?? 1

  if (
    !name ||
    !Number.isInteger(minimum) ||
    minimum < 1
  ) {
    return null
  }

  return {
    item: namespaced(name),
    count: minimum
  }
}

function resolveRecipeItem(
  value: SourceRecipeItem,
  itemNames: ReadonlyMap<number, string>
): { readonly item: string; readonly count: number } | null {
  if (value === null) return null

  if (typeof value === 'number') {
    const name = itemNames.get(value)
    return name
      ? { item: namespaced(name), count: 1 }
      : null
  }

  if (Array.isArray(value)) {
    const id = value[0]
    if (id === null) return null
    const name = itemNames.get(id)
    return name
      ? { item: namespaced(name), count: 1 }
      : null
  }

  const objectValue = value as {
    readonly id: number | null
    readonly count?: number
  }
  if (objectValue.id === null) return null
  const name = itemNames.get(objectValue.id)
  const count = objectValue.count ?? 1
  if (
    !name ||
    !Number.isInteger(count) ||
    count < 1
  ) {
    return null
  }

  return { item: namespaced(name), count }
}

function aggregateIngredients(
  values: readonly SourceRecipeItem[],
  itemNames: ReadonlyMap<number, string>
): { readonly item: string; readonly count: number }[] | null {
  const counts = new Map<string, number>()

  for (const value of values) {
    if (value === null) continue
    const ingredient = resolveRecipeItem(value, itemNames)
    if (!ingredient) return null
    counts.set(
      ingredient.item,
      (counts.get(ingredient.item) ?? 0) + ingredient.count
    )
  }

  return [...counts.entries()]
    .map(([item, count]) => ({ item, count }))
    .sort((left, right) =>
      left.item.localeCompare(right.item)
    )
}

function recipeFitsInventoryGrid(
  recipe: SourceRecipe
): boolean {
  if (recipe.inShape) {
    return (
      recipe.inShape.length <= 2 &&
      recipe.inShape.every(row => row.length <= 2)
    )
  }
  return (recipe.ingredients?.length ?? 0) <= 4
}

function toolClassFromMaterial(
  material: string | undefined
): string | null {
  if (!material) return null
  const match = /(?:^|\/)mineable\/(pickaxe|axe|shovel|hoe)$/.exec(
    material
  )
  return match?.[1] ?? null
}

function toolClassFromItemName(
  name: string
): string | null {
  if (name === 'shears') return 'shears'
  const match = /_(pickaxe|axe|shovel|hoe|sword)$/.exec(name)
  return match?.[1] ?? null
}

function mergeFacts<T>(
  generated: readonly T[],
  overlay: readonly T[],
  key: (value: T) => string,
  kind: string
): T[] {
  const result = new Map<string, T>()

  for (const value of generated) {
    result.set(key(value), value)
  }
  for (const value of overlay) {
    const id = key(value)
    if (result.has(id)) {
      throw new Error(
        `knowledge_overlay_duplicate_${kind.replace(/\s+/g, '_')}:${id}`
      )
    }
    result.set(id, value)
  }

  return [...result.values()].sort((left, right) =>
    key(left).localeCompare(key(right))
  )
}

function namespaced(name: string): string {
  return name.includes(':') ? name : `minecraft:${name}`
}

function namespacePath(id: string): string {
  const separator = id.indexOf(':')
  return separator >= 0 ? id.slice(separator + 1) : id
}

function loadOverlay(
  root: string | undefined,
  version: string
): ProductionKnowledgeOverlay {
  if (!root) return {}
  const path = join(
    root,
    'java',
    version,
    'production.json'
  )
  if (!existsSync(path)) return {}
  return JSON.parse(
    readFileSync(path, 'utf8')
  ) as ProductionKnowledgeOverlay
}

function writePack(
  root: string,
  pack: GameKnowledgePack
): void {
  const directory = join(
    root,
    'java',
    pack.minecraftVersion
  )
  mkdirSync(directory, { recursive: true })

  const files: Readonly<Record<string, unknown>> = {
    'metadata.json': {
      schemaVersion: pack.schemaVersion,
      edition: pack.edition,
      minecraftVersion: pack.minecraftVersion
    },
    'items.json': pack.items,
    'world-acquisition.json': pack.worldAcquisition,
    'recipes.json': pack.recipes,
    'processing.json': pack.processing,
    'fuels.json': pack.fuels,
    'tools.json': pack.tools,
    'workstations.json': pack.workstations
  }

  for (const [filename, value] of Object.entries(files)) {
    writeFileSync(
      join(directory, filename),
      `${JSON.stringify(value, null, 2)}\n`,
      'utf8'
    )
  }
}

function parseCli(
  argv: readonly string[]
): {
  readonly version: string
  readonly output: string
  readonly overlay?: string
} {
  let version: string | undefined
  let output: string | undefined
  let overlay: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--version') {
      version = argv[++index]
    } else if (value === '--out') {
      output = argv[++index]
    } else if (value === '--overlay') {
      overlay = argv[++index]
    } else {
      throw new Error(`unknown_argument:${value}`)
    }
  }

  if (!version) throw new Error('missing_argument:--version')
  if (!output) throw new Error('missing_argument:--out')

  return {
    version,
    output,
    ...(overlay ? { overlay } : {})
  }
}

function main(): void {
  const cli = parseCli(process.argv.slice(2))
  const data = minecraftData(cli.version)
  if (!data || data.type !== 'pc') {
    throw new Error(
      `unsupported_minecraft_java_version:${cli.version}`
    )
  }

  const pack = generateProductionKnowledge(
    cli.version,
    data as unknown as ProductionMinecraftData,
    loadOverlay(cli.overlay, cli.version)
  )
  writePack(cli.output, pack)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main()
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : String(error)
    )
    process.exitCode = 1
  }
}
