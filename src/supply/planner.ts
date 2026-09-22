import {
  normalizeNamespacedId,
  resolveItemQuantity,
  type GameKnowledgePack,
  type ItemQuantityRequest,
  type ToolFact,
  type ToolRequirement,
  type WorldAcquisitionFact
} from '../knowledge/contracts.js'
import {
  productionRoutesFor,
  routeBatches,
  type ProductionRoute
} from '../knowledge/graph.js'

export interface AuthorizedStorageSource {
  readonly id: string
  readonly items: Readonly<Record<string, number>>
}

export interface OwnedToolState {
  readonly item: string
  readonly enchantments: readonly string[]
}

export interface SupplyPlanningState {
  readonly inventory: Readonly<Record<string, number>>
  readonly storages: readonly AuthorizedStorageSource[]
  readonly tools: readonly OwnedToolState[]
  readonly workstations: readonly string[]
}

export type SupplyStep =
  | {
      readonly kind: 'use_inventory'
      readonly item: string
      readonly quantity: number
    }
  | {
      readonly kind: 'withdraw_storage'
      readonly storageId: string
      readonly item: string
      readonly quantity: number
    }
  | {
      readonly kind: 'ensure_tool'
      readonly item: string
      readonly toolClass: string
    }
  | {
      readonly kind: 'gather'
      readonly routeId: string
      readonly resource: string
      readonly item: string
      readonly quantity: number
      readonly minimumBlocks: number
    }
  | {
      readonly kind: 'ensure_workstation'
      readonly workstation: string
      readonly item: string
    }
  | {
      readonly kind: 'craft'
      readonly recipeId: string
      readonly batches: number
    }
  | {
      readonly kind: 'process'
      readonly processingId: string
      readonly batches: number
      readonly fuelItem: string | null
      readonly fuelQuantity: number
    }

export interface UnresolvedSupply {
  readonly item: string
  readonly quantity: number
  readonly code: string
}

export interface SupplyPlan {
  readonly requestedItem: string
  readonly requestedQuantity: number
  readonly steps: readonly SupplyStep[]
  readonly unresolved: readonly UnresolvedSupply[]
}

interface MutableStorage {
  readonly id: string
  readonly items: Map<string, number>
}

interface MutablePlannerState {
  readonly inventory: Map<string, number>
  readonly storages: MutableStorage[]
  readonly tools: OwnedToolState[]
  readonly workstations: Set<string>
}

interface PlannerBudget {
  nodes: number
}

const MAX_PLAN_DEPTH = 32
const MAX_PLAN_NODES = 2048

export function planItemAcquisition(
  pack: GameKnowledgePack,
  item: string,
  request: ItemQuantityRequest,
  state: SupplyPlanningState
): SupplyPlan {
  const requestedItem = normalizeNamespacedId(item)
  const requestedQuantity = resolveItemQuantity(
    pack,
    requestedItem,
    request
  )

  const mutable = createMutableState(state)
  const steps: SupplyStep[] = []
  const unresolved: UnresolvedSupply[] = []
  const budget: PlannerBudget = { nodes: 0 }

  satisfyItem(
    pack,
    requestedItem,
    requestedQuantity,
    mutable,
    steps,
    unresolved,
    budget,
    new Set(),
    1
  )

  return {
    requestedItem,
    requestedQuantity,
    steps,
    unresolved
  }
}

function satisfyItem(
  pack: GameKnowledgePack,
  item: string,
  quantity: number,
  state: MutablePlannerState,
  steps: SupplyStep[],
  unresolved: UnresolvedSupply[],
  budget: PlannerBudget,
  path: ReadonlySet<string>,
  depth: number
): boolean {
  if (quantity <= 0) return true
  if (depth > MAX_PLAN_DEPTH) {
    unresolved.push({
      item,
      quantity,
      code: 'production_max_depth_exceeded'
    })
    return false
  }

  budget.nodes += 1
  if (budget.nodes > MAX_PLAN_NODES) {
    unresolved.push({
      item,
      quantity,
      code: 'production_max_nodes_exceeded'
    })
    return false
  }

  const normalizedItem = normalizeNamespacedId(item)
  if (path.has(normalizedItem)) {
    unresolved.push({
      item: normalizedItem,
      quantity,
      code: 'production_cycle_detected'
    })
    return false
  }

  const remaining = takeExistingStock(
    normalizedItem,
    quantity,
    state,
    steps
  )
  if (remaining === 0) return true

  const routes = rankRoutes(
    pack,
    normalizedItem,
    state
  )
  if (routes.length === 0) {
    unresolved.push({
      item: normalizedItem,
      quantity: remaining,
      code: 'production_route_missing'
    })
    return false
  }

  const nextPath = new Set(path)
  nextPath.add(normalizedItem)

  let firstFailure: readonly UnresolvedSupply[] | null = null

  for (const route of routes) {
    const candidateState = cloneMutableState(state)
    const candidateSteps: SupplyStep[] = []
    const candidateUnresolved: UnresolvedSupply[] = []

    if (satisfyProductionRoute(
      pack,
      route,
      normalizedItem,
      remaining,
      candidateState,
      candidateSteps,
      candidateUnresolved,
      budget,
      nextPath,
      depth
    )) {
      commitMutableState(state, candidateState)
      steps.push(...candidateSteps)
      return true
    }

    if (budget.nodes > MAX_PLAN_NODES) {
      unresolved.push({
        item: normalizedItem,
        quantity: remaining,
        code: 'production_max_nodes_exceeded'
      })
      return false
    }
    firstFailure ??= [...candidateUnresolved]
  }

  if (firstFailure && firstFailure.length > 0) {
    unresolved.push(...firstFailure)
  } else {
    unresolved.push({
      item: normalizedItem,
      quantity: remaining,
      code: 'production_route_unresolved'
    })
  }
  return false
}

function satisfyProductionRoute(
  pack: GameKnowledgePack,
  route: ProductionRoute,
  normalizedItem: string,
  remaining: number,
  state: MutablePlannerState,
  steps: SupplyStep[],
  unresolved: UnresolvedSupply[],
  budget: PlannerBudget,
  nextPath: ReadonlySet<string>,
  depth: number
): boolean {
  if (route.kind === 'world') {
    return satisfyWorldRoute(
      pack,
      route.fact,
      remaining,
      state,
      steps,
      unresolved,
      budget,
      nextPath,
      depth
    )
  }

  if (!ensureWorkstation(
    pack,
    route.fact.workstation,
    state,
    steps,
    unresolved,
    budget,
    nextPath,
    depth + 1
  )) {
    return false
  }

  const batches = routeBatches(route, remaining)

  if (route.kind === 'craft') {
    for (const input of route.fact.inputs) {
      if (!satisfyItem(
        pack,
        input.item,
        input.count * batches,
        state,
        steps,
        unresolved,
        budget,
        nextPath,
        depth + 1
      )) {
        return false
      }
    }

    steps.push({
      kind: 'craft',
      recipeId: route.fact.id,
      batches
    })
    rememberOverproduction(
      state,
      normalizedItem,
      route.fact.output.count * batches - remaining
    )
    return true
  }

  if (!satisfyItem(
    pack,
    route.fact.input.item,
    route.fact.input.count * batches,
    state,
    steps,
    unresolved,
    budget,
    nextPath,
    depth + 1
  )) {
    return false
  }

  const fuel = processingFuelRequirement(
    pack,
    route,
    batches,
    state
  )
  if (fuel === null && route.fact.kind !== 'stonecutting') {
    unresolved.push({
      item: normalizedItem,
      quantity: remaining,
      code: 'fuel_route_missing'
    })
    return false
  }

  if (
    fuel &&
    !satisfyItem(
      pack,
      fuel.item,
      fuel.quantity,
      state,
      steps,
      unresolved,
      budget,
      nextPath,
      depth + 1
    )
  ) {
    return false
  }

  steps.push({
    kind: 'process',
    processingId: route.fact.id,
    batches,
    fuelItem: fuel?.item ?? null,
    fuelQuantity: fuel?.quantity ?? 0
  })
  rememberOverproduction(
    state,
    normalizedItem,
    route.fact.output.count * batches - remaining
  )
  return true
}

function satisfyWorldRoute(
  pack: GameKnowledgePack,
  fact: WorldAcquisitionFact,
  quantity: number,
  state: MutablePlannerState,
  steps: SupplyStep[],
  unresolved: UnresolvedSupply[],
  budget: PlannerBudget,
  path: ReadonlySet<string>,
  depth: number
): boolean {
  if (!ensureTool(
    pack,
    fact.tool,
    state,
    steps,
    unresolved,
    budget,
    path,
    depth + 1
  )) {
    return false
  }

  const minimumBlocks = Math.ceil(quantity / fact.output.count)
  steps.push({
    kind: 'gather',
    routeId: fact.id,
    resource: fact.resource,
    item: fact.output.item,
    quantity,
    minimumBlocks
  })
  rememberOverproduction(
    state,
    fact.output.item,
    fact.output.count * minimumBlocks - quantity
  )
  return true
}

function ensureTool(
  pack: GameKnowledgePack,
  requirement: ToolRequirement,
  state: MutablePlannerState,
  steps: SupplyStep[],
  unresolved: UnresolvedSupply[],
  budget: PlannerBudget,
  path: ReadonlySet<string>,
  depth: number
): boolean {
  const acceptedItems = normalizedAcceptedItems(requirement)
  if (requirement.class === null && acceptedItems.size === 0) {
    return requirement.requiredEnchantments.length === 0
  }

  const existing = state.tools.find(tool =>
    toolMatchesRequirement(pack, tool, requirement)
  )
  if (existing) {
    return true
  }

  if (requirement.requiredEnchantments.length > 0) {
    unresolved.push({
      item: requirement.class ?? firstAcceptedItem(acceptedItems),
      quantity: 1,
      code: 'required_enchanted_tool_unavailable'
    })
    return false
  }

  const candidate = pack.tools
    .filter(tool =>
      (acceptedItems.size === 0 || acceptedItems.has(tool.item)) &&
      (requirement.class === null || tool.class === requirement.class) &&
      tierSatisfies(tool, requirement) &&
      productionRoutesFor(pack, tool.item).length > 0
    )
    .sort(compareToolFacts)[0]

  if (!candidate) {
    unresolved.push({
      item: requirement.class ?? firstAcceptedItem(acceptedItems),
      quantity: 1,
      code: 'tool_route_missing'
    })
    return false
  }

  if (!satisfyItem(
    pack,
    candidate.item,
    1,
    state,
    steps,
    unresolved,
    budget,
    path,
    depth
  )) {
    return false
  }

  state.tools.push({
    item: candidate.item,
    enchantments: []
  })
  steps.push({
    kind: 'ensure_tool',
    item: candidate.item,
    toolClass: candidate.class
  })
  return true
}

function ensureWorkstation(
  pack: GameKnowledgePack,
  workstation: string,
  state: MutablePlannerState,
  steps: SupplyStep[],
  unresolved: UnresolvedSupply[],
  budget: PlannerBudget,
  path: ReadonlySet<string>,
  depth: number
): boolean {
  const normalized = normalizeNamespacedId(workstation)
  if (state.workstations.has(normalized)) {
    return true
  }

  const fact = pack.workstations.find(
    candidate => candidate.id === normalized
  )
  if (!fact) {
    unresolved.push({
      item: normalized,
      quantity: 1,
      code: 'workstation_fact_missing'
    })
    return false
  }

  if (fact.item === null) {
    unresolved.push({
      item: normalized,
      quantity: 1,
      code: 'workstation_unavailable'
    })
    return false
  }

  if (!satisfyItem(
    pack,
    fact.item,
    1,
    state,
    steps,
    unresolved,
    budget,
    path,
    depth
  )) {
    return false
  }

  state.workstations.add(normalized)
  steps.push({
    kind: 'ensure_workstation',
    workstation: normalized,
    item: fact.item
  })
  return true
}

function processingFuelRequirement(
  pack: GameKnowledgePack,
  route: Extract<ProductionRoute, { kind: 'process' }>,
  batches: number,
  state: MutablePlannerState
): { item: string; quantity: number } | null {
  if (route.fact.kind === 'stonecutting') {
    return null
  }

  const cookTime = route.fact.cookTimeTicks
  if (cookTime === null) return null

  const candidates = pack.fuels
    .map(fact => ({
      item: fact.item,
      quantity: Math.ceil(
        (cookTime * batches) / fact.burnTimeTicks
      ),
      hasStock: availableStock(state, fact.item) > 0,
      hasRoute: productionRoutesFor(pack, fact.item).length > 0
    }))
    .filter(candidate => candidate.hasStock || candidate.hasRoute)
    .sort((left, right) => {
      if (left.hasStock !== right.hasStock) {
        return left.hasStock ? -1 : 1
      }
      if (left.quantity !== right.quantity) {
        return left.quantity - right.quantity
      }
      return left.item.localeCompare(right.item)
    })

  const selected = candidates[0]
  return selected
    ? { item: selected.item, quantity: selected.quantity }
    : null
}

function rankRoutes(
  pack: GameKnowledgePack,
  item: string,
  state: MutablePlannerState
): readonly ProductionRoute[] {
  return [...productionRoutesFor(pack, item)]
    .filter(route =>
      route.kind !== 'world' ||
      worldRoutePotentiallyViable(pack, route.fact, state)
    )
    .sort((left, right) => {
      const leftRank = routeRank(pack, left, state)
      const rightRank = routeRank(pack, right, state)
      if (leftRank !== rightRank) return leftRank - rightRank
      return left.fact.id.localeCompare(right.fact.id)
    })
}

function routeRank(
  pack: GameKnowledgePack,
  route: ProductionRoute,
  state: MutablePlannerState
): number {
  if (route.kind === 'world') {
    const existing = state.tools.some(tool =>
      toolMatchesRequirement(pack, tool, route.fact.tool)
    )
    return existing ? 0 : 30
  }
  if (route.kind === 'craft') return 10
  return 20
}

function worldRoutePotentiallyViable(
  pack: GameKnowledgePack,
  fact: WorldAcquisitionFact,
  state: MutablePlannerState
): boolean {
  const acceptedItems = normalizedAcceptedItems(fact.tool)
  if (fact.tool.class === null && acceptedItems.size === 0) {
    return fact.tool.requiredEnchantments.length === 0
  }

  if (state.tools.some(tool =>
    toolMatchesRequirement(pack, tool, fact.tool)
  )) {
    return true
  }

  if (fact.tool.requiredEnchantments.length > 0) {
    return false
  }

  return pack.tools.some(tool =>
    (acceptedItems.size === 0 || acceptedItems.has(tool.item)) &&
    (fact.tool.class === null || tool.class === fact.tool.class) &&
    tierSatisfies(tool, fact.tool) &&
    productionRoutesFor(pack, tool.item).length > 0
  )
}

function toolMatchesRequirement(
  pack: GameKnowledgePack,
  owned: OwnedToolState,
  requirement: ToolRequirement
): boolean {
  const acceptedItems = normalizedAcceptedItems(requirement)
  const item = normalizeNamespacedId(owned.item)
  if (acceptedItems.size > 0 && !acceptedItems.has(item)) {
    return false
  }

  const fact = pack.tools.find(candidate => candidate.item === item)
  if (requirement.class !== null) {
    if (
      !fact ||
      fact.class !== requirement.class ||
      !tierSatisfies(fact, requirement)
    ) {
      return false
    }
  } else if (
    requirement.minimumTierRank !== null &&
    (!fact || !tierSatisfies(fact, requirement))
  ) {
    return false
  }

  const enchantments = new Set(
    owned.enchantments.map(value => value.trim().toLowerCase())
  )
  if (
    requirement.requiredEnchantments.some(
      value => !enchantments.has(value.trim().toLowerCase())
    )
  ) {
    return false
  }
  if (
    requirement.forbiddenEnchantments.some(
      value => enchantments.has(value.trim().toLowerCase())
    )
  ) {
    return false
  }
  return true
}

function normalizedAcceptedItems(
  requirement: ToolRequirement
): ReadonlySet<string> {
  return new Set(
    (requirement.acceptedItems ?? []).map(normalizeNamespacedId)
  )
}

function firstAcceptedItem(
  acceptedItems: ReadonlySet<string>
): string {
  return [...acceptedItems].sort()[0] ?? 'tool'
}

function tierSatisfies(
  tool: ToolFact,
  requirement: ToolRequirement
): boolean {
  if (requirement.minimumTierRank === null) return true
  return (
    tool.tierRank !== null &&
    tool.tierRank >= requirement.minimumTierRank
  )
}

function compareToolFacts(
  left: ToolFact,
  right: ToolFact
): number {
  const leftRank = left.tierRank ?? Number.MAX_SAFE_INTEGER
  const rightRank = right.tierRank ?? Number.MAX_SAFE_INTEGER
  if (leftRank !== rightRank) return leftRank - rightRank
  return left.item.localeCompare(right.item)
}

function takeExistingStock(
  item: string,
  quantity: number,
  state: MutablePlannerState,
  steps: SupplyStep[]
): number {
  let remaining = quantity

  const inventoryCount = state.inventory.get(item) ?? 0
  if (inventoryCount > 0) {
    const used = Math.min(remaining, inventoryCount)
    if (used > 0) {
      state.inventory.set(item, inventoryCount - used)
      steps.push({
        kind: 'use_inventory',
        item,
        quantity: used
      })
      remaining -= used
    }
  }

  for (const storage of state.storages) {
    if (remaining === 0) break
    const available = storage.items.get(item) ?? 0
    const used = Math.min(remaining, available)
    if (used <= 0) continue

    storage.items.set(item, available - used)
    steps.push({
      kind: 'withdraw_storage',
      storageId: storage.id,
      item,
      quantity: used
    })
    remaining -= used
  }

  return remaining
}

function availableStock(
  state: MutablePlannerState,
  item: string
): number {
  const normalized = normalizeNamespacedId(item)
  return (
    (state.inventory.get(normalized) ?? 0) +
    state.storages.reduce(
      (total, storage) =>
        total + (storage.items.get(normalized) ?? 0),
      0
    )
  )
}

function rememberOverproduction(
  state: MutablePlannerState,
  item: string,
  quantity: number
): void {
  if (quantity <= 0) return
  state.inventory.set(
    item,
    (state.inventory.get(item) ?? 0) + quantity
  )
}

function cloneMutableState(
  state: MutablePlannerState
): MutablePlannerState {
  return {
    inventory: new Map(state.inventory),
    storages: state.storages.map(storage => ({
      id: storage.id,
      items: new Map(storage.items)
    })),
    tools: state.tools.map(tool => ({
      item: tool.item,
      enchantments: [...tool.enchantments]
    })),
    workstations: new Set(state.workstations)
  }
}

function commitMutableState(
  target: MutablePlannerState,
  source: MutablePlannerState
): void {
  target.inventory.clear()
  for (const [item, quantity] of source.inventory) {
    target.inventory.set(item, quantity)
  }

  target.storages.splice(
    0,
    target.storages.length,
    ...source.storages.map(storage => ({
      id: storage.id,
      items: new Map(storage.items)
    }))
  )

  target.tools.splice(
    0,
    target.tools.length,
    ...source.tools.map(tool => ({
      item: tool.item,
      enchantments: [...tool.enchantments]
    }))
  )

  target.workstations.clear()
  for (const workstation of source.workstations) {
    target.workstations.add(workstation)
  }
}

function createMutableState(
  state: SupplyPlanningState
): MutablePlannerState {
  return {
    inventory: normalizedCountMap(state.inventory),
    storages: state.storages
      .map(storage => ({
        id: storage.id,
        items: normalizedCountMap(storage.items)
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    tools: state.tools.map(tool => ({
      item: normalizeNamespacedId(tool.item),
      enchantments: [...tool.enchantments]
    })),
    workstations: new Set(
      state.workstations.map(normalizeNamespacedId)
    )
  }
}

function normalizedCountMap(
  source: Readonly<Record<string, number>>
): Map<string, number> {
  const result = new Map<string, number>()
  for (const [key, value] of Object.entries(source)) {
    if (!Number.isFinite(value) || value <= 0) continue
    result.set(
      normalizeNamespacedId(key),
      Math.floor(value)
    )
  }
  return result
}
