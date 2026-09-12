import assert from 'node:assert/strict'
import test from 'node:test'
import type { MinecraftConfig } from '../src/config.js'
import type { Position, RuntimeEvent } from '../src/contracts/events.js'
import type { SkillResult } from '../src/contracts/skills.js'
import type { LogicalDecisionExecutor } from '../src/agent/routing/contracts.js'
import type { MinecraftMemoryRepository } from '../src/memory/repository.js'
import type { MinecraftAdapter, NavigationOptions } from '../src/minecraft/adapter.js'
import type { MineflayerRuntimeBundle } from '../src/minecraft/runtime-bundle.js'
import type { ControlServerAddress, ControlServerOptions } from '../src/api/control-server.js'
import type { AdminServerAddress, AdminServerOptions } from '../src/api/admin-server.js'
import { createApplication } from '../src/main.js'

class FakeAdapter implements MinecraftAdapter {
  constructor(private readonly calls: string[]) {}
  async connect(): Promise<void> { this.calls.push('adapter.connect') }
  async disconnect(): Promise<void> { this.calls.push('adapter.disconnect') }
  async goTo(_position: Position, _options: NavigationOptions, _signal: AbortSignal): Promise<SkillResult> {
    return { status: 'succeeded', code: 'arrived' }
  }
  async followPlayer(_player: string, _range: number, _signal: AbortSignal): Promise<SkillResult> {
    return { status: 'succeeded', code: 'following' }
  }
  async holdPosition(_signal: AbortSignal): Promise<SkillResult> {
    return { status: 'succeeded', code: 'held' }
  }
  async stopMotion(): Promise<void> {}
  onEvent(_listener: (event: RuntimeEvent) => void): () => void { return () => {} }
}

class FakeMemory implements MinecraftMemoryRepository {
  constructor(private readonly calls: string[]) {}
  remember(): never { throw new Error('not used') }
  search() { return [] }
  forget() { return false }
  close(): void { this.calls.push('memory.close') }
}

class FakeControlServer {
  constructor(private readonly calls: string[], readonly options: ControlServerOptions) {}
  async start(): Promise<ControlServerAddress> {
    this.calls.push('control.start')
    return { host: '127.0.0.1', port: 8766, baseUrl: 'http://127.0.0.1:8766' }
  }
  async close(): Promise<void> { this.calls.push('control.close') }
}

class FakeAdminServer {
  constructor(private readonly calls: string[], readonly options: AdminServerOptions) {}
  async start(): Promise<AdminServerAddress> {
    this.calls.push('admin.start')
    return { host: '127.0.0.1', port: 8767, baseUrl: 'http://127.0.0.1:8767' }
  }
  async close(): Promise<void> { this.calls.push('admin.close') }
}

function runtime(calls: string[]): MineflayerRuntimeBundle {
  return {
    adapter: new FakeAdapter(calls),
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
}

function env(): NodeJS.ProcessEnv {
  return {
    MC_HOST: 'localhost',
    MC_PORT: '25565',
    MC_USERNAME: 'Moxue_Test',
    MC_AUTH: 'offline',
    MC_SERVER_IDENTITY_MODE: 'online',
    MC_AI_PROVIDER: 'gemini',
    MC_AI_ROUTING_CONFIG: 'private-routing.json',
    MC_AI_KEY_PRIMARY: 'TEST_SECRET_DO_NOT_LEAK',
    MC_ADMIN_TOKEN: 'ADMIN_SECRET_DO_NOT_LEAK',
    MC_ADMIN_PORT: '8767',
    MC_CONTROL_HOST: '127.0.0.1',
    MC_CONTROL_PORT: '8766'
  }
}

test('Gemini application composes the routed stack, starts loopback Admin after Minecraft, and owns stack shutdown', async () => {
  const calls: string[] = []
  const logicalExecutor: LogicalDecisionExecutor = {
    async execute() {
      return {
        kind: 'success',
        providerResult: {
          kind: 'structured', provider: 'fake-live-stack', mode: 'function_call',
          value: { version: 2, outcome: 'complete' }
        }
      }
    }
  }
  const fakeStack = {
    executor: logicalExecutor,
    configManager: {
      snapshot() {
        return {
          generation: 1,
          models: {
            routine: {
              name: 'gemini-3.5-flash-lite',
              reservation: { inputTokenOverhead: 1, generationTokenAllowance: { low: 1 } }
            },
            complex: {
              name: 'gemini-3.8-flash',
              reservation: { inputTokenOverhead: 1, generationTokenAllowance: { medium: 1, high: 1 } }
            }
          },
          projects: [],
          manualAccess: {
            ownerUuid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            operatorAllowlistUuids: []
          }
        }
      },
      reload() { return { kind: 'reloaded' as const, generation: 2, authorizationChanged: false } }
    },
    quotaLedger: {
      adminSnapshot() { return [] }
    },
    close() { calls.push('gemini.close') }
  }

  let control: FakeControlServer | null = null
  let admin: FakeAdminServer | null = null
  const application = createApplication(env(), {
    createRuntime: (_config: MinecraftConfig) => runtime(calls),
    createMemory: () => new FakeMemory(calls),
    createRecorder: () => ({ async record() { return { ok: true } } }),
    createGeminiDecisionStack: options => {
      calls.push('gemini.create')
      assert.equal(options.routingConfigPath, 'private-routing.json')
      assert.equal(options.env.MC_AI_KEY_PRIMARY, 'TEST_SECRET_DO_NOT_LEAK')
      return fakeStack
    },
    createControlServer: options => {
      control = new FakeControlServer(calls, options)
      return control
    },
    createAdminServer: options => {
      admin = new FakeAdminServer(calls, options)
      return admin
    }
  })

  assert.deepEqual(calls, ['gemini.create'])
  assert.ok(control)
  assert.ok(admin)
  assert.equal(admin.options.bearerToken, 'ADMIN_SECRET_DO_NOT_LEAK')
  assert.equal(admin.options.routing, fakeStack.configManager)
  assert.equal(admin.options.quota, fakeStack.quotaLedger)

  await application.start()
  assert.deepEqual(calls.slice(0, 4), [
    'gemini.create',
    'adapter.connect',
    'control.start',
    'admin.start'
  ])

  await application.close()
  assert.equal(calls.indexOf('admin.close') < calls.indexOf('control.close'), true)
  assert.equal(calls.indexOf('gemini.close') < calls.indexOf('memory.close'), true)
})
