import { createBot, type Bot, type BotOptions } from 'mineflayer'
import type { MinecraftConfig } from '../config.js'
import type { RuntimeEvent } from '../contracts/events.js'
import type { MinecraftAdapter, MinecraftEventListener } from './adapter.js'
import { ObservationBridge } from './observation-bridge.js'

export type MineflayerBotFactory = (options: BotOptions) => Bot

export interface ReconnectOptions {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export class ReconnectPolicy {
  private attempts = 0

  constructor(private readonly options: ReconnectOptions) {
    if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 0) {
      throw new RangeError('maxAttempts must be a non-negative integer')
    }
    if (!Number.isFinite(options.baseDelayMs) || options.baseDelayMs < 0) {
      throw new RangeError('baseDelayMs must be a non-negative finite number')
    }
    if (!Number.isFinite(options.maxDelayMs) || options.maxDelayMs < options.baseDelayMs) {
      throw new RangeError('maxDelayMs must be finite and >= baseDelayMs')
    }
  }

  nextDelayMs(): number | null {
    if (this.attempts >= this.options.maxAttempts) {
      return null
    }
    const delay = Math.min(
      this.options.maxDelayMs,
      this.options.baseDelayMs * 2 ** this.attempts
    )
    this.attempts += 1
    return delay
  }

  reset(): void {
    this.attempts = 0
  }
}

type TimerHandle = ReturnType<typeof setTimeout>

interface MineflayerAdapterDependencies {
  createBot?: MineflayerBotFactory
  reconnect?: ReconnectOptions
  schedule?: (callback: () => void, delayMs: number) => TimerHandle
  cancelSchedule?: (handle: TimerHandle) => void
  now?: () => number
}

export class MineflayerAdapter implements MinecraftAdapter {
  private readonly listeners = new Set<MinecraftEventListener>()
  private readonly createBot: MineflayerBotFactory
  private readonly reconnectPolicy: ReconnectPolicy
  private readonly schedule: (callback: () => void, delayMs: number) => TimerHandle
  private readonly cancelSchedule: (handle: TimerHandle) => void
  private readonly bridge: ObservationBridge
  private readonly inventoryListeners = new WeakSet<Bot>()
  private bot: Bot | null = null
  private reconnectTimer: TimerHandle | null = null
  private operatorDisconnect = false

  constructor(
    private readonly config: MinecraftConfig,
    dependencies: MineflayerAdapterDependencies = {}
  ) {
    this.createBot = dependencies.createBot ?? createBot
    this.reconnectPolicy = new ReconnectPolicy(
      dependencies.reconnect ?? {
        maxAttempts: 5,
        baseDelayMs: 1000,
        maxDelayMs: 30_000
      }
    )
    this.schedule = dependencies.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.cancelSchedule = dependencies.cancelSchedule ?? (handle => clearTimeout(handle))
    this.bridge = new ObservationBridge(dependencies.now ?? Date.now)
  }

  onEvent(listener: MinecraftEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async connect(): Promise<void> {
    if (this.bot !== null) {
      return
    }
    this.operatorDisconnect = false
    if (this.reconnectTimer !== null) {
      this.cancelSchedule(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.startConnection()
  }

  async disconnect(): Promise<void> {
    this.operatorDisconnect = true
    if (this.reconnectTimer !== null) {
      this.cancelSchedule(this.reconnectTimer)
      this.reconnectTimer = null
    }

    const bot = this.bot
    if (bot === null) {
      return
    }
    bot.clearControlStates()
    bot.quit('operator-disconnect')
  }

  async stopMotion(): Promise<void> {
    this.bot?.clearControlStates()
  }

  private startConnection(): void {
    const options: BotOptions = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      auth: this.config.auth,
      ...(this.config.version ? { version: this.config.version } : {})
    }
    const bot = this.createBot(options)
    this.bot = bot
    this.attachObservationListeners(bot)
  }

  private attachObservationListeners(bot: Bot): void {
    bot.on('login', () => {
      if (this.bot !== bot) return
      this.reconnectPolicy.reset()
      this.emit(this.bridge.connected())
    })

    bot.on('spawn', () => {
      if (this.bot !== bot) return
      this.attachInventoryListener(bot)
      this.emit(this.bridge.spawned(bot))
    })

    bot.on('playerJoined', player => {
      if (this.bot !== bot) return
      this.emitPlayerIfPositioned(player)
    })

    bot.on('playerUpdated', player => {
      if (this.bot !== bot) return
      this.emitPlayerIfPositioned(player)
    })

    bot.on('entitySpawn', entity => {
      if (
        this.bot !== bot ||
        entity.type !== 'player' ||
        !entity.username ||
        entity.username === bot.username
      ) {
        return
      }
      this.emitPlayerIfPositioned({
        username: entity.username,
        ...(entity.uuid ? { uuid: entity.uuid } : {}),
        entity
      })
    })

    bot.on('chat', (username, message) => {
      if (this.bot !== bot || username === bot.username) return
      this.emit(this.bridge.chat(username, message))
    })

    bot.on('health', () => {
      if (this.bot !== bot) return
      this.emit(this.bridge.health(bot))
    })

    bot.on('kicked', reason => {
      if (this.bot !== bot) return
      this.emit(this.bridge.kicked(reason))
    })

    bot.on('error', error => {
      if (this.bot !== bot) return
      this.emit(this.bridge.error(error))
    })

    bot.on('end', reason => {
      if (this.bot !== bot) return
      this.bot = null
      this.emit(this.bridge.ended(reason))
      if (!this.operatorDisconnect) {
        this.scheduleReconnect()
      }
    })
  }

  private emitPlayerIfPositioned(player: Parameters<ObservationBridge['playerSeen']>[0]): void {
    const event = this.bridge.playerSeen(player)
    if (event !== null) {
      this.emit(event)
    }
  }

  private attachInventoryListener(bot: Bot): void {
    if (this.inventoryListeners.has(bot)) {
      return
    }
    const inventory = bot.inventory as Bot['inventory'] | undefined
    if (!inventory) {
      return
    }
    inventory.on('updateSlot', () => {
      if (this.bot !== bot) return
      this.emit(this.bridge.inventory(bot))
    })
    this.inventoryListeners.add(bot)
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.operatorDisconnect) {
      return
    }
    const delay = this.reconnectPolicy.nextDelayMs()
    if (delay === null) {
      this.emit(this.bridge.reconnectExhausted())
      return
    }

    this.reconnectTimer = this.schedule(() => {
      this.reconnectTimer = null
      if (this.operatorDisconnect || this.bot !== null) {
        return
      }
      try {
        this.startConnection()
      } catch (error) {
        this.emit(this.bridge.error(asError(error)))
        this.scheduleReconnect()
      }
    }, delay)
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event)
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
