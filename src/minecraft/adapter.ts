import type { Position, RuntimeEvent } from '../contracts/events.js'
import type { SkillResult } from '../contracts/skills.js'

export type MinecraftEventListener = (event: RuntimeEvent) => void

export interface NavigationOptions {
  readonly range: number
  readonly canDig: false
}

export interface MinecraftAdapter {
  connect(): Promise<void>
  disconnect(): Promise<void>
  goTo(position: Position, options: NavigationOptions, signal: AbortSignal): Promise<SkillResult>
  followPlayer(player: string, range: number, signal: AbortSignal): Promise<SkillResult>
  holdPosition(signal: AbortSignal): Promise<SkillResult>
  stopMotion(): Promise<void>
  onEvent(listener: MinecraftEventListener): () => void
}
