import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  AiConfig,
  MinecraftConfig,
  MoxueBridgeConfig
} from './config.js'
import {
  loadAdminApiConfig,
  loadAiConfig,
  loadControlApiConfig,
  loadMinecraftConfig,
  loadMinecraftServerIdentityMode,
  loadMoxueBridgeConfig,
  loadTreeLeafCleanupSetting
} from './config.js'
import type { RuntimeEvent } from './contracts/events.js'
import { ContextBuilder, type DecisionContext } from './agent/context-builder.js'
import { DecisionGate } from './agent/decision-gate.js'
import { GeminiTransport } from './agent/providers/gemini.js'
import { RoutingConfigManager } from './agent/routing/config-manager.js'
import type { LogicalDecisionExecutor } from './agent/routing/contracts.js'
import { ProjectPool } from './agent/routing/project-pool.js'
import { SqliteQuotaLedger } from './agent/routing/quota-ledger.js'
import { RoutedDecisionExecutor } from './agent/routing/routed-executor.js'
import type { DecisionProvider } from './agent/provider.js'
import { assertGameplayProviderCapabilities } from './agent/provider.js'
import { FakeDecisionProvider } from './agent/fake-provider.js'
import {
  AdminServer,
  type AdminServerAddress,
  type AdminServerOptions
} from './api/admin-server.js'
import {
  ControlServer,
  type ControlAiStatusPort,
  type ControlCapabilityStatusPort,
  type ControlServerAddress,
  type ControlServerOptions
} from './api/control-server.js'
import { GoalManager } from './goals/goal-manager.js'
import type { MinecraftMemoryRepository } from './memory/repository.js'
import { SqliteMemoryRepository } from './memory/sqlite-repository.js'
import { MinecraftIdentityRegistry } from './minecraft/identity-registry.js'
import {
  MoxueBridgeCapabilities,
  type ServerCapabilityStatusSource
} from './minecraft/moxuebridge-capabilities.js'
import {
  MoxueBridgeResourceCatalog,
  type ServerResourceCatalogSource
} from './minecraft/moxuebridge-resources.js'
import {
  createMineflayerRuntimeBundle,
  type MineflayerRuntimeBundle
} from './minecraft/runtime-bundle.js'
import { createBuiltinSkillModules } from './modules/builtin-skills.js'
import { installSkillModules } from './modules/skill-module.js'
import { DecisionCoordinator } from './runtime/decision-coordinator.js'
import { ThreatSupervisor } from './runtime/threat-supervisor.js'
import { wireGoalExecution } from './runtime/goal-execution-loop.js'
import { SafetyPolicy } from './safety/policy.js'
import { SkillExecutor } from './skills/executor.js'
import { SkillRegistry } from './skills/registry.js'
import { WorldStateCache } from './state/world-state-cache.js'
import { RuntimeEventBus } from './telemetry/event-bus.js'
import { JsonlEventRecorder } from './telemetry/recorder.js'

const DEFAULT_MEMORY_PATH = 'data/mc_memory.sqlite3'
const DEFAULT_QUOTA_PATH = 'data/ai-quota.sqlite3'
const DEFAULT_EVENT_LOG_PATH = 'data/runtime-events.jsonl'
const DEFAULT_EVENT_LOG_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_RECENT_EVENT_LIMIT = 20
const DENY_ALL_MANUAL_ACCESS = Object.freeze({
  ownerUuid: '00000000000000000000000000000000',
  operatorAllowlistUuids: Object.freeze([] as string[])
})
const DECISION_SAFETY_CONSTRAINTS = Object.freeze([
  'PvP is disabled.',
  'Generic navigation cannot dig or build.',
  'Only scoped gather/excavation skills may mutate blocks.',
  'Only registered high-level skills may reach deterministic gameplay execution.',
  'SafetyPolicy remains authoritative after every model decision.'
])

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
      const providerResult = await options.provider.decide({ context: request.context })
      if (signal.aborted) return { kind: 'cancelled' }
      return { kind: 'success', providerResult }
    }
  }
}

export interface GeminiDecisionStackOptions {
  readonly routingConfigPath: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly quotaFilename: string
  readonly processInstanceId: string
  readonly events: RuntimeEventBus
  readonly now?: () => number
}

export interface GeminiDecisionStack {
  readonly executor: LogicalDecisionExecutor
  readonly configManager: RoutingConfigManager
  readonly quotaLedger: SqliteQuotaLedger
  close(): void
}

export function createGeminiDecisionStack(
  options: GeminiDecisionStackOptions
): GeminiDecisionStack {
  ensureParentDirectory(options.quotaFilename)
  const quotaLedger = new SqliteQuotaLedger(options.quotaFilename)
  const now = options.now ?? Date.now

  try {
    const configManager = new RoutingConfigManager({
      ledger: quotaLedger,
      env: options.env,
      routingConfigPath: options.routingConfigPath
    })
    configManager.activateInitial()
    quotaLedger.recoverIncompleteAttempts(now())

    const pool = new ProjectPool({
      config: configManager,
      ledger: quotaLedger,
      processInstanceId: options.processInstanceId,
      now
    })
    const transport = new GeminiTransport({
      resolveCredential: handle => configManager.resolveCredential(handle)
    })
    const executor = new RoutedDecisionExecutor({
      pool,
      ledger: quotaLedger,
      transport,
      processInstanceId: options.processInstanceId,
      events: options.events,
      now
    })

    return {
      executor,
      configManager,
      quotaLedger,
      close() {
        quotaLedger.close()
      }
    }
  } catch (error) {
    quotaLedger.close()
    throw error
  }
}

export interface ApplicationRecorderPort {
  record(event: RuntimeEvent): Promise<unknown>
}

export interface ApplicationControlServerPort {
  start(): Promise<ControlServerAddress>
  close(): Promise<void>
}

export interface ApplicationAdminServerPort {
  start(): Promise<AdminServerAddress>
  close(): Promise<void>
}

export interface ApplicationServerCapabilitiesPort extends ServerCapabilityStatusSource {
  start(): Promise<void>
  stop(): void
}

export interface ApplicationResourceProfilesPort extends ServerResourceCatalogSource {
  start(): Promise<void>
  stop(): void
}

export interface ApplicationGeminiDecisionStackPort {
  readonly executor: LogicalDecisionExecutor
  readonly configManager: Pick<RoutingConfigManager, 'snapshot' | 'reload'>
  readonly quotaLedger: Pick<SqliteQuotaLedger, 'adminSnapshot'>
  close(): void
}

export interface ApplicationDependencies {
  readonly createRuntime?: (config: MinecraftConfig) => MineflayerRuntimeBundle
  readonly createServerCapabilities?: (
    config: Extract<MoxueBridgeConfig, { enabled: true }>
  ) => ApplicationServerCapabilitiesPort
  readonly createResourceProfiles?: (
    config: Extract<MoxueBridgeConfig, { enabled: true }>
  ) => ApplicationResourceProfilesPort
  readonly createMemory?: (filename: string) => MinecraftMemoryRepository
  readonly createRecorder?: (filename: string) => ApplicationRecorderPort
  readonly createLogicalDecisionExecutor?: (
    config: AiConfig,
    events: RuntimeEventBus
  ) => LogicalDecisionExecutor
  readonly createGeminiDecisionStack?: (
    options: GeminiDecisionStackOptions
  ) => ApplicationGeminiDecisionStackPort
  readonly createControlServer?: (options: ControlServerOptions) => ApplicationControlServerPort
  readonly createAdminServer?: (options: AdminServerOptions) => ApplicationAdminServerPort
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
  const adminConfig = loadAdminApiConfig(env)
  const identityMode = loadMinecraftServerIdentityMode(env)
  const moxueBridgeConfig = loadMoxueBridgeConfig(env)
  const treeLeafCleanupSetting = loadTreeLeafCleanupSetting(env)

  const events = new RuntimeEventBus()
  const state = new WorldStateCache({ maxRecentEvents: DEFAULT_RECENT_EVENT_LIMIT })
  const memory = (dependencies.createMemory ?? createDefaultMemory)(DEFAULT_MEMORY_PATH)
  const recorder = (dependencies.createRecorder ?? createDefaultRecorder)(DEFAULT_EVENT_LOG_PATH)
  const runtime = (dependencies.createRuntime ?? createMineflayerRuntimeBundle)(minecraftConfig)
  const safety = new SafetyPolicy()
  const createServerCapabilities =
    dependencies.createServerCapabilities ?? createDefaultServerCapabilities
  const serverCapabilities = moxueBridgeConfig.enabled
    ? createServerCapabilities(moxueBridgeConfig)
    : null
  const createResourceProfiles =
    dependencies.createResourceProfiles ?? createDefaultResourceProfiles
  const resourceProfiles = moxueBridgeConfig.enabled
    ? createResourceProfiles(moxueBridgeConfig)
    : null

  const registry = new SkillRegistry()
  installSkillModules(
    registry,
    createBuiltinSkillModules({
      runtime,
      safety,
      state,
      events,
      memory,
      minecraftConfig,
      ...(serverCapabilities ? { serverCapabilities } : {}),
      ...(resourceProfiles ? { resourceProfiles } : {}),
      treeLeafCleanupSetting
    })
  )
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

  const threatSupervisor = new ThreatSupervisor({
    events,
    state,
    goals,
    navigation: runtime.adapter
  })
  threatSupervisor.start()

  let geminiStack: ApplicationGeminiDecisionStackPort | null = null
  let logicalExecutor: LogicalDecisionExecutor
  if (dependencies.createLogicalDecisionExecutor) {
    logicalExecutor = dependencies.createLogicalDecisionExecutor(aiConfig, events)
  } else if (aiConfig.provider === 'fake') {
    logicalExecutor = createFakeDecisionStack({
      provider: new FakeDecisionProvider<DecisionContext>([])
    })
  } else {
    const createStack = dependencies.createGeminiDecisionStack ?? createGeminiDecisionStack
    geminiStack = createStack({
      routingConfigPath: aiConfig.routingConfigPath,
      env,
      quotaFilename: DEFAULT_QUOTA_PATH,
      processInstanceId: randomUUID(),
      events
    })
    logicalExecutor = geminiStack.executor
  }

  const manualAccess = geminiStack?.configManager.snapshot().manualAccess
    ?? DENY_ALL_MANUAL_ACCESS
  const identity = new MinecraftIdentityRegistry()
  const coordinator = new DecisionCoordinator({
    events,
    state,
    goals,
    memory,
    registry,
    ...(serverCapabilities ? { serverCapabilities } : {}),
    ...(resourceProfiles ? { serverResources: resourceProfiles } : {}),
    identity,
    identityMode,
    manualAccess,
    worldKey: `${minecraftConfig.host}:${minecraftConfig.port}`,
    botUsername: minecraftConfig.username,
    logicalExecutor,
    decisionGate: new DecisionGate({ safety, events }),
    contextBuilder: new ContextBuilder(),
    safetyConstraints: DECISION_SAFETY_CONSTRAINTS,
    nextTaskId: randomUUID,
    nextDecisionId: randomUUID
  })
  coordinator.start()

  let activeProject: string | null = null
  const unsubscribeAiStatusEvents = geminiStack
    ? events.subscribe(event => {
        if (event.type === 'model_route') activeProject = event.project
      })
    : null
  const aiStatus: ControlAiStatusPort | undefined = geminiStack
    ? createControlAiStatus({
        stack: geminiStack,
        coordinator,
        goals,
        adminEnabled: adminConfig.enabled,
        activeProject: () => activeProject
      })
    : undefined

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

  const capabilityStatus: ControlCapabilityStatusPort | undefined = serverCapabilities
    ? createControlCapabilityStatus(serverCapabilities)
    : undefined
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
    events,
    ...(aiStatus ? { aiStatus } : {}),
    ...(capabilityStatus ? { capabilityStatus } : {})
  })

  const createAdminServer = dependencies.createAdminServer ?? (options => new AdminServer(options))
  const adminServer = adminConfig.enabled && geminiStack
    ? createAdminServer({
        port: adminConfig.port,
        bearerToken: adminConfig.bearerToken,
        quota: geminiStack.quotaLedger,
        routing: geminiStack.configManager,
        coordinator
      })
    : null

  let started = false
  let closed = false

  return {
    async start(): Promise<ControlServerAddress> {
      if (closed) throw new Error('application is closed')
      if (started) throw new Error('application is already started')

      await serverCapabilities?.start()
      await resourceProfiles?.start()
      try {
        await runtime.adapter.connect()
        const address = await controlServer.start()
        try {
          await adminServer?.start()
        } catch (error) {
          await contain(() => controlServer.close())
          throw error
        }
        started = true
        return address
      } catch (error) {
        await safeDisconnect(runtime)
        await adapterEventTail
        resourceProfiles?.stop()
        serverCapabilities?.stop()
        throw error
      }
    },

    async close(): Promise<void> {
      if (closed) return
      closed = true

      threatSupervisor.dispose()
      resourceProfiles?.stop()
      serverCapabilities?.stop()
      if (adminServer) await contain(() => adminServer.close())
      await contain(() => controlServer.close())
      await contain(() => coordinator.clearAiWork('application_shutdown'))
      coordinator.dispose()
      unsubscribeAiStatusEvents?.()
      await contain(() => goals.emergencyStop('application_shutdown'))
      executionBinding.dispose()
      await contain(() => runtime.adapter.disconnect())
      await adapterEventTail
      unsubscribeAdapter()
      await recorderTail
      geminiStack?.close()
      memory.close()
      started = false
    }
  }
}


function createControlCapabilityStatus(
  source: ServerCapabilityStatusSource
): ControlCapabilityStatusPort {
  return {
    snapshot() {
      const capabilities = source.snapshot()
      return {
        state: source.status().state,
        ids: capabilities.map(capability => capability.id),
        details: capabilities.map(capability => ({
          id: capability.id,
          trigger: capability.usage.trigger,
          constraints: capability.constraints
        }))
      }
    }
  }
}

function createControlAiStatus(options: {
  readonly stack: ApplicationGeminiDecisionStackPort
  readonly coordinator: DecisionCoordinator
  readonly goals: GoalManager
  readonly adminEnabled: boolean
  readonly activeProject: () => string | null
}): ControlAiStatusPort {
  return {
    snapshot() {
      const routing = options.stack.configManager.snapshot()
      const coordinator = options.coordinator.status()
      const goal = coordinator.activeGoalId
        ? options.goals.getGoal(coordinator.activeGoalId)
        : undefined
      return {
        routineModel: routing.models.routine.name,
        complexModel: routing.models.complex.name,
        available: coordinator.aiAvailability === 'available',
        activeProject: options.activeProject(),
        flashAutoUsedPct: calculateFlashAutoUsedPct(
          routing.models.complex.name,
          routing.projects,
          options.stack.quotaLedger.adminSnapshot(Date.now())
        ),
        manualDeepThinkAvailable:
          options.adminEnabled ||
          routing.manualAccess.ownerUuid.length > 0 ||
          routing.manualAccess.operatorAllowlistUuids.length > 0,
        coordinatorState: coordinator.coordinatorState,
        activeTaskId: coordinator.activeTaskId,
        activeGoalKind: goal?.request.kind ?? null,
        pendingTaskCount: coordinator.pendingTaskCount,
        decisionInFlight: coordinator.decisionInFlight
      }
    }
  }
}

function calculateFlashAutoUsedPct(
  complexModel: string,
  projects: ReturnType<ApplicationGeminiDecisionStackPort['configManager']['snapshot']>['projects'],
  quotaProjects: ReturnType<ApplicationGeminiDecisionStackPort['quotaLedger']['adminSnapshot']>
): number {
  let maximum = 0
  for (const project of projects) {
    const quota = quotaProjects.find(candidate => candidate.projectKey === project.projectKey)
    const domain = quota?.domains.find(candidate => candidate.model === complexModel)
    if (!domain) continue

    const requestCeiling = Math.floor(project.flashBudget.requestLimit * 0.70)
    const tokenCeiling = Math.floor(project.flashBudget.totalTokenLimit * 0.70)
    const requestRatio = requestCeiling > 0 ? domain.normalRequests / requestCeiling : 1
    const tokenRatio = tokenCeiling > 0 ? domain.normalTotalTokens / tokenCeiling : 1
    maximum = Math.max(maximum, requestRatio, tokenRatio)
  }
  return Math.max(0, Math.min(100, Math.round(maximum * 100)))
}


function createDefaultServerCapabilities(
  config: Extract<MoxueBridgeConfig, { enabled: true }>
): ApplicationServerCapabilitiesPort {
  return new MoxueBridgeCapabilities({
    baseUrl: config.baseUrl,
    bearerToken: config.bearerToken,
    timeoutMs: config.timeoutMs,
    refreshIntervalMs: config.refreshIntervalMs
  })
}

function createDefaultResourceProfiles(
  config: Extract<MoxueBridgeConfig, { enabled: true }>
): ApplicationResourceProfilesPort {
  return new MoxueBridgeResourceCatalog({
    baseUrl: config.baseUrl,
    bearerToken: config.bearerToken,
    timeoutMs: config.timeoutMs,
    refreshIntervalMs: config.refreshIntervalMs
  })
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
