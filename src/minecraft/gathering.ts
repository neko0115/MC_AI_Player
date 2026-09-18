import type { Position } from '../contracts/events.js'
import type { SkillResult } from '../contracts/skills.js'
import type { ResourceMutationPermit } from '../safety/policy.js'
import type { NavigationOptions } from './adapter.js'

export interface ResourceCandidate {
  readonly blockName: string
  readonly position: Position
  readonly approachPosition?: Position
  readonly pickupPosition?: Position
}

export interface DroppedResource {
  readonly entityId: number
  readonly itemName: string
  readonly count: number
  readonly position: Position
}

export interface PlayerResourceCollection extends DroppedResource {
  readonly sequence: number
  readonly player: string
}

export type DroppedResourceStatus =
  | { readonly kind: 'present'; readonly drop: DroppedResource }
  | { readonly kind: 'collected_by_player'; readonly player: string; readonly count: number }
  | { readonly kind: 'collected_by_bot'; readonly count: number }
  | { readonly kind: 'gone' }

export interface ResourceSearchRequest {
  readonly blockNames: readonly string[]
  readonly origin: Position
  readonly radius: number
  readonly limit: number
}

export interface ResourceHarvestOptions {
  readonly sneak?: boolean
  readonly expectedItemNames?: readonly string[]
}

export interface ResourceToolPreparationOptions {
  readonly toolKind?: 'axe' | 'pickaxe'
  readonly forbiddenEnchantments?: readonly string[]
}

export interface ResourceGatheringAdapter {
  currentPosition(): Position | null
  inventoryCount(item: string): number
  findResourceBlocks(
    request: ResourceSearchRequest,
    signal: AbortSignal
  ): Promise<readonly ResourceCandidate[]>
  prepareResourceTool?(
    target: ResourceCandidate,
    signal: AbortSignal,
    options?: ResourceToolPreparationOptions
  ): Promise<SkillResult>
  harvestResourceBlock(
    target: ResourceCandidate,
    permit: ResourceMutationPermit,
    signal: AbortSignal,
    options?: ResourceHarvestOptions
  ): Promise<SkillResult>
  findDroppedResource?(
    itemName: string,
    origin: Position,
    radius: number,
    signal: AbortSignal
  ): Promise<DroppedResource | null>
  droppedResourceStatus?(entityId: number): DroppedResourceStatus
  resourceCollectionCursor?(): number
  findPlayerResourceCollectionAfter?(
    cursor: number,
    itemName: string,
    origin: Position,
    radius: number
  ): PlayerResourceCollection | null
}

export interface ResourceNavigationAdapter {
  goTo(
    position: Position,
    options: NavigationOptions,
    signal: AbortSignal
  ): Promise<SkillResult>
}
