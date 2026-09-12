import assert from 'node:assert/strict'
import test from 'node:test'
import type { GeminiDecisionStackOptions } from '../../src/main.js'
import type { LogicalDecisionExecutor } from '../../src/agent/routing/contracts.js'
import { RuntimeEventBus } from '../../src/telemetry/event-bus.js'
import {
  runGeminiRoutingLiveValidation,
  type LiveValidationStack
} from '../../scripts/validate-gemini-routing-live.js'

const SECRET = 'LIVE_SECRET_DO_NOT_LEAK'
const INTERNAL_PROJECT = 'real-google-project-key-do-not-leak'
const PRIVATE_PROMPT = 'PRIVATE_PROMPT_DO_NOT_LEAK'

function fakeStack(events: RuntimeEventBus): LiveValidationStack {
  const executor: LogicalDecisionExecutor = {
    async execute(request) {
      await events.publish({
        type: 'model_route',
        at: 1,
        decisionId: request.routePlan.decisionId,
        model: request.routePlan.routeClass === 'routine'
          ? 'gemini-3.5-flash-lite'
          : 'gemini-3.8-flash',
        thinking: request.routePlan.thinking,
        project: request.routePlan.routeClass === 'routine' ? 'primary' : 'backup-1',
        reasons: [...request.routePlan.reasons],
        reserveAuthorized: request.routePlan.reserveAuthorized,
        reserveUsed: false
      })
      return {
        kind: 'success',
        providerResult: {
          kind: 'structured',
          provider: 'gemini',
          mode: 'function_call',
          value: { version: 2, outcome: 'complete' }
        }
      }
    }
  }
  return {
    executor,
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
          projects: [{
            projectKey: INTERNAL_PROJECT,
            credentialHandle: 'opaque-handle',
            providerLimits: {
              routine: { rpm: 10, inputTpm: 1000, rpd: 100 },
              complex: { rpm: 10, inputTpm: 1000, rpd: 100 }
            },
            flashBudget: {
              requestLimit: 100,
              totalTokenLimit: 10000,
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
    },
    close() {}
  }
}

test('live validation is a zero-side-effect SKIP unless explicitly opted in', async () => {
  let createCalls = 0
  const lines: string[] = []
  const result = await runGeminiRoutingLiveValidation({
    MC_AI_LIVE_VALIDATION: '0',
    MC_AI_KEY_PRIMARY: SECRET
  }, {
    createStack() {
      createCalls += 1
      throw new Error('must not create live stack')
    },
    writeLine: line => lines.push(line)
  })

  assert.deepEqual(result, { kind: 'skipped', reason: 'not_opted_in' })
  assert.equal(createCalls, 0)
  assert.equal(lines.join('\n').includes(SECRET), false)
})

test('opted-in live validation emits only sanitized routing evidence for routine and complex calls', async () => {
  const lines: string[] = []
  const capturedOptions: GeminiDecisionStackOptions[] = []
  const env = {
    MC_AI_LIVE_VALIDATION: '1',
    MC_AI_ROUTING_CONFIG: 'data/ai-routing.json',
    MC_AI_KEY_PRIMARY: SECRET,
    PRIVATE_PROMPT
  }

  const result = await runGeminiRoutingLiveValidation(env, {
    createStack(options) {
      capturedOptions.push(options)
      return fakeStack(options.events)
    },
    writeLine: line => lines.push(line),
    quotaFilename: ':memory:'
  })

  assert.equal(result.kind, 'passed')
  assert.equal(capturedOptions[0]?.routingConfigPath, 'data/ai-routing.json')
  assert.equal(result.kind === 'passed' ? result.cases.length : 0, 2)
  if (result.kind === 'passed') {
    assert.deepEqual(result.cases.map(item => [item.case, item.model, item.thinking, item.project]), [
      ['routine', 'gemini-3.5-flash-lite', 'low', 'primary'],
      ['complex', 'gemini-3.8-flash', 'medium', 'backup-1']
    ])
  }

  const output = lines.join('\n')
  assert.equal(output.includes(SECRET), false)
  assert.equal(output.includes(INTERNAL_PROJECT), false)
  assert.equal(output.includes(PRIVATE_PROMPT), false)
  assert.equal(output.includes('opaque-handle'), false)
})
