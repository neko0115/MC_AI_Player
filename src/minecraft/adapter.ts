import type { Position, RuntimeEvent } from '../contracts/events.js'
import type { SkillResult } from '../contracts/skills.js'

export type MinecraftEventListener = (event: RuntimeEvent) => void

export interface NavigationOptions {
  readonly range: number
  readonly canDig: false
}

export interface InventoryStack {
  readonly name: string
  readonly count: number
}

export type EquipmentSlot = 'hand' | 'off-hand' | 'head' | 'torso' | 'legs' | 'feet'

export interface SurvivalInventoryAdapter {
  inventoryItems(): readonly InventoryStack[]
  consumeInventoryItem(item: string, signal: AbortSignal): Promise<SkillResult>
  equipInventoryItem(
    item: string,
    destination: EquipmentSlot | undefined,
    signal: AbortSignal
  ): Promise<SkillResult>
}

export interface ResolvedStorageTarget {
  readonly id: string
  readonly position: Position
  readonly expectedBlockNames: readonly string[]
}

export interface ContainerTransactionAdapter {
  transferContainerItem(
    target: ResolvedStorageTarget,
    direction: 'deposit' | 'withdraw',
    item: string,
    quantity: number,
    signal: AbortSignal
  ): Promise<SkillResult>
}

export interface MinecraftAdapter
  extends SurvivalInventoryAdapter,
    ContainerTransactionAdapter {
  connect(): Promise<void>
  disconnect(): Promise<void>
  goTo(position: Position, options: NavigationOptions, signal: AbortSignal): Promise<SkillResult>
  followPlayer(player: string, range: number, signal: AbortSignal): Promise<SkillResult>
  holdPosition(signal: AbortSignal): Promise<SkillResult>
  stopMotion(): Promise<void>
  onEvent(listener: MinecraftEventListener): () => void
}
