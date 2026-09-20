import { createBot, type Bot } from 'mineflayer'
import type { MinecraftConfig } from '../config.js'
import type {
  ContainerTransactionAdapter,
  MinecraftAdapter,
  SurvivalInventoryAdapter
} from './adapter.js'
import type { ResourceGatheringAdapter } from './gathering.js'
import {
  MineflayerAdapter,
  type MineflayerBotFactory
} from './mineflayer-adapter.js'
import { MineflayerGatheringRuntime } from './mineflayer-gathering.js'
import {
  MineflayerChatOutput
} from './chat-output.js'
import { MineflayerInventoryRuntime } from './mineflayer-inventory.js'
import {
  installMineflayerRuntimeExtensions,
  type MineflayerRuntimeExtension
} from './runtime-extension.js'
import {
  MINECRAFT_ADAPTER_PORT,
  MINECRAFT_CHAT_OUTPUT_PORT,
  RESOURCE_GATHERING_PORT,
  RUNTIME_PORT_REGISTRY,
  RuntimePortRegistry,
  SURVIVAL_INVENTORY_PORT,
  type RuntimePortContainer
} from './runtime-ports.js'

export interface MineflayerRuntimeBundle extends RuntimePortContainer {
  readonly adapter: MinecraftAdapter
  readonly inventory: SurvivalInventoryAdapter & ContainerTransactionAdapter
  readonly gathering: ResourceGatheringAdapter
}

export interface MineflayerRuntimeBundleDependencies {
  readonly createBot?: MineflayerBotFactory
  readonly extensions?: readonly MineflayerRuntimeExtension[]
}

export function createMineflayerRuntimeBundle(
  config: MinecraftConfig,
  dependencies: MineflayerRuntimeBundleDependencies = {}
): MineflayerRuntimeBundle {
  const createUnderlyingBot = dependencies.createBot ?? createBot
  let currentBot: Bot | null = null
  let spawned = false

  const trackedCreateBot: MineflayerBotFactory = options => {
    const bot = createUnderlyingBot(options)
    currentBot = bot
    spawned = false
    return bot
  }

  const adapter = new MineflayerAdapter(config, { createBot: trackedCreateBot })
  adapter.onEvent(event => {
    if (event.type === 'spawned') {
      spawned = true
      return
    }
    if (event.type === 'disconnected') {
      spawned = false
    }
  })

  const readyBot = (): Bot | null => spawned ? currentBot : null
  const inventoryRuntime = new MineflayerInventoryRuntime(readyBot)
  const gatheringRuntime = new MineflayerGatheringRuntime(readyBot)
  const chatOutput =
    new MineflayerChatOutput(
      readyBot
    )

  const inventory: SurvivalInventoryAdapter & ContainerTransactionAdapter = {
    inventoryItems: () => inventoryRuntime.inventoryItems(),
    consumeInventoryItem: (item, signal) =>
      inventoryRuntime.consumeInventoryItem(item, signal),
    equipInventoryItem: (item, destination, signal) =>
      inventoryRuntime.equipInventoryItem(item, destination, signal),
    transferContainerItem: (target, direction, item, quantity, signal) =>
      inventoryRuntime.transferContainerItem(target, direction, item, quantity, signal)
  }
  Object.freeze(inventory)

  const gathering: ResourceGatheringAdapter = {
    currentPosition: () => gatheringRuntime.currentPosition(),
    inventoryCount: item => gatheringRuntime.inventoryCount(item),
    inspectBlock: position => gatheringRuntime.inspectBlock(position),
    findResourceBlocks: (request, signal) =>
      gatheringRuntime.findResourceBlocks(request, signal),
    findExplorationWaypoints: (request, signal) =>
      gatheringRuntime.findExplorationWaypoints(request, signal),
    prepareResourceTool: (target, signal, options) =>
      gatheringRuntime.prepareResourceTool(target, signal, options),
    harvestResourceBlock: (target, permit, signal, options) =>
      gatheringRuntime.harvestResourceBlock(target, permit, signal, options),
    findDecayingLeafBlocks: (leafNames, origin, radius, limit, signal) =>
      gatheringRuntime.findDecayingLeafBlocks(leafNames, origin, radius, limit, signal),
    findDroppedResource: (itemName, origin, radius, signal) =>
      gatheringRuntime.findDroppedResource(itemName, origin, radius, signal),
    droppedResourceStatus: entityId =>
      gatheringRuntime.droppedResourceStatus(entityId),
    resourceCollectionCursor: () =>
      gatheringRuntime.resourceCollectionCursor(),
    findPlayerResourceCollectionAfter: (cursor, itemName, origin, radius) =>
      gatheringRuntime.findPlayerResourceCollectionAfter(cursor, itemName, origin, radius)
  }
  Object.freeze(gathering)

  const ports = new RuntimePortRegistry()
  ports.register(MINECRAFT_ADAPTER_PORT, adapter)
  ports.register(SURVIVAL_INVENTORY_PORT, inventory)
  ports.register(RESOURCE_GATHERING_PORT, gathering)
  ports.register(
    MINECRAFT_CHAT_OUTPUT_PORT,
    chatOutput
  )

  installMineflayerRuntimeExtensions(
    { readyBot, ports },
    dependencies.extensions ?? []
  )

  return Object.freeze({
    adapter,
    inventory,
    gathering,
    [RUNTIME_PORT_REGISTRY]: ports
  })
}
