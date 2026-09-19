import assert from 'node:assert/strict'
import test from 'node:test'
import type { SkillResult } from '../../src/contracts/skills.js'
import {
  installMineflayerRuntimeExtensions
} from '../../src/minecraft/runtime-extension.js'
import {
  RuntimePortRegistry,
  defineRuntimePort
} from '../../src/minecraft/runtime-ports.js'
import {
  installSkillModules,
  type SkillModule
} from '../../src/modules/skill-module.js'
import { SkillExecutor } from '../../src/skills/executor.js'
import { SkillRegistry } from '../../src/skills/registry.js'

interface IndependentRuntimePort {
  run(signal: AbortSignal): Promise<SkillResult>
}

const INDEPENDENT_PORT =
  defineRuntimePort<IndependentRuntimePort>(
    'acceptance.independent-runtime'
  )

function createIndependentModule(
  ports: RuntimePortRegistry
): SkillModule {
  return {
    id: 'acceptance-independent-module',
    install(registry) {
      const runtime = ports.require(INDEPENDENT_PORT)
      registry.register({
        name: 'stay',
        execute({ signal }) {
          return runtime.run(signal)
        }
      })
    }
  }
}

test('an independent module can add a typed runtime port and skill without builtin module internals', async () => {
  const ports = new RuntimePortRegistry()

  installMineflayerRuntimeExtensions(
    {
      readyBot: () => null,
      ports
    },
    [{
      id: 'acceptance-runtime-extension',
      install({ ports: target }) {
        target.register(INDEPENDENT_PORT, {
          async run(signal) {
            if (signal.aborted) {
              return { status: 'cancelled', code: 'cancelled' }
            }
            return {
              status: 'succeeded',
              code: 'independent_module_executed'
            }
          }
        })
      }
    }]
  )

  const registry = new SkillRegistry()
  installSkillModules(
    registry,
    [createIndependentModule(ports)]
  )

  const executor = new SkillExecutor(registry)
  assert.deepEqual(
    await executor.execute('stay', {}),
    {
      status: 'succeeded',
      code: 'independent_module_executed'
    }
  )
  assert.deepEqual(
    ports.registeredIds(),
    ['acceptance.independent-runtime']
  )
})
