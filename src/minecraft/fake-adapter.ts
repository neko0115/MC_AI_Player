import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { RuntimeEventSchema, type Position, type RuntimeEvent } from '../contracts/events.js'
import type { SkillResult } from '../contracts/skills.js'
import type {
  EquipmentSlot,
  InventoryStack,
  MinecraftAdapter,
  MinecraftEventListener,
  NavigationOptions,
  ResolvedStorageTarget
} from './adapter.js'

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

  async goTo(
    _position: Position,
    _options: NavigationOptions,
    signal: AbortSignal
  ): Promise<SkillResult> {
    return signal.aborted
      ? { status: 'cancelled', code: abortCode(signal) }
      : { status: 'succeeded', code: 'fake_reached' }
  }

  async followPlayer(
    _player: string,
    _range: number,
    signal: AbortSignal
  ): Promise<SkillResult> {
    return signal.aborted
      ? { status: 'cancelled', code: abortCode(signal) }
      : { status: 'succeeded', code: 'fake_following' }
  }

  async holdPosition(signal: AbortSignal): Promise<SkillResult> {
    await this.stopMotion()
    return signal.aborted
      ? { status: 'cancelled', code: abortCode(signal) }
      : { status: 'succeeded', code: 'fake_holding' }
  }

  inventoryItems(): readonly InventoryStack[] {
    return []
  }

  async consumeInventoryItem(_item: string, signal: AbortSignal): Promise<SkillResult> {
    return signal.aborted
      ? { status: 'cancelled', code: abortCode(signal) }
      : { status: 'failed', code: 'fake_inventory_not_configured' }
  }

  async equipInventoryItem(
    _item: string,
    _destination: EquipmentSlot | undefined,
    signal: AbortSignal
  ): Promise<SkillResult> {
    return signal.aborted
      ? { status: 'cancelled', code: abortCode(signal) }
      : { status: 'failed', code: 'fake_inventory_not_configured' }
  }

  async transferContainerItem(
    _target: ResolvedStorageTarget,
    _direction: 'deposit' | 'withdraw',
    _item: string,
    _quantity: number,
    signal: AbortSignal
  ): Promise<SkillResult> {
    return signal.aborted
      ? { status: 'cancelled', code: abortCode(signal) }
      : { status: 'failed', code: 'fake_container_not_configured' }
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

function abortCode(signal: AbortSignal): string {
  return typeof signal.reason === 'string' && signal.reason.trim()
    ? signal.reason.trim().replace(/\s+/g, '_').slice(0, 128)
    : 'cancelled'
}
