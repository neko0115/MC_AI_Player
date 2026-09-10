import type { Bot } from 'mineflayer'
import type { SkillResult } from '../contracts/skills.js'
import type {
  ContainerTransactionAdapter,
  EquipmentSlot,
  InventoryStack,
  ResolvedStorageTarget,
  SurvivalInventoryAdapter
} from './adapter.js'

export type MineflayerBotProvider = () => Bot | null

export class MineflayerInventoryRuntime
  implements SurvivalInventoryAdapter, ContainerTransactionAdapter {
  constructor(private readonly getBot: MineflayerBotProvider) {}

  inventoryItems(): readonly InventoryStack[] {
    const bot = this.getBot()
    if (!bot?.inventory) return []
    return bot.inventory.items().map(item => ({ name: item.name, count: item.count }))
  }

  async consumeInventoryItem(itemName: string, signal: AbortSignal): Promise<SkillResult> {
    if (signal.aborted) return cancelled(signal)
    const bot = this.getBot()
    if (!bot?.inventory) return { status: 'failed', code: 'minecraft_not_ready' }

    const item = bot.inventory.items().find(candidate => candidate.name === itemName)
    if (!item) return { status: 'failed', code: 'item_not_found' }

    try {
      await bot.equip(item, 'hand')
      if (signal.aborted) return cancelled(signal)
      await bot.consume()
      if (signal.aborted) return cancelled(signal)
      return { status: 'succeeded', code: 'consumed' }
    } catch (error) {
      if (signal.aborted) return cancelled(signal)
      return { status: 'failed', code: operationFailureCode(error, 'consume_failed') }
    }
  }

  async equipInventoryItem(
    itemName: string,
    destination: EquipmentSlot | undefined,
    signal: AbortSignal
  ): Promise<SkillResult> {
    if (signal.aborted) return cancelled(signal)
    const bot = this.getBot()
    if (!bot?.inventory) return { status: 'failed', code: 'minecraft_not_ready' }

    const item = bot.inventory.items().find(candidate => candidate.name === itemName)
    if (!item) return { status: 'failed', code: 'item_not_found' }

    try {
      await bot.equip(item, destination ?? 'hand')
      if (signal.aborted) return cancelled(signal)
      return { status: 'succeeded', code: 'equipped' }
    } catch (error) {
      if (signal.aborted) return cancelled(signal)
      return { status: 'failed', code: operationFailureCode(error, 'equip_failed') }
    }
  }

  async transferContainerItem(
    target: ResolvedStorageTarget,
    direction: 'deposit' | 'withdraw',
    itemName: string,
    quantity: number,
    signal: AbortSignal
  ): Promise<SkillResult> {
    if (signal.aborted) return cancelled(signal)
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 2304) {
      return { status: 'failed', code: 'invalid_quantity' }
    }

    const bot = this.getBot()
    if (!bot?.inventory || !bot.entity?.position) {
      return { status: 'failed', code: 'minecraft_not_ready' }
    }

    const point = bot.entity.position.clone()
    point.set(target.position.x, target.position.y, target.position.z)
    const block = bot.blockAt(point)
    if (!block) return { status: 'failed', code: 'storage_block_missing' }
    if (!target.expectedBlockNames.includes(block.name)) {
      return { status: 'failed', code: 'storage_block_mismatch' }
    }

    let container: Awaited<ReturnType<Bot['openContainer']>> | null = null
    let closed = false
    let disconnected = false

    const close = async () => {
      if (closed || !container) return
      closed = true
      try {
        await container.close()
      } catch {}
    }
    const onAbort = () => {
      void close()
    }
    const onEnd = () => {
      disconnected = true
      void close()
    }

    signal.addEventListener('abort', onAbort, { once: true })
    bot.once('end', onEnd)

    try {
      container = await bot.openContainer(block)
      if (signal.aborted) return cancelled(signal)
      if (disconnected) return { status: 'failed', code: 'disconnected' }

      if (direction === 'deposit') {
        const matching = bot.inventory.items().filter(item => item.name === itemName)
        const available = matching.reduce((sum, item) => sum + item.count, 0)
        const source = matching[0]
        if (!source || available < quantity) {
          return { status: 'failed', code: 'insufficient_item' }
        }
        await container.deposit(source.type, source.metadata, quantity)
      } else {
        const matching = container.items().filter(item => item.name === itemName)
        const available = matching.reduce((sum, item) => sum + item.count, 0)
        const source = matching[0]
        if (!source || available < quantity) {
          return { status: 'failed', code: 'insufficient_storage_item' }
        }
        await container.withdraw(source.type, source.metadata, quantity)
      }

      if (signal.aborted) return cancelled(signal)
      if (disconnected) return { status: 'failed', code: 'disconnected' }
      return { status: 'succeeded', code: 'transferred' }
    } catch (error) {
      if (signal.aborted) return cancelled(signal)
      if (disconnected) return { status: 'failed', code: 'disconnected' }
      return {
        status: 'failed',
        code: transactionFailureCode(error, direction)
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      bot.off('end', onEnd)
      await close()
    }
  }
}

function transactionFailureCode(
  error: unknown,
  direction: 'deposit' | 'withdraw'
): string {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  if (message.includes('full') || message.includes('no space') || message.includes('space available')) {
    return direction === 'deposit' ? 'container_full' : 'inventory_full'
  }
  return 'container_transaction_failed'
}

function operationFailureCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  if (message.includes('disconnected') || message.includes('socket') || message.includes('ended')) {
    return 'disconnected'
  }
  return fallback
}

function cancelled(signal: AbortSignal): SkillResult {
  const reason = typeof signal.reason === 'string' ? signal.reason.trim() : ''
  return {
    status: 'cancelled',
    code: reason ? reason.replace(/\s+/g, '_').slice(0, 128) : 'cancelled'
  }
}
