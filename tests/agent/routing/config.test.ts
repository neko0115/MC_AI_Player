import assert from 'node:assert/strict'
import test from 'node:test'
import { parseRoutingConfig } from '../../../src/agent/routing/config.js'

function validConfig() {
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
        routine: { rpm: 10, inputTpm: 10000, rpd: 100 },
        complex: { rpm: 10, inputTpm: 10000, rpd: 100 }
      },
      flashBudget: {
        requestLimit: 80,
        totalTokenLimit: 100000,
        resetWindow: 'america-los-angeles-day',
        source: 'operator_policy'
      }
    }],
    manualAccess: {
      ownerUuid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      operatorAllowlistUuids: ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']
    }
  }
}

test('routing config accepts the approved strict baseline shape', () => {
  const parsed = parseRoutingConfig(validConfig())
  assert.equal(parsed.projects[0]?.projectKey, 'pool-a')
  assert.equal(parsed.models.routine.name, 'gemini-3.5-flash-lite')
  assert.equal(parsed.models.complex.name, 'gemini-3.8-flash')
})

test('routing config rejects duplicate projectKey values', () => {
  const duplicate = validConfig()
  duplicate.projects.push({ ...duplicate.projects[0]! })
  assert.throws(() => parseRoutingConfig(duplicate), /projectKey/i)
})

test('routing config rejects zero or negative admission-critical limits', () => {
  const zeroTokenBudget = validConfig()
  zeroTokenBudget.projects[0]!.flashBudget.totalTokenLimit = 0
  assert.throws(() => parseRoutingConfig(zeroTokenBudget), /totalTokenLimit/i)

  const zeroRpm = validConfig()
  zeroRpm.projects[0]!.providerLimits.routine.rpm = 0
  assert.throws(() => parseRoutingConfig(zeroRpm), /rpm/i)
})

test('routing config rejects malformed privileged UUIDs', () => {
  const malformed = validConfig()
  malformed.manualAccess.ownerUuid = 'Boss'
  assert.throws(() => parseRoutingConfig(malformed), /uuid/i)
})

test('routing config rejects unknown fields and an empty project pool', () => {
  const unknownField = validConfig() as ReturnType<typeof validConfig> & { surprise?: boolean }
  unknownField.surprise = true
  assert.throws(() => parseRoutingConfig(unknownField), /unrecognized|unknown|strict/i)

  const noProjects = validConfig()
  noProjects.projects = []
  assert.throws(() => parseRoutingConfig(noProjects), /project/i)
})

test('Flash request budget cannot exceed the configured complex-model RPD', () => {
  const impossibleBudget = validConfig()
  impossibleBudget.projects[0]!.flashBudget.requestLimit = 101
  assert.throws(() => parseRoutingConfig(impossibleBudget), /requestLimit|rpd/i)
})
