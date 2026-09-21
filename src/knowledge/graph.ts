import {
  normalizeNamespacedId,
  type GameKnowledgePack,
  type ProcessingFact,
  type RecipeFact,
  type WorldAcquisitionFact
} from './contracts.js'

export type ProductionRoute =
  | {
      readonly kind: 'world'
      readonly fact: WorldAcquisitionFact
    }
  | {
      readonly kind: 'craft'
      readonly fact: RecipeFact
    }
  | {
      readonly kind: 'process'
      readonly fact: ProcessingFact
    }

export interface ProductionRequirementNode {
  readonly item: string
  readonly quantity: number
  readonly route: ProductionRoute
  readonly batches: number
  readonly children: readonly ProductionRequirementNode[]
}

export interface ExpansionOptions {
  readonly maxDepth?: number
  readonly maxNodes?: number
  readonly selectRoute?: (
    item: string,
    quantity: number,
    routes: readonly ProductionRoute[]
  ) => ProductionRoute | undefined
}

const DEFAULT_MAX_DEPTH = 32
const DEFAULT_MAX_NODES = 2048

export function productionRoutesFor(
  pack: GameKnowledgePack,
  item: string
): readonly ProductionRoute[] {
  const normalized = normalizeNamespacedId(item)
  const routes: ProductionRoute[] = []

  for (const fact of pack.worldAcquisition) {
    if (fact.output.item === normalized) {
      routes.push({ kind: 'world', fact })
    }
  }

  for (const fact of pack.recipes) {
    if (fact.output.item === normalized) {
      routes.push({ kind: 'craft', fact })
    }
  }

  for (const fact of pack.processing) {
    if (fact.output.item === normalized) {
      routes.push({ kind: 'process', fact })
    }
  }

  routes.sort(compareRoutes)
  return routes
}

export function expandProductionRequirement(
  pack: GameKnowledgePack,
  item: string,
  quantity: number,
  options: ExpansionOptions = {}
): ProductionRequirementNode {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error('invalid_production_quantity')
  }

  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new Error('invalid_production_max_depth')
  }
  if (!Number.isInteger(maxNodes) || maxNodes < 1) {
    throw new Error('invalid_production_max_nodes')
  }

  let nodeCount = 0

  const visit = (
    currentItem: string,
    currentQuantity: number,
    depth: number,
    path: ReadonlySet<string>
  ): ProductionRequirementNode => {
    if (depth > maxDepth) {
      throw new Error('production_max_depth_exceeded')
    }

    nodeCount += 1
    if (nodeCount > maxNodes) {
      throw new Error('production_max_nodes_exceeded')
    }

    const normalizedItem = normalizeNamespacedId(currentItem)
    if (path.has(normalizedItem)) {
      throw new Error(`production_cycle_detected:${normalizedItem}`)
    }

    const routes = productionRoutesFor(pack, normalizedItem)
    const route = options.selectRoute
      ? options.selectRoute(normalizedItem, currentQuantity, routes)
      : routes[0]

    if (!route) {
      throw new Error(`production_route_missing:${normalizedItem}`)
    }

    const batches = routeBatches(route, currentQuantity)
    const nextPath = new Set(path)
    nextPath.add(normalizedItem)

    if (route.kind === 'world') {
      return {
        item: normalizedItem,
        quantity: currentQuantity,
        route,
        batches,
        children: []
      }
    }

    if (route.kind === 'craft') {
      return {
        item: normalizedItem,
        quantity: currentQuantity,
        route,
        batches,
        children: route.fact.inputs.map(input =>
          visit(
            input.item,
            input.count * batches,
            depth + 1,
            nextPath
          )
        )
      }
    }

    return {
      item: normalizedItem,
      quantity: currentQuantity,
      route,
      batches,
      children: [
        visit(
          route.fact.input.item,
          route.fact.input.count * batches,
          depth + 1,
          nextPath
        )
      ]
    }
  }

  return visit(item, quantity, 1, new Set())
}

export function routeBatches(
  route: ProductionRoute,
  quantity: number
): number {
  const outputCount = route.fact.output.count
  return Math.ceil(quantity / outputCount)
}

function compareRoutes(
  left: ProductionRoute,
  right: ProductionRoute
): number {
  const kindOrder = {
    world: 0,
    craft: 1,
    process: 2
  } as const

  const kindDelta = kindOrder[left.kind] - kindOrder[right.kind]
  if (kindDelta !== 0) return kindDelta

  return left.fact.id.localeCompare(right.fact.id)
}
