import { createRequire } from 'node:module'
import { createBot, type Bot, type BotOptions } from 'mineflayer'
import type {
  Movements,
  Pathfinder,
  PartiallyComputedPath
} from 'mineflayer-pathfinder'
import type { MinecraftConfig } from '../config.js'
import type { Position, RuntimeEvent } from '../contracts/events.js'
import type { SkillResult } from '../contracts/skills.js'
import type {
  MinecraftAdapter,
  MinecraftEventListener,
  NavigationOptions
} from './adapter.js'
import { ObservationBridge } from './observation-bridge.js'

export type MineflayerBotFactory = (options: BotOptions) => Bot

type RuntimePathfinder = Pathfinder & { searchRadius: number }
type PathfinderLoader = (bot: Bot) => void
type MovementsFactory = (bot: Bot) => Movements
type PathfinderGoal = Parameters<Pathfinder['goto']>[0]
type MineflayerPlugin = Parameters<Bot['loadPlugin']>[0]

interface PathfinderRuntimeModule {
  readonly pathfinder: MineflayerPlugin
  readonly Movements: new (bot: Bot) => Movements
  readonly goals: {
    readonly GoalNear: new (x: number, y: number, z: number, range: number) => PathfinderGoal
    readonly GoalFollow: new (entity: unknown, range: number) => PathfinderGoal
  }
}

const require = createRequire(import.meta.url)
const pathfinderRuntime = require('mineflayer-pathfinder') as PathfinderRuntimeModule
const pathfinderPlugin = pathfinderRuntime.pathfinder
const RuntimeMovements = pathfinderRuntime.Movements
const runtimeGoals = pathfinderRuntime.goals

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
  loadPathfinder?: PathfinderLoader
  createMovements?: MovementsFactory
}

export class MineflayerAdapter implements MinecraftAdapter {
  private readonly listeners = new Set<MinecraftEventListener>()
  private readonly createBot: MineflayerBotFactory
  private readonly reconnectPolicy: ReconnectPolicy
  private readonly schedule: (callback: () => void, delayMs: number) => TimerHandle
  private readonly cancelSchedule: (handle: TimerHandle) => void
  private readonly now: () => number
  private readonly bridge: ObservationBridge
  private readonly inventoryListeners = new WeakSet<Bot>()
  private readonly spawnedBots = new WeakSet<Bot>()
  private readonly loadPathfinder: PathfinderLoader
  private readonly createMovements: MovementsFactory
  private bot: Bot | null = null
  private reconnectTimer: TimerHandle | null = null
  private operatorDisconnect = false
  private navigationBot: Bot | null = null
  private navigationMovements: Movements | null = null
  private lastPositionCell: string | null = null

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
    this.now = dependencies.now ?? Date.now
    this.bridge = new ObservationBridge(this.now)
    this.loadPathfinder = dependencies.loadPathfinder ?? (bot => {
      if (!bot.hasPlugin(pathfinderPlugin)) {
        bot.loadPlugin(pathfinderPlugin)
      }
    })
    this.createMovements = dependencies.createMovements ?? (bot => new RuntimeMovements(bot))
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
    await this.stopMotion()
    bot.quit('operator-disconnect')
  }

  async goTo(
    position: Position,
    options: NavigationOptions,
    signal: AbortSignal
  ): Promise<SkillResult> {
    if (options.canDig !== false) {
      return { status: 'failed', code: 'unsafe_navigation_options' }
    }
    if (signal.aborted) {
      return { status: 'cancelled', code: abortCode(signal) }
    }

    const bot = this.readyBot()
    if (!bot) {
      return { status: 'failed', code: 'minecraft_not_ready' }
    }

    let runtime: { pathfinder: RuntimePathfinder; movements: Movements }
    try {
      runtime = this.ensureNavigation(bot)
    } catch {
      return { status: 'failed', code: 'pathfinder_unavailable' }
    }

    this.hardenMovements(runtime.movements)
    runtime.pathfinder.setMovements(runtime.movements)
    const goal = new runtimeGoals.GoalNear(position.x, position.y, position.z, options.range)
    let stuck = false

    const onAbort = () => {
      runtime.pathfinder.stop()
    }
    const onPathReset = (reason: string) => {
      if (reason !== 'stuck') return
      stuck = true
      this.emit({ type: 'stuck', at: this.now(), code: 'pathfinder_stuck' })
      runtime.pathfinder.stop()
    }

    let resolveDisconnected: ((result: SkillResult) => void) | null = null
    const onEnd = () => {
      resolveDisconnected?.({ status: 'failed', code: 'disconnected' })
    }
    const disconnected = new Promise<SkillResult>(resolve => {
      resolveDisconnected = resolve
      bot.once('end', onEnd)
    })

    signal.addEventListener('abort', onAbort, { once: true })
    bot.on('path_reset', onPathReset)

    let navigation: Promise<void>
    try {
      navigation = runtime.pathfinder.goto(goal)
    } catch (error) {
      signal.removeEventListener('abort', onAbort)
      bot.off('path_reset', onPathReset)
      bot.off('end', onEnd)
      return mapPathfinderFailure(error, signal, stuck, this.operatorDisconnect)
    }

    const navigationResult = navigation.then<SkillResult, SkillResult>(
      () => {
        if (signal.aborted) {
          return { status: 'cancelled', code: abortCode(signal) }
        }
        if (stuck) {
          return { status: 'failed', code: 'stuck' }
        }
        return { status: 'succeeded', code: 'reached' }
      },
      error => mapPathfinderFailure(error, signal, stuck, this.operatorDisconnect)
    )

    try {
      return await Promise.race([navigationResult, disconnected])
    } finally {
      signal.removeEventListener('abort', onAbort)
      bot.off('path_reset', onPathReset)
      bot.off('end', onEnd)
    }
  }

  async followPlayer(
    player: string,
    range: number,
    signal: AbortSignal
  ): Promise<SkillResult> {
    if (signal.aborted) {
      return { status: 'cancelled', code: abortCode(signal) }
    }

    const bot = this.readyBot()
    if (!bot) {
      return { status: 'failed', code: 'minecraft_not_ready' }
    }

    const target = bot.players[player]?.entity
    if (!target) {
      return { status: 'failed', code: 'player_not_found' }
    }

    let runtime: { pathfinder: RuntimePathfinder; movements: Movements }
    try {
      runtime = this.ensureNavigation(bot)
    } catch {
      return { status: 'failed', code: 'pathfinder_unavailable' }
    }

    this.hardenMovements(runtime.movements)
    runtime.pathfinder.setMovements(runtime.movements)
    const goal = new runtimeGoals.GoalFollow(target, range)

    return new Promise<SkillResult>(resolve => {
      let settled = false
      let stuck = false

      const cleanup = () => {
        signal.removeEventListener('abort', onAbort)
        bot.off('path_reset', onPathReset)
        bot.off('path_update', onPathUpdate)
        bot.off('path_stop', onPathStop)
        bot.off('entityGone', onEntityGone)
        bot.off('end', onEnd)
      }

      const finish = (result: SkillResult, stopPathfinder: boolean) => {
        if (settled) return
        settled = true
        cleanup()
        if (stopPathfinder) {
          runtime.pathfinder.stop()
        }
        resolve(result)
      }

      const onAbort = () => {
        finish({ status: 'cancelled', code: abortCode(signal) }, true)
      }
      const onPathReset = (reason: string) => {
        if (reason !== 'stuck') return
        stuck = true
        this.emit({ type: 'stuck', at: this.now(), code: 'pathfinder_stuck' })
        finish({ status: 'failed', code: 'stuck' }, true)
      }
      const onPathUpdate = (result: PartiallyComputedPath) => {
        if (result.status === 'noPath') {
          finish({ status: 'failed', code: 'no_path' }, true)
        } else if (result.status === 'timeout') {
          finish({ status: 'failed', code: 'path_timeout' }, true)
        }
      }
      const onPathStop = () => {
        if (settled) return
        if (signal.aborted) {
          finish({ status: 'cancelled', code: abortCode(signal) }, false)
        } else if (this.operatorDisconnect) {
          finish({ status: 'failed', code: 'disconnected' }, false)
        } else if (stuck) {
          finish({ status: 'failed', code: 'stuck' }, false)
        } else {
          finish({ status: 'failed', code: 'path_stopped' }, false)
        }
      }
      const onEntityGone = (entity: typeof target) => {
        if (entity === target) {
          finish({ status: 'failed', code: 'player_lost' }, true)
        }
      }
      const onEnd = () => {
        finish({ status: 'failed', code: 'disconnected' }, false)
      }

      signal.addEventListener('abort', onAbort, { once: true })
      bot.on('path_reset', onPathReset)
      bot.on('path_update', onPathUpdate)
      bot.on('path_stop', onPathStop)
      bot.on('entityGone', onEntityGone)
      bot.on('end', onEnd)

      if (signal.aborted) {
        onAbort()
        return
      }

      try {
        runtime.pathfinder.setGoal(goal, true)
      } catch {
        finish({ status: 'failed', code: 'pathfinder_error' }, true)
      }
    })
  }

  async holdPosition(signal: AbortSignal): Promise<SkillResult> {
    const bot = this.readyBot()
    if (!bot) {
      return { status: 'failed', code: 'minecraft_not_ready' }
    }

    await this.stopMotion()
    if (signal.aborted) {
      return { status: 'cancelled', code: abortCode(signal) }
    }

    return new Promise<SkillResult>(resolve => {
      let settled = false

      const cleanup = () => {
        signal.removeEventListener('abort', onAbort)
        bot.off('end', onEnd)
      }
      const finish = (result: SkillResult) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      }
      const onAbort = () => {
        void this.stopMotion()
        finish({ status: 'cancelled', code: abortCode(signal) })
      }
      const onEnd = () => {
        finish({ status: 'failed', code: 'disconnected' })
      }

      signal.addEventListener('abort', onAbort, { once: true })
      bot.on('end', onEnd)
      if (signal.aborted) {
        onAbort()
      }
    })
  }

  async stopMotion(): Promise<void> {
    const bot = this.bot
    if (!bot) return

    if (this.navigationBot === bot) {
      const runtimePathfinder = runtimePathfinderOf(bot)
      if (runtimePathfinder) {
        runtimePathfinder.stop()
        return
      }
    }

    bot.clearControlStates()
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
    this.lastPositionCell = null
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
      this.spawnedBots.add(bot)
      this.attachInventoryListener(bot)
      this.lastPositionCell = positionCell(bot.entity.position)
      this.emit(this.bridge.spawned(bot))
    })

    bot.on('move', () => {
      if (this.bot !== bot || !this.spawnedBots.has(bot)) return
      const cell = positionCell(bot.entity.position)
      if (cell === this.lastPositionCell) return
      this.lastPositionCell = cell
      this.emit({
        type: 'position_changed',
        at: this.now(),
        position: {
          x: bot.entity.position.x,
          y: bot.entity.position.y,
          z: bot.entity.position.z
        }
      })
    })

    bot.on('playerJoined', player => {
      if (this.bot !== bot) return
      this.emitPlayerIfPositioned(player)
    })

    bot.on('playerUpdated', player => {
      if (this.bot !== bot) return
      this.emitPlayerIfPositioned(player)
    })

    bot.on('playerLeft', player => {
      if (this.bot !== bot || player.username === bot.username) return
      this.emit(this.bridge.playerLeft(player.username, player.uuid))
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
      const playerId = bot.players[username]?.uuid?.trim()
      this.emit(this.bridge.chat(username, message, playerId || undefined))
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
      if (this.navigationBot === bot) {
        this.navigationBot = null
        this.navigationMovements = null
      }
      this.lastPositionCell = null
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

  private readyBot(): Bot | null {
    const bot = this.bot
    return bot && this.spawnedBots.has(bot) ? bot : null
  }

  private ensureNavigation(bot: Bot): { pathfinder: RuntimePathfinder; movements: Movements } {
    if (this.navigationBot === bot && this.navigationMovements) {
      const existingPathfinder = runtimePathfinderOf(bot)
      if (!existingPathfinder) {
        throw new Error('pathfinder disappeared after initialization')
      }
      this.applyPathfinderBudgets(existingPathfinder)
      this.hardenMovements(this.navigationMovements)
      return { pathfinder: existingPathfinder, movements: this.navigationMovements }
    }

    this.loadPathfinder(bot)
    const runtimePathfinder = runtimePathfinderOf(bot)
    if (!runtimePathfinder) {
      throw new Error('pathfinder plugin did not initialize')
    }

    const movements = this.createMovements(bot)
    this.applyPathfinderBudgets(runtimePathfinder)
    this.hardenMovements(movements)
    runtimePathfinder.setMovements(movements)
    this.navigationBot = bot
    this.navigationMovements = movements
    return { pathfinder: runtimePathfinder, movements }
  }

  private applyPathfinderBudgets(runtimePathfinder: RuntimePathfinder): void {
    runtimePathfinder.thinkTimeout = 3000
    runtimePathfinder.tickTimeout = 25
    runtimePathfinder.searchRadius = 96
  }

  private hardenMovements(movements: Movements): void {
    movements.canDig = false
    movements.scafoldingBlocks = []
    movements.allow1by1towers = false
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

function positionCell(position: Position): string {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
}

function runtimePathfinderOf(bot: Bot): RuntimePathfinder | null {
  const candidate = (bot as Bot & { pathfinder?: Pathfinder }).pathfinder
  return candidate ? (candidate as RuntimePathfinder) : null
}

function mapPathfinderFailure(
  error: unknown,
  signal: AbortSignal,
  stuck: boolean,
  disconnecting = false
): SkillResult {
  if (signal.aborted) {
    return { status: 'cancelled', code: abortCode(signal) }
  }
  if (disconnecting) {
    return { status: 'failed', code: 'disconnected' }
  }
  if (stuck) {
    return { status: 'failed', code: 'stuck' }
  }

  const name = error instanceof Error ? error.name : ''
  switch (name) {
    case 'NoPath':
      return { status: 'failed', code: 'no_path' }
    case 'Timeout':
      return { status: 'failed', code: 'path_timeout' }
    case 'GoalChanged':
      return { status: 'failed', code: 'goal_changed' }
    case 'PathStopped':
      return { status: 'failed', code: 'path_stopped' }
    default:
      return { status: 'failed', code: 'pathfinder_error' }
  }
}

function abortCode(signal: AbortSignal): string {
  const reason = typeof signal.reason === 'string' ? signal.reason : ''
  const normalized = reason.trim().replace(/\s+/g, '_').slice(0, 128)
  return normalized || 'cancelled'
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
