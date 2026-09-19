import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ControlServerOptions } from '../src/api/control-server.js'
import type { MinecraftAdapter } from '../src/minecraft/adapter.js'
import type { MineflayerRuntimeBundle } from '../src/minecraft/runtime-bundle.js'
import { createApplication, type McAiPlayerApplication } from '../src/main.js'

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

function fakeRuntime(): MineflayerRuntimeBundle {
  const adapter: MinecraftAdapter = {
    async connect() {},
    async disconnect() {},
    async goTo() { return { status: 'failed', code: 'not_available' } },
    async followPlayer() { return { status: 'failed', code: 'not_available' } },
    async holdPosition() { return { status: 'failed', code: 'not_available' } },
    async stopMotion() {},
    onEvent() { return () => {} }
  }
  return {
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
}

test('default persistence bootstraps its data directory in a fresh working directory', async () => {
  const previousCwd = process.cwd()
  const directory = await mkdtemp(join(tmpdir(), 'mc-ai-player-fresh-'))
  process.chdir(directory)
  let application: McAiPlayerApplication | undefined

  try {
    assert.equal(existsSync(join(directory, 'data')), false)

    application = createApplication(environment(), {
      createRuntime: () => fakeRuntime(),
      createLogicalDecisionExecutor: () => ({
        async execute() {
          return { kind: 'cancelled' as const }
        }
      }),
      createControlServer: (_options: ControlServerOptions) => ({
        async start() {
          return { host: '127.0.0.1', port: 8766, baseUrl: 'http://127.0.0.1:8766' }
        },
        async close() {}
      })
    })

    assert.equal(existsSync(join(directory, 'data')), true)
    assert.equal(existsSync(join(directory, 'data', 'mc_memory.sqlite3')), true)
  } finally {
    await application?.close()
    process.chdir(previousCwd)
  }
})
