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
import { MineflayerInventoryRuntime } from './mineflayer-inventory.js'

export interface MineflayerRuntimeBundle {
  readonly adapter: MinecraftAdapter
  readonly inventory: SurvivalInventoryAdapter & ContainerTransactionAdapter
  readonly gathering: ResourceGatheringAdapter
}

export interface MineflayerRuntimeBundleDependencies {
  readonly createBot?: MineflayerBotFactory
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
    findResourceBlocks: (request, signal) =>
      gatheringRuntime.findResourceBlocks(request, signal),
    prepareResourceTool: (target, signal, options) =>
      gatheringRuntime.prepareResourceTool(target, signal, options),
    harvestResourceBlock: (target, permit, signal, options) =>
      gatheringRuntime.harvestResourceBlock(target, permit, signal, options),
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

  return Object.freeze({
    adapter,
    inventory,
    gathering
  })
}
