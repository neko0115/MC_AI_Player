import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SqliteQuotaLedger } from '../src/agent/routing/quota-ledger.js'
import { RuntimeEventBus } from '../src/telemetry/event-bus.js'
import { createGeminiDecisionStack } from '../src/main.js'

function routingConfig() {
  return {
    version: 1,
    models: {
      routine: {
        name: 'gemini-3.5-flash-lite',
        reservation: {
          inputTokenOverhead: 256,
          generationTokenAllowance: { low: 512 }
        }
      },
      complex: {
        name: 'gemini-3.8-flash',
        reservation: {
          inputTokenOverhead: 256,
          generationTokenAllowance: { medium: 2048, high: 4096 }
        }
      }
    },
    projects: [{
      projectKey: 'pool-a',
      apiKeyEnv: 'MC_AI_KEY_PRIMARY',
      providerLimits: {
        routine: { rpm: 10, inputTpm: 10_000, rpd: 100 },
        complex: { rpm: 10, inputTpm: 10_000, rpd: 100 }
      },
      flashBudget: {
        requestLimit: 80,
        totalTokenLimit: 100_000,
        resetWindow: 'america-los-angeles-day',
        source: 'operator_policy'
      }
    }],
    manualAccess: {
      ownerUuid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      operatorAllowlistUuids: []
    }
  }
}

test('Gemini decision stack activates routing, recovers reserved quota, and owns ledger close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mc-ai-gemini-stack-'))
  const routingPath = join(directory, 'ai-routing.json')
  const quotaPath = join(directory, 'ai-quota.sqlite3')
  await writeFile(routingPath, JSON.stringify(routingConfig()), 'utf8')

  const before = new SqliteQuotaLedger(quotaPath)
  const reserved = before.admitAttempt({
    attemptId: 'orphan-reservation',
    decisionId: 'old-decision',
    configGeneration: 1,
    projectKey: 'pool-a',
    model: 'gemini-3.5-flash-lite',
    thinking: 'low',
    budgetClass: 'normal',
    now: 1_000,
    reservedInputTokens: 100,
    reservedTotalTokens: 200,
    providerLimits: { rpm: 10, inputTpm: 10_000, rpd: 100 }
  })
  assert.equal(reserved.kind, 'admitted')
  before.close()

  const stack = createGeminiDecisionStack({
    routingConfigPath: routingPath,
    env: { MC_AI_KEY_PRIMARY: 'TEST_SECRET_DO_NOT_LEAK' },
    quotaFilename: quotaPath,
    processInstanceId: 'process-test',
    events: new RuntimeEventBus(),
    now: () => 2_000
  })
  try {
    const snapshot = stack.configManager.snapshot()
    assert.equal(snapshot.generation, 1)
    assert.equal(snapshot.projects[0]?.projectKey, 'pool-a')
    assert.equal(snapshot.models.routine.name, 'gemini-3.5-flash-lite')
    assert.equal(snapshot.models.complex.name, 'gemini-3.8-flash')
    assert.equal(
      typeof stack
        .workspaceIntentInterpreter
        .interpret,
      'function'
    )

    const quota = stack.quotaLedger.adminSnapshot(2_000)
    const domain = quota
      .find(project => project.projectKey === 'pool-a')
      ?.domains.find(item => item.model === 'gemini-3.5-flash-lite')
    assert.equal(domain?.rollingRequests ?? 0, 0)
  } finally {
    stack.close()
  }

  assert.throws(
    () => stack.quotaLedger.allocateConfigGeneration(),
    /closed/i
  )
  await rm(directory, { recursive: true, force: true })
})
