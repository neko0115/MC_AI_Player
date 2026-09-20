import assert from 'node:assert/strict'
import test from 'node:test'
import type { MinecraftConfig } from '../src/config.js'
import type { Position, RuntimeEvent } from '../src/contracts/events.js'
import type { SkillResult } from '../src/contracts/skills.js'
import type { MinecraftAdapter, NavigationOptions } from '../src/minecraft/adapter.js'
import type { MineflayerRuntimeBundle } from '../src/minecraft/runtime-bundle.js'
import type { MinecraftMemoryRepository, MemorySearchQuery, MinecraftMemory } from '../src/memory/repository.js'
import {
  SqliteWorkspaceRepository
} from '../src/workspace/sqlite-repository.js'
import type { ProviderCapabilities, DecisionProvider } from '../src/agent/provider.js'
import type {
  LogicalDecisionExecutor,
  LogicalDecisionRequest,
  LogicalDecisionResult
} from '../src/agent/routing/contracts.js'
import type { ControlServerOptions, ControlServerAddress } from '../src/api/control-server.js'
import {
  createApplication,
  createFakeDecisionStack,
  type ApplicationResourceProfilesPort,
  type ApplicationServerCapabilitiesPort,
  type ApplicationWorkspaceSelectionsPort
} from '../src/main.js'

class FakeAdapter implements MinecraftAdapter {
  readonly calls: string[]
  private readonly listeners = new Set<(event: RuntimeEvent) => void>()
  holdSignal: AbortSignal | null = null
  holdStarted = 0

  constructor(calls: string[]) {
    this.calls = calls
  }

  async connect(): Promise<void> {
    this.calls.push('adapter.connect')
  }

  async disconnect(): Promise<void> {
    this.calls.push('adapter.disconnect')
    this.emit({ type: 'disconnected', at: 99, reason: 'test shutdown' })
  }

  async goTo(_position: Position, _options: NavigationOptions, _signal: AbortSignal): Promise<SkillResult> {
    return { status: 'succeeded', code: 'arrived' }
  }

  async followPlayer(_player: string, _range: number, _signal: AbortSignal): Promise<SkillResult> {
    return { status: 'succeeded', code: 'following' }
  }

  async holdPosition(signal: AbortSignal): Promise<SkillResult> {
    this.holdStarted += 1
    this.holdSignal = signal
    if (signal.aborted) return { status: 'cancelled', code: 'cancelled' }
    return new Promise(resolve => {
      signal.addEventListener('abort', () => {
        resolve({ status: 'cancelled', code: 'cancelled' })
      }, { once: true })
    })
  }

  async stopMotion(): Promise<void> {
    this.calls.push('adapter.stopMotion')
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: RuntimeEvent): void {
    for (const listener of [...this.listeners]) listener(structuredClone(event))
  }
}

class FakeMemory implements MinecraftMemoryRepository {
  readonly calls: string[]
  constructor(calls: string[]) {
    this.calls = calls
  }
  remember(): MinecraftMemory {
    throw new Error('not used')
  }
  search(_query: MemorySearchQuery): MinecraftMemory[] {
    return []
  }
  forget(): boolean {
    return false
  }
  close(): void {
    this.calls.push('memory.close')
  }
}

class FakeRecorder {
  readonly started: string[] = []
  readonly finished: string[] = []
  private firstRelease: (() => void) | null = null

  async record(event: RuntimeEvent): Promise<{ ok: true }> {
    this.started.push(event.type)
    if (event.type === 'connected' && this.firstRelease === null) {
      await new Promise<void>(resolve => {
        this.firstRelease = resolve
      })
    }
    this.finished.push(event.type)
    return { ok: true }
  }

  releaseFirst(): void {
    this.firstRelease?.()
  }
}

class FakeControlServer {
  readonly calls: string[]
  constructor(
    calls: string[],
    readonly options: ControlServerOptions
  ) {
    this.calls = calls
  }

  async start(): Promise<ControlServerAddress> {
    this.calls.push('control.start')
    return { host: '127.0.0.1', port: 8766, baseUrl: 'http://127.0.0.1:8766' }
  }

  async close(): Promise<void> {
    this.calls.push('control.close')
  }
}


class FakeResourceProfiles implements ApplicationResourceProfilesPort {
  constructor(private readonly calls: string[]) {}

  async start(): Promise<void> {
    this.calls.push('resources.start')
  }

  stop(): void {
    this.calls.push('resources.stop')
  }

  resolve() {
    return undefined
  }

  snapshot() {
    return [{
      id: 'examplemod:titanium_ore',
      kind: 'ore',
      aliases: ['examplemod:titanium'],
      blockIds: ['examplemod:titanium_ore'],
      collectedItemIds: ['examplemod:raw_titanium'],
      minimumDropCount: 1,
      toolKind: 'pickaxe',
      capabilityId: 'vein_mining',
      relatedLeaves: [],
      cleanupPolicy: null,
      confidence: 'authoritative' as const
    }]
  }
}

class FakeWorkspaceSelections implements ApplicationWorkspaceSelectionsPort {
  constructor(private readonly calls: string[]) {}

  async start(): Promise<void> {
    this.calls.push('workspace-selections.start')
  }

  stop(): void {
    this.calls.push('workspace-selections.stop')
  }

  latest(query: {
    worldKey: string
    dimension: string
    playerId: string
  }) {
    return {
      id: 'selection-live',
      generation: 2,
      worldKey: query.worldKey,
      dimension: query.dimension,
      playerId: query.playerId,
      playerName: 'Boss',
      pointA: { x: 1, y: 64, z: 2 },
      pointB: { x: 8, y: 64, z: 9 },
      selectedAt: 1200
    }
  }

  status() {
    return {
      state: 'current' as const,
      lastSuccessAt: 1234,
      lastErrorCode: null
    }
  }
}

class FakeServerCapabilities implements ApplicationServerCapabilitiesPort {
  constructor(private readonly calls: string[]) {}

  async start(): Promise<void> {
    this.calls.push('capabilities.start')
  }

  stop(): void {
    this.calls.push('capabilities.stop')
  }

  snapshot() {
    return [{
      id: 'vein_mining',
      name: '連鎖挖礦',
      description: '一次挖掘相連的礦物方塊',
      available: true,
      source: {
        plugin: 'VeinMiner',
        version: '2.11.2',
        provenance: 'integration'
      },
      usage: {
        trigger: 'sneak_and_break',
        human: '蹲下並使用正確的十字鎬挖掘相連礦物'
      },
      constraints: {
        max_chain: 100,
        correct_tool_required: true,
        must_sneak: true
      }
    }] as const
  }

  has(id: string): boolean {
    return id === 'vein_mining'
  }

  get(id: string) {
    return id === 'vein_mining' ? this.snapshot()[0] : undefined
  }

  status() {
    return {
      state: 'current' as const,
      lastSuccessAt: 1234,
      lastErrorCode: null
    }
  }
}

class RecordingLogicalExecutor implements LogicalDecisionExecutor {
  readonly requests: LogicalDecisionRequest[] = []
  readonly signals: AbortSignal[] = []

  async execute(
    request: LogicalDecisionRequest,
    signal: AbortSignal
  ): Promise<LogicalDecisionResult> {
    this.requests.push(structuredClone(request))
    this.signals.push(signal)
    return {
      kind: 'success',
      providerResult: {
        kind: 'structured',
        provider: 'fake-test',
        mode: 'function_call',
        value: { version: 2, outcome: 'complete' }
      }
    }
  }
}

function unsafeProvider(capabilities: ProviderCapabilities): DecisionProvider {
  return {
    capabilities,
    async decide() {
      return { kind: 'timeout', provider: 'unsafe-test' }
    }
  }
}

const logicalRequest = {
  context: {
    worldKey: 'test-world',
    currentGoal: null,
    self: {
      connected: true,
      spawned: true,
      health: 20,
      food: 20,
      dimension: 'overworld',
      position: { x: 0, y: 64, z: 0 }
    },
    nearbyPlayers: [],
    inventory: [],
    recentEvents: [],
    memories: [],
    skills: [],
    safetyConstraints: []
  },
  routePlan: {
    decisionId: 'decision-fake-1',
    policy: 'balanced-v1' as const,
    routeClass: 'routine' as const,
    thinking: 'low' as const,
    reserveAuthorized: false,
    reasons: [],
    highReason: null
  }
}

test('fake decision stack invokes one safe provider without routing infrastructure', async () => {
  let calls = 0
  const provider: DecisionProvider = {
    capabilities: { structuredFinal: true, reasoningSeparated: true },
    async decide() {
      calls += 1
      return { kind: 'timeout', provider: 'fake-test' }
    }
  }
  const executor = createFakeDecisionStack({ provider })

  const result = await executor.execute(logicalRequest, new AbortController().signal)

  assert.equal(calls, 1)
  assert.deepEqual(result, {
    kind: 'success',
    providerResult: { kind: 'timeout', provider: 'fake-test' }
  })
})

test('fake decision stack honours cancellation before provider invocation and keeps capability gate', async () => {
  let calls = 0
  const provider: DecisionProvider = {
    capabilities: { structuredFinal: true, reasoningSeparated: true },
    async decide() {
      calls += 1
      return { kind: 'timeout', provider: 'fake-test' }
    }
  }
  const executor = createFakeDecisionStack({ provider })
  const abort = new AbortController()
  abort.abort('cancelled')

  assert.deepEqual(await executor.execute(logicalRequest, abort.signal), { kind: 'cancelled' })
  assert.equal(calls, 0)
  assert.throws(
    () => createFakeDecisionStack({
      provider: unsafeProvider({ structuredFinal: false, reasoningSeparated: true })
    }),
    /structured final/i
  )
})

function environment(): NodeJS.ProcessEnv {
  return {
    MC_HOST: 'localhost',
    MC_PORT: '25565',
    MC_USERNAME: 'Moxue_Test',
    MC_AUTH: 'offline',
    MC_SERVER_IDENTITY_MODE: 'offline',
    MC_AI_PROVIDER: 'fake',
    MC_AI_ROUTING_CONFIG: 'data/this-file-must-not-be-read-in-fake-mode.json',
    MC_CONTROL_HOST: '127.0.0.1',
    MC_CONTROL_PORT: '8766'
  }
}

function harness(options: {
  readonly env?: NodeJS.ProcessEnv
  readonly serverCapabilities?: ApplicationServerCapabilitiesPort
  readonly resourceProfiles?: ApplicationResourceProfilesPort
  readonly workspaceSelections?: ApplicationWorkspaceSelectionsPort
} = {}) {
  const calls: string[] = []
  const adapter = new FakeAdapter(calls)
  const runtime: MineflayerRuntimeBundle = {
    adapter,
    inventory: {
      inventoryItems: () => [],
      async consumeInventoryItem() { return { status: 'failed', code: 'not_available' } },
      async equipInventoryItem() { return { status: 'failed', code: 'not_available' } },
      async transferContainerItem() { return { status: 'failed', code: 'not_available' } }
    },
    gathering: {
      currentPosition: () => null,
      inventoryCount: () => 0,
      async findResourceBlocks() { return [] },
      async harvestResourceBlock() { return { status: 'failed', code: 'not_available' } }
    }
  }
  const memory = new FakeMemory(calls)
  const recorder = new FakeRecorder()
  const logicalExecutor = new RecordingLogicalExecutor()
  let control: FakeControlServer | null = null
  const application = createApplication(options.env ?? environment(), {
    createRuntime: (_config: MinecraftConfig) => runtime,
    createMemory: () => memory,
    createWorkspaceRepository: () =>
      new SqliteWorkspaceRepository(
        ':memory:'
      ),
    createRecorder: () => recorder,
    createLogicalDecisionExecutor: () => logicalExecutor,
    ...(options.serverCapabilities
      ? { createServerCapabilities: () => options.serverCapabilities as ApplicationServerCapabilitiesPort }
      : {}),
    ...(options.resourceProfiles
      ? { createResourceProfiles: () => options.resourceProfiles as ApplicationResourceProfilesPort }
      : {}),
    ...(options.workspaceSelections
      ? {
          createWorkspaceSelections: () =>
            options.workspaceSelections as ApplicationWorkspaceSelectionsPort
        }
      : {}),
    createControlServer: options => {
      control = new FakeControlServer(calls, options)
      return control
    }
  })
  return {
    application,
    adapter,
    calls,
    memory,
    recorder,
    logicalExecutor,
    control: () => control
  }
}

test('creating the composition root has no connect or port-binding side effects', () => {
  const current = harness()
  assert.deepEqual(current.calls, [])
  assert.ok(current.control())
})

test('fake application ignores routing infrastructure and addressed chat reaches the shared logical executor', async () => {
  const current = harness()
  await current.application.start()
  try {
    current.adapter.emit({ type: 'connected', at: 1 })
    current.adapter.emit({
      type: 'spawned',
      at: 2,
      dimension: 'overworld',
      position: { x: 0, y: 64, z: 0 },
      health: 20,
      food: 20
    })
    current.adapter.emit({
      type: 'player_chat',
      at: 3,
      player: 'Boss',
      message: '墨雪 原地待命'
    })

    await waitFor(() => current.logicalExecutor.requests.length === 1)
    assert.equal(
      current.logicalExecutor.requests[0]?.context.task?.objective,
      '原地待命'
    )
  } finally {
    current.recorder.releaseFirst()
    await current.application.close()
  }
})


test('enabled MoxueBridge capability source participates in lifecycle and AI context', async () => {
  const calls: string[] = []
  const capabilities = new FakeServerCapabilities(calls)
  const resources = new FakeResourceProfiles(calls)
  const workspaceSelections =
    new FakeWorkspaceSelections(calls)
  const current = harness({
    env: {
      ...environment(),
      MC_MOXUEBRIDGE_BASE_URL: 'http://127.0.0.1:8766',
      MC_MOXUEBRIDGE_TOKEN: 'test-token'
    },
    serverCapabilities: capabilities,
    resourceProfiles: resources,
    workspaceSelections
  })

  // Use the harness-owned call log for application lifecycle order.
  // The capability fake has its own log so its lifecycle can be asserted directly.
  await current.application.start()
  try {
    assert.deepEqual(calls, [
      'capabilities.start',
      'resources.start',
      'workspace-selections.start'
    ])

    current.adapter.emit({ type: 'connected', at: 1 })
    current.adapter.emit({
      type: 'spawned',
      at: 2,
      dimension: 'overworld',
      position: { x: 0, y: 64, z: 0 },
      health: 20,
      food: 20
    })
    current.adapter.emit({
      type: 'player_chat',
      at: 3,
      player: 'Boss',
      message: '墨雪 幫我找鐵礦'
    })

    await waitFor(() => current.logicalExecutor.requests.length === 1)
    assert.deepEqual(
      current.logicalExecutor.requests[0]?.context.serverCapabilities?.map(item => item.id),
      ['vein_mining']
    )
    assert.deepEqual(
      current.logicalExecutor.requests[0]?.context.serverResources?.map(item => item.id),
      ['examplemod:titanium_ore']
    )
    assert.equal(
      JSON.stringify(current.logicalExecutor.requests[0]?.context).includes('VeinMiner'),
      false
    )

    const control = current.control()
    assert.ok(control)
    assert.deepEqual(control.options.capabilityStatus?.snapshot(), {
      state: 'current',
      ids: ['vein_mining'],
      details: [{
        id: 'vein_mining',
        trigger: 'sneak_and_break',
        constraints: {
          max_chain: 100,
          correct_tool_required: true,
          must_sneak: true
        }
      }]
    })
    assert.deepEqual(
      control.options.workspaceSelectionStatus?.snapshot({
        dimension: 'overworld',
        playerId: 'player-1'
      }),
      {
        state: 'current',
        lastSuccessAt: 1234,
        lastErrorCode: null,
        selection: {
          id: 'selection-live',
          generation: 2,
          worldKey: 'localhost:25565',
          dimension: 'overworld',
          playerId: 'player-1',
          playerName: 'Boss',
          pointA: { x: 1, y: 64, z: 2 },
          pointB: { x: 8, y: 64, z: 9 },
          selectedAt: 1200
        }
      }
    )

    const workspace =
      control.options.workspaceManagement
        ?.create({
          dimension: 'overworld',
          actorPrincipal: 'player-1',
          label: 'Live test farm',
          purpose: 'farm'
        })
    assert.ok(workspace)
    assert.equal(
      workspace.worldKey,
      'localhost:25565'
    )
    assert.equal(
      workspace.ownerPrincipal,
      'player-1'
    )
    assert.equal(
      workspace.sourceSelectionId,
      'selection-live'
    )
    assert.deepEqual(
      workspace.bounds,
      {
        min: { x: 1, y: 64, z: 2 },
        max: { x: 8, y: 64, z: 9 }
      }
    )
    assert.deepEqual(
      control.options.workspaceManagement
        ?.list({
          actorPrincipal: 'player-1',
          dimension: 'overworld'
        })
        .map(item => item.id),
      [workspace.id]
    )
  } finally {
    current.recorder.releaseFirst()
    await current.application.close()
  }

  assert.deepEqual(calls, [
    'capabilities.start',
    'resources.start',
    'workspace-selections.start',
    'workspace-selections.stop',
    'resources.stop',
    'capabilities.stop'
  ])
})

test('application start connects Minecraft before opening the Control API and close reverses external exposure', async () => {
  const current = harness()
  const address = await current.application.start()
  assert.deepEqual(address, {
    host: '127.0.0.1',
    port: 8766,
    baseUrl: 'http://127.0.0.1:8766'
  })
  assert.deepEqual(current.calls.slice(0, 2), ['adapter.connect', 'control.start'])

  await current.application.close()
  assert.deepEqual(current.calls.slice(-3), [
    'control.close',
    'adapter.disconnect',
    'memory.close'
  ])
})

test('adapter events are published in order, update state, and are recorded serially', async () => {
  const current = harness()
  await current.application.start()
  try {
    const control = current.control()
    assert.ok(control)

    current.adapter.emit({ type: 'connected', at: 1 })
    current.adapter.emit({
      type: 'spawned',
      at: 2,
      dimension: 'overworld',
      position: { x: 5, y: 64, z: 6 },
      health: 20,
      food: 19
    })

    await waitFor(() => current.recorder.started.length === 1)
    assert.deepEqual(current.recorder.started, ['connected'])
    assert.deepEqual(control.options.state.snapshot().position, { x: 5, y: 64, z: 6 })

    current.recorder.releaseFirst()
    await waitFor(() => current.recorder.finished.length === 2)
    assert.deepEqual(current.recorder.started, ['connected', 'spawned'])
    assert.deepEqual(current.recorder.finished, ['connected', 'spawned'])
  } finally {
    current.recorder.releaseFirst()
    await current.application.close()
  }
})

test('GoalManager is wired to deterministic skills without blocking submission, and shutdown aborts active work', async () => {
  const current = harness()
  await current.application.start()
  const control = current.control()
  assert.ok(control)

  const record = await Promise.race([
    control.options.goals.submit({ kind: 'stay', args: {} }, 'player'),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('goal submission waited for active skill')), 250)
    )
  ])
  assert.equal(record.status, 'running')
  await waitFor(() => current.adapter.holdStarted === 1)
  assert.equal(current.adapter.holdSignal?.aborted, false)

  await current.application.close()
  assert.equal(current.adapter.holdSignal?.aborted, true)
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition did not become true')
}
