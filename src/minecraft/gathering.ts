import type { Position } from '../contracts/events.js'
import type { SkillResult } from '../contracts/skills.js'
import type { ResourceMutationPermit } from '../safety/policy.js'
import type { NavigationOptions } from './adapter.js'

export interface ResourceCandidate {
  readonly blockName: string
  readonly position: Position
  readonly approachPosition?: Position
}

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
}

export interface ResourceNavigationAdapter {
  goTo(
    position: Position,
    options: NavigationOptions,
    signal: AbortSignal
  ): Promise<SkillResult>
}
