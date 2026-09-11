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

export interface ResourceGatheringAdapter {
  currentPosition(): Position | null
  inventoryCount(item: string): number
  findResourceBlocks(
    request: ResourceSearchRequest,
    signal: AbortSignal
  ): Promise<readonly ResourceCandidate[]>
  harvestResourceBlock(
    target: ResourceCandidate,
    permit: ResourceMutationPermit,
    signal: AbortSignal
  ): Promise<SkillResult>
  findDroppedResource?(
    itemName: string,
    origin: Position,
    radius: number,
    signal: AbortSignal
  ): Promise<DroppedResource | null>
  droppedResourceStatus?(entityId: number): DroppedResourceStatus
}

export interface ResourceNavigationAdapter {
  goTo(
    position: Position,
    options: NavigationOptions,
    signal: AbortSignal
  ): Promise<SkillResult>
}
