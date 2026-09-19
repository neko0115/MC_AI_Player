import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteQuotaLedger } from '../../../src/agent/routing/quota-ledger.js'
import {
  RoutingConfigManager,
  type RoutingConfigSnapshot
} from '../../../src/agent/routing/config-manager.js'

function rawConfig(projectOrder = ['pool-a', 'pool-b']) {
  const byKey = {
    'pool-a': {
      projectKey: 'pool-a',
      apiKeyEnv: 'MC_AI_KEY_A',
      providerLimits: {
        routine: { rpm: 10, inputTpm: 10000, rpd: 100 },
        complex: { rpm: 10, inputTpm: 10000, rpd: 100 }
      },
      flashBudget: {
        requestLimit: 80,
        totalTokenLimit: 100000,
        resetWindow: 'america-los-angeles-day',
        source: 'operator_policy'
      }
    },
    'pool-b': {
      projectKey: 'pool-b',
      apiKeyEnv: 'MC_AI_KEY_B',
      providerLimits: {
        routine: { rpm: 20, inputTpm: 20000, rpd: 200 },
        complex: { rpm: 20, inputTpm: 20000, rpd: 200 }
      },
      flashBudget: {
        requestLimit: 160,
        totalTokenLimit: 200000,
        resetWindow: 'america-los-angeles-day',
        source: 'operator_policy'
      }
    }
  } as const

  return {
    version: 1,
    models: {
      routine: {
        name: 'gemini-3.5-flash-lite',
        reservation: { inputTokenOverhead: 256, generationTokenAllowance: { low: 512 } }
      },
      complex: {
        name: 'gemini-3.8-flash',
        reservation: {
          inputTokenOverhead: 256,
          generationTokenAllowance: { medium: 2048, high: 4096 }
        }
      }
    },
    projects: projectOrder.map(key => structuredClone(byKey[key as keyof typeof byKey])),
    manualAccess: {
      ownerUuid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      operatorAllowlistUuids: ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']
    }
  }
}

function project(snapshot: RoutingConfigSnapshot, key: string) {
  const value = snapshot.projects.find(candidate => candidate.projectKey === key)
  assert.ok(value)
  return value
}

test('initial activation validates all referenced credentials before allocating generation', () => {
  const ledger = new SqliteQuotaLedger(':memory:')
  let candidate: unknown = rawConfig()
  const env: Record<string, string | undefined> = {
    MC_AI_KEY_A: 'key-a'
  }
  const manager = new RoutingConfigManager({
    ledger,
    env,
    readConfig: () => candidate,
    nextCredentialHandle: (() => {
      let next = 1
      return () => `credential-${next++}`
    })()
  })

  assert.throws(() => manager.activateInitial(), /missing credential/i)
  env.MC_AI_KEY_B = 'key-b'
  const active = manager.activateInitial()
  assert.equal(active.generation, 1)
  assert.equal(manager.resolveCredential(project(active, 'pool-a').credentialHandle), 'key-a')
  assert.equal(JSON.stringify(active).includes('key-a'), false)
  ledger.close()
})

test('invalid or missing-credential reload leaves the old snapshot fully active', () => {
  const ledger = new SqliteQuotaLedger(':memory:')
  let candidate: any = rawConfig()
  const env: Record<string, string | undefined> = {
    MC_AI_KEY_A: 'key-a',
    MC_AI_KEY_B: 'key-b'
  }
  const manager = new RoutingConfigManager({ ledger, env, readConfig: () => candidate })
  const original = manager.activateInitial()

  delete env.MC_AI_KEY_B
  assert.deepEqual(manager.reload(), { kind: 'rejected', code: 'missing_credential' })
  assert.equal(manager.snapshot(), original)

  env.MC_AI_KEY_B = 'key-b'
  candidate = { ...rawConfig(), surprise: true }
  assert.deepEqual(manager.reload(), { kind: 'rejected', code: 'invalid_config' })
  assert.equal(manager.snapshot(), original)
  ledger.close()
})

test('valid reload atomically increments generation, preserves project identity, and keeps old handles usable', () => {
  const ledger = new SqliteQuotaLedger(':memory:')
  let candidate: any = rawConfig()
  const env: Record<string, string | undefined> = {
    MC_AI_KEY_A: 'key-a-v1',
    MC_AI_KEY_B: 'key-b-v1'
  }
  let nextHandle = 1
  const manager = new RoutingConfigManager({
    ledger,
    env,
    readConfig: () => candidate,
    nextCredentialHandle: () => `credential-${nextHandle++}`
  })
  const first = manager.activateInitial()
  const oldHandle = project(first, 'pool-a').credentialHandle

  env.MC_AI_KEY_A = 'key-a-v2'
  candidate = rawConfig(['pool-b', 'pool-a'])
  const result = manager.reload()
  assert.deepEqual(result, {
    kind: 'reloaded',
    generation: 2,
    authorizationChanged: false
  })
  const second = manager.snapshot()
  assert.deepEqual(second.projects.map(item => item.projectKey), ['pool-b', 'pool-a'])
  assert.equal(manager.resolveCredential(oldHandle), 'key-a-v1')
  assert.equal(manager.resolveCredential(project(second, 'pool-a').credentialHandle), 'key-a-v2')
  ledger.close()
})

test('reload reports authorization-policy changes for pending grant invalidation', () => {
  const ledger = new SqliteQuotaLedger(':memory:')
  let candidate: any = rawConfig()
  const env = { MC_AI_KEY_A: 'key-a', MC_AI_KEY_B: 'key-b' }
  const manager = new RoutingConfigManager({ ledger, env, readConfig: () => candidate })
  manager.activateInitial()

  candidate = rawConfig()
  candidate.manualAccess.operatorAllowlistUuids = ['cccccccccccccccccccccccccccccccc']
  assert.deepEqual(manager.reload(), {
    kind: 'reloaded',
    generation: 2,
    authorizationChanged: true
  })
  ledger.close()
})
