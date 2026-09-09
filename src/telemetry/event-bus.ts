import type { RuntimeEvent } from '../contracts/events.js'

export type RuntimeEventListener = (event: RuntimeEvent) => void | Promise<void>

export class RuntimeEventBus {
  private readonly listeners = new Set<RuntimeEventListener>()

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async publish(event: RuntimeEvent): Promise<void> {
    for (const listener of [...this.listeners]) {
      await listener(event)
    }
  }
}
