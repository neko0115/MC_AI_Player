import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { RuntimeEventSchema, type RuntimeEvent } from '../contracts/events.js'
import type { MinecraftAdapter, MinecraftEventListener } from './adapter.js'

const FixtureSchema = z.array(RuntimeEventSchema)

export class FakeMinecraftAdapter implements MinecraftAdapter {
  private readonly listeners = new Set<MinecraftEventListener>()
  private connected = false
  public stopMotionCount = 0

  private constructor(private readonly fixtureEvents: RuntimeEvent[]) {}

  static async fromFile(filePath: string): Promise<FakeMinecraftAdapter> {
    const raw = await readFile(filePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return new FakeMinecraftAdapter(FixtureSchema.parse(parsed))
  }

  onEvent(listener: MinecraftEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async connect(): Promise<void> {
    this.connected = true
    for (const event of this.fixtureEvents) {
      this.emit(event)
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected) {
      return
    }
    this.connected = false
    this.emit({ type: 'disconnected', at: Date.now(), reason: 'fake-adapter-disconnect' })
  }

  async stopMotion(): Promise<void> {
    this.stopMotionCount += 1
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of [...this.listeners]) {
      listener(structuredClone(event))
    }
  }
}
