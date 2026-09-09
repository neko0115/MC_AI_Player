import type { RuntimeEvent } from '../contracts/events.js'

export type MinecraftEventListener = (event: RuntimeEvent) => void

export interface MinecraftAdapter {
  connect(): Promise<void>
  disconnect(): Promise<void>
  stopMotion(): Promise<void>
  onEvent(listener: MinecraftEventListener): () => void
}
