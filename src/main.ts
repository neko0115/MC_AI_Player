import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AiConfig, MinecraftConfig } from './config.js'
import {
  loadAiConfig,
  loadControlApiConfig,
  loadMinecraftConfig
} from './config.js'
import type { RuntimeEvent } from './contracts/events.js'
import type { DecisionContext } from './agent/context-builder.js'
import type { LogicalDecisionExecutor } from './agent/routing/contracts.js'
import type { DecisionProvider } from './agent/provider.js'
import {
  assertGameplayProviderCapabilities
} from './agent/provider.js'
import { FakeDecisionProvider } from './agent/fake-provider.js'
import {
  ControlServer,
  type ControlServerAddress,
  type ControlServerOptions
} from './api/control-server.js'
import { GoalManager } from './goals/goal-manager.js'
import type { MinecraftMemoryRepository } from './memory/repository.js'
import { SqliteMemoryRepository } from './memory/sqlite-repository.js'
import {
  createMineflayerRuntimeBundle,
  type MineflayerRuntimeBundle
} from './minecraft/runtime-bundle.js'
import { wireGoalExecution } from './runtime/goal-execution-loop.js'
import { SafetyPolicy } from './safety/policy.js'
import { GatherResourceSkill, FindResourceSkill, RegionProtectionPolicy } from './skills/gathering.js'
import { createNavigationSkills } from './skills/navigation.js'
import { EatSkill, EquipSkill } from './skills/survival.js'
import { SkillExecutor } from './skills/executor.js'
import { SkillRegistry } from './skills/registry.js'
import { WorldStateCache } from './state/world-state-cache.js'
import { RuntimeEventBus } from './telemetry/event-bus.js'
import { JsonlEventRecorder } from './telemetry/recorder.js'

const DEFAULT_MEMORY_PATH = 'data/mc_memory.sqlite3'
const DEFAULT_EVENT_LOG_PATH = 'data/runtime-events.jsonl'
const DEFAULT_EVENT_LOG_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_RECENT_EVENT_LIMIT = 20

const PREFERRED_FOOD = [
  'bread',
  'cooked_beef',
  'cooked_porkchop',
  'baked_potato',
  'cooked_chicken',
  'cooked_mutton',
  'cooked_cod',
  'cooked_salmon',
  'carrot',
  'apple'
] as const

const EXCLUDED_FOOD = [
  'enchanted_golden_apple',
  'golden_apple',
  'chorus_fruit',
  'pufferfish',
  'spider_eye',
  'poisonous_potato',
  'rotten_flesh',
  'suspicious_stew'
] as const

export interface FakeDecisionStackOptions {
  readonly provider: DecisionProvider<DecisionContext>
}

export function createFakeDecisionStack(
  options: FakeDecisionStackOptions
): LogicalDecisionExecutor {
  assertGameplayProviderCapabilities(options.provider)
  return {
    async execute(request, signal) {
      if (signal.aborted) return { kind: 'cancelled' }
      const providerResult = await options.provider.decide({
        context: request.context
      })
      if (signal.aborted) return { kind: 'cancelled' }
      return { kind: 'success', providerResult }
    }
  }
}

export interface ApplicationRecorderPort {
  record(event: RuntimeEvent): Promise<unknown>
}

export interface ApplicationControlServerPort {
  start(): Promise<ControlServerAddress>
  close(): Promise<void>
}

export interface ApplicationDependencies {
  readonly createRuntime?: (config: MinecraftConfig) => MineflayerRuntimeBundle
  readonly createMemory?: (filename: string) => MinecraftMemoryRepository
  readonly createRecorder?: (filename: string) => ApplicationRecorderPort
  readonly createDecisionProvider?: (config: AiConfig) => DecisionProvider
  readonly createControlServer?: (options: ControlServerOptions) => ApplicationControlServerPort
}

export interface McAiPlayerApplication {
  start(): Promise<ControlServerAddress>
  close(): Promise<void>
}

export function createApplication(
  env: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: ApplicationDependencies = {}
): McAiPlayerApplication {
  const minecraftConfig = loadMinecraftConfig(env)
  const aiConfig = loadAiConfig(env)
  const controlConfig = loadControlApiConfig(env)

  const createDecisionProvider = dependencies.createDecisionProvider ?? createDefaultDecisionProvider
  const decisionProvider = createDecisionProvider(aiConfig)
  assertGameplayProviderCapabilities(decisionProvider)

  const events = new RuntimeEventBus()
  const state = new WorldStateCache({ maxRecentEvents: DEFAULT_RECENT_EVENT_LIMIT })
  const memory = (dependencies.createMemory ?? createDefaultMemory)(DEFAULT_MEMORY_PATH)
  const recorder = (dependencies.createRecorder ?? createDefaultRecorder)(DEFAULT_EVENT_LOG_PATH)
  const runtime = (dependencies.createRuntime ?? createMineflayerRuntimeBundle)(minecraftConfig)
  const safety = new SafetyPolicy()

  const registry = new SkillRegistry()
  registerProductionSkills(registry, runtime, safety, state, events)
  const executor = new SkillExecutor(registry, { events })
  const goals = new GoalManager({ skillController: executor, events })
  const executionBinding = wireGoalExecution({ events, goals, executor })

  let recorderTail: Promise<void> = Promise.resolve()
  events.subscribe(event => {
    state.apply(event)
    recorderTail = recorderTail
      .then(async () => {
        await recorder.record(event)
      })
      .catch(() => {
        // Recording failures are contained by the telemetry boundary and must
        // never stop gameplay or leak arbitrary error details.
      })
  })

  let adapterEventTail: Promise<void> = Promise.resolve()
  const unsubscribeAdapter = runtime.adapter.onEvent(event => {
    const next = structuredClone(event)
    adapterEventTail = adapterEventTail
      .then(() => events.publish(next))
      .catch(() => {
        // Adapter event delivery failures are isolated from Mineflayer's
        // callback stack. Later validated events may continue to flow.
      })
  })

  const createControlServer = dependencies.createControlServer ?? (options => new ControlServer(options))
  const controlServer = createControlServer({
    host: controlConfig.host,
    port: controlConfig.port,
    ...(controlConfig.bearerToken === undefined
      ? {}
      : { bearerToken: controlConfig.bearerToken }),
    maxBodyBytes: controlConfig.maxBodyBytes,
    goals,
    state,
    memory,
    events
  })

  let started = false
  let closed = false

  return {
    async start(): Promise<ControlServerAddress> {
      if (closed) throw new Error('application is closed')
      if (started) throw new Error('application is already started')

      await runtime.adapter.connect()
      try {
        const address = await controlServer.start()
        started = true
        return address
      } catch (error) {
        await safeDisconnect(runtime)
        await adapterEventTail
        throw error
      }
    },

    async close(): Promise<void> {
      if (closed) return
      closed = true

      await contain(() => controlServer.close())
      await contain(() => goals.emergencyStop('application_shutdown'))
      executionBinding.dispose()
      await contain(() => runtime.adapter.disconnect())
      await adapterEventTail
      unsubscribeAdapter()
      await recorderTail
      memory.close()
      started = false
    }
  }
}

function registerProductionSkills(
  registry: SkillRegistry,
  runtime: MineflayerRuntimeBundle,
  safety: SafetyPolicy,
  state: WorldStateCache,
  events: RuntimeEventBus
): void {
  const navigation = createNavigationSkills(runtime.adapter)
  registry.register(navigation.goTo)
  registry.register(navigation.followPlayer)
  registry.register(navigation.stay)
  registry.register(navigation.stop)

  registry.register(new EatSkill(runtime.inventory, {
    preferredFood: PREFERRED_FOOD,
    excludedItems: EXCLUDED_FOOD
  }))
  registry.register(new EquipSkill(runtime.inventory))

  const protection = new RegionProtectionPolicy([])
  registry.register(new FindResourceSkill(runtime.gathering, protection))
  registry.register(new GatherResourceSkill({
    resources: runtime.gathering,
    navigation: runtime.adapter,
    safety,
    state: () => state.snapshot(),
    protection,
    onCooperativePickup: notice => {
      void events.publish({
        type: 'cooperative_pickup',
        at: Date.now(),
        resource: notice.resource,
        player: notice.player,
        interceptedCount: notice.interceptedCount,
        remaining: notice.remaining
      }).catch(() => {
        // Cooperative telemetry is advisory and must never stop gameplay.
      })
    }
  }))
}

function createDefaultMemory(filename: string): MinecraftMemoryRepository {
  ensureParentDirectory(filename)
  return new SqliteMemoryRepository(filename)
}

function createDefaultRecorder(filename: string): ApplicationRecorderPort {
  ensureParentDirectory(filename)
  return new JsonlEventRecorder(filename, {
    maxFileBytes: DEFAULT_EVENT_LOG_MAX_BYTES,
    logger: {
      error(message: unknown) {
        console.error(typeof message === 'string' ? message : 'Failed to record runtime event')
      }
    }
  })
}

function ensureParentDirectory(filename: string): void {
  mkdirSync(dirname(resolve(filename)), { recursive: true })
}

function createDefaultDecisionProvider(config: AiConfig): DecisionProvider<DecisionContext> {
  if (config.provider === 'fake') {
    return new FakeDecisionProvider<DecisionContext>([])
  }

  // Transitional fail-closed seam. Task 16 replaces this legacy provider
  // factory with the approved routed Gemini decision stack.
  throw new Error('Gemini multi-model routing is not wired through the legacy DecisionProvider factory')
}

async function safeDisconnect(runtime: MineflayerRuntimeBundle): Promise<void> {
  await contain(() => runtime.adapter.disconnect())
}

async function contain(operation: () => Promise<void>): Promise<void> {
  try {
    await operation()
  } catch {
    // Shutdown/rollback is best-effort and intentionally does not echo raw
    // dependency exceptions into process output.
  }
}

export async function runMain(
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<McAiPlayerApplication> {
  const application = createApplication(env)
  const address = await application.start()
  console.log(`MC_AI_Player control API listening on ${address.baseUrl}`)

  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    void application.close().catch(() => {
      process.exitCode = 1
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  return application
}

function isEntrypoint(): boolean {
  const script = process.argv[1]
  if (!script) return false
  return import.meta.url === pathToFileURL(resolve(script)).href
}

if (isEntrypoint()) {
  void runMain().catch(() => {
    console.error('MC_AI_Player failed to start')
    process.exitCode = 1
  })
}
