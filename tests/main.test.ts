import assert from 'node:assert/strict'
import test from 'node:test'
import type { AiConfig, MinecraftConfig } from '../src/config.js'
import type { Position, RuntimeEvent } from '../src/contracts/events.js'
import type { SkillResult } from '../src/contracts/skills.js'
import type { MinecraftAdapter, NavigationOptions } from '../src/minecraft/adapter.js'
import type { MineflayerRuntimeBundle } from '../src/minecraft/runtime-bundle.js'
import type { MinecraftMemoryRepository, MemorySearchQuery, MinecraftMemory } from '../src/memory/repository.js'
import type { ProviderCapabilities, DecisionProvider } from '../src/agent/provider.js'
import type { ControlServerOptions, ControlServerAddress } from '../src/api/control-server.js'
import { createApplication } from '../src/main.js'

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

function safeProvider(): DecisionProvider {
  return {
    capabilities: { structuredFinal: true, reasoningSeparated: true },
    async decide() {
      return { kind: 'timeout', provider: 'fake-test' }
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

function environment(): NodeJS.ProcessEnv {
  return {
    MC_HOST: 'localhost',
    MC_PORT: '25565',
    MC_USERNAME: 'Moxue_Test',
    MC_AUTH: 'offline',
    MC_AI_PROVIDER: 'fake',
    MC_CONTROL_HOST: '127.0.0.1',
    MC_CONTROL_PORT: '8766'
  }
}

function harness(provider: DecisionProvider = safeProvider()) {
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
  let control: FakeControlServer | null = null
  const application = createApplication(environment(), {
    createRuntime: (_config: MinecraftConfig) => runtime,
    createMemory: () => memory,
    createRecorder: () => recorder,
    createDecisionProvider: (_config: AiConfig) => provider,
    createControlServer: options => {
      control = new FakeControlServer(calls, options)
      return control
    }
  })
  return { application, adapter, calls, memory, recorder, control: () => control }
}

test('creating the composition root has no connect or port-binding side effects', () => {
  const current = harness()
  assert.deepEqual(current.calls, [])
  assert.ok(current.control())
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

test('composition root rejects a selected provider without the reasoning-isolation capability contract', () => {
  assert.throws(
    () => harness(unsafeProvider({ structuredFinal: true, reasoningSeparated: false })),
    /reasoning separation/i
  )
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition did not become true')
}
