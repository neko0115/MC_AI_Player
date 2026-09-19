import assert from 'node:assert/strict'
import test from 'node:test'
import { RoutedDecisionExecutor } from '../../../src/agent/routing/routed-executor.js'
import type { RuntimeEvent } from '../../../src/contracts/events.js'
import type { AttemptSettlement } from '../../../src/agent/routing/quota-ledger.js'

const context = {
  worldKey: 'test-world',
  self: {
    connected: true,
    spawned: true,
    health: 20,
    food: 20,
    dimension: 'overworld',
    position: { x: 0, y: 64, z: 0 }
  },
  currentGoal: null,
  nearbyPlayers: [],
  inventory: [],
  recentEvents: [],
  memories: [],
  skills: [],
  safetyConstraints: []
}

const routePlan = {
  decisionId: 'decision-1',
  policy: 'balanced-v1' as const,
  routeClass: 'complex' as const,
  thinking: 'high' as const,
  reserveAuthorized: true,
  reasons: ['manual_deep_think'],
  highReason: 'manual_deep_think' as const
}

test('RoutedDecisionExecutor publishes only sanitized model route and settled attempt metadata', async () => {
  const emitted: RuntimeEvent[] = []
  const settlements: AttemptSettlement[] = []
  const executor = new RoutedDecisionExecutor({
    processInstanceId: 'process-1',
    pool: {
      configuredProjectCount: () => 1,
      nextLease: () => ({
        kind: 'leased' as const,
        lease: {
          attemptId: 'attempt-1',
          decisionId: 'decision-1',
          configGeneration: 1,
          projectKey: 'internal-project-a',
          projectLabel: 'primary',
          credentialHandle: 'SECRET_HANDLE',
          model: 'gemini-3.8-flash',
          thinking: 'high' as const,
          budgetClass: 'reserve' as const,
          reservationId: 'reservation-1'
        }
      })
    },
    ledger: {
      markDispatched() {},
      settleAttempt(_id, settlement) { settlements.push(settlement) },
      recordTransientFailure: () => 0,
      recordDomainSuccess() {},
      markQuotaUnavailable() {},
      disableCredentialForProcess() {}
    },
    transport: {
      prepare: () => ({
        input: 'PRIVATE_CONTEXT_DO_NOT_LEAK',
        systemInstruction: 'PRIVATE_SYSTEM_DO_NOT_LEAK',
        tools: [],
        utf8Bytes: 64
      }),
      async execute() {
        return {
          kind: 'success' as const,
          providerResult: {
            kind: 'structured' as const,
            provider: 'gemini',
            mode: 'function_call' as const,
            value: { version: 2, outcome: 'complete' }
          },
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            thoughtTokens: 3,
            toolTokens: 1,
            totalTokens: 16
          }
        }
      }
    },
    events: {
      publish(event) { emitted.push(structuredClone(event)) }
    },
    now: () => 100
  })

  const result = await executor.execute(
    { context, routePlan },
    new AbortController().signal
  )
  assert.equal(result.kind, 'success')
  assert.equal(settlements.length, 1)
  assert.deepEqual(emitted, [
    {
      type: 'model_route',
      at: 100,
      decisionId: 'decision-1',
      model: 'gemini-3.8-flash',
      thinking: 'high',
      project: 'primary',
      reasons: ['manual_deep_think'],
      reserveAuthorized: true,
      reserveUsed: true
    },
    {
      type: 'attempt_result',
      at: 100,
      decisionId: 'decision-1',
      model: 'gemini-3.8-flash',
      project: 'primary',
      result: 'success'
    }
  ])
  const serialized = JSON.stringify(emitted)
  for (const forbidden of [
    'internal-project-a',
    'SECRET_HANDLE',
    'PRIVATE_CONTEXT_DO_NOT_LEAK',
    'PRIVATE_SYSTEM_DO_NOT_LEAK'
  ]) {
    assert.equal(serialized.includes(forbidden), false)
  }
})
