import type {
  ContainerTransactionAdapter,
  MinecraftAdapter,
  SurvivalInventoryAdapter
} from './adapter.js'
import type { ResourceGatheringAdapter } from './gathering.js'
import type {
  MinecraftChatOutput
} from './chat-output.js'

declare const RUNTIME_PORT_TYPE: unique symbol

export interface RuntimePort<T> {
  readonly id: string
  readonly [RUNTIME_PORT_TYPE]?: T
}

const PORT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/

export function defineRuntimePort<T>(
  id: string
): RuntimePort<T> {
  if (!PORT_ID_PATTERN.test(id)) {
    throw new Error(`invalid runtime port id: ${id}`)
  }
  return Object.freeze({ id }) as RuntimePort<T>
}

export class RuntimePortRegistry {
  private readonly values = new Map<RuntimePort<unknown>, unknown>()
  private readonly ids = new Set<string>()

  register<T>(
    port: RuntimePort<T>,
    value: T
  ): void {
    if (this.ids.has(port.id)) {
      throw new Error(`runtime port already registered: ${port.id}`)
    }
    this.ids.add(port.id)
    this.values.set(port as RuntimePort<unknown>, value)
  }

  has<T>(port: RuntimePort<T>): boolean {
    return this.values.has(port as RuntimePort<unknown>)
  }

  require<T>(port: RuntimePort<T>): T {
    if (!this.values.has(port as RuntimePort<unknown>)) {
      throw new Error(`runtime port not registered: ${port.id}`)
    }
    return this.values.get(port as RuntimePort<unknown>) as T
  }

  registeredIds(): readonly string[] {
    return [...this.ids]
  }
}

export const MINECRAFT_ADAPTER_PORT =
  defineRuntimePort<MinecraftAdapter>('minecraft.adapter')

export const SURVIVAL_INVENTORY_PORT =
  defineRuntimePort<
    SurvivalInventoryAdapter & ContainerTransactionAdapter
  >('minecraft.inventory')

export const RESOURCE_GATHERING_PORT =
  defineRuntimePort<ResourceGatheringAdapter>('minecraft.gathering')

export const MINECRAFT_CHAT_OUTPUT_PORT =
  defineRuntimePort<MinecraftChatOutput>(
    'minecraft.chat_output'
  )

export const RUNTIME_PORT_REGISTRY =
  Symbol('mc-ai-player.runtime-ports')

export interface RuntimePortContainer {
  readonly [RUNTIME_PORT_REGISTRY]?: RuntimePortRegistry
  readonly adapter?: MinecraftAdapter
  readonly inventory?: SurvivalInventoryAdapter & ContainerTransactionAdapter
  readonly gathering?: ResourceGatheringAdapter
}

export function runtimePortRegistry(
  container: RuntimePortContainer
): RuntimePortRegistry {
  const existing = container[RUNTIME_PORT_REGISTRY]
  if (existing) return existing

  const registry = new RuntimePortRegistry()
  if (container.adapter) {
    registry.register(MINECRAFT_ADAPTER_PORT, container.adapter)
  }
  if (container.inventory) {
    registry.register(SURVIVAL_INVENTORY_PORT, container.inventory)
  }
  if (container.gathering) {
    registry.register(RESOURCE_GATHERING_PORT, container.gathering)
  }
  return registry
}
