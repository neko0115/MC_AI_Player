import assert from 'node:assert/strict'
import test from 'node:test'
import type { RoutePlan } from '../../../src/agent/routing/contracts.js'
import type {
  QuotaAdmissionRequest,
  QuotaAdmissionResult
} from '../../../src/agent/routing/quota-ledger.js'
import type { RoutingConfigSnapshot } from '../../../src/agent/routing/config-manager.js'
import {
  ProjectPool,
  estimateReservation
} from '../../../src/agent/routing/project-pool.js'

function snapshot(): RoutingConfigSnapshot {
  return {
    generation: 7,
    models: {
      routine: {
        name: 'gemini-3.5-flash-lite',
        reservation: {
          inputTokenOverhead: 100,
          generationTokenAllowance: { low: 200 }
        }
      },
      complex: {
        name: 'gemini-3.8-flash',
        reservation: {
          inputTokenOverhead: 100,
          generationTokenAllowance: { medium: 500, high: 900 }
        }
      }
    },
    projects: [
      {
        projectKey: 'pool-a',
        credentialHandle: 'cred-a',
        providerLimits: {
          routine: { rpm: 10, inputTpm: 10000, rpd: 100 },
          complex: { rpm: 10, inputTpm: 10000, rpd: 100 }
        },
        flashBudget: { requestLimit: 80, totalTokenLimit: 100000, resetWindow: 'america-los-angeles-day', source: 'operator_policy' }
      },
      {
        projectKey: 'pool-b',
        credentialHandle: 'cred-b',
        providerLimits: {
          routine: { rpm: 20, inputTpm: 20000, rpd: 200 },
          complex: { rpm: 20, inputTpm: 20000, rpd: 200 }
        },
        flashBudget: { requestLimit: 160, totalTokenLimit: 200000, resetWindow: 'america-los-angeles-day', source: 'operator_policy' }
      }
    ],
    manualAccess: {
      ownerUuid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      operatorAllowlistUuids: []
    }
  }
}

function plan(
  routeClass: 'routine' | 'complex',
  reserveAuthorized = false,
  thinking: 'low' | 'medium' | 'high' = routeClass === 'routine' ? 'low' : 'medium'
): RoutePlan {
  return Object.freeze({
    decisionId: `decision-${routeClass}-${thinking}`,
    policy: 'balanced-v1',
    routeClass,
    thinking,
    reserveAuthorized,
    reasons: Object.freeze([]),
    highReason: thinking === 'high' ? 'manual_deep_think' : null
  })
}

class FakeLedger {
  readonly admissions: QuotaAdmissionRequest[] = []
  readonly disabled = new Set<string>()
  handler: (request: QuotaAdmissionRequest) => QuotaAdmissionResult = request => ({
    kind: 'admitted', reservationId: request.attemptId
  })

  credentialDisabled(projectKey: string, processInstanceId: string): boolean {
    return this.disabled.has(`${processInstanceId}:${projectKey}`)
  }

  admitAttempt(request: QuotaAdmissionRequest): QuotaAdmissionResult {
    this.admissions.push(structuredClone(request))
    return this.handler(request)
  }
}

function pool(ledger: FakeLedger) {
  let nextAttempt = 1
  return new ProjectPool({
    config: { snapshot },
    ledger,
    processInstanceId: 'process-1',
    now: () => 1000,
    nextAttemptId: () => `attempt-${nextAttempt++}`
  })
}

test('conservative reservation uses UTF-8 bytes plus configured allowances', () => {
  assert.deepEqual(estimateReservation(1200, 100, 500), {
    inputTokens: 1300,
    totalTokens: 1800
  })
})

test('routine routing stays on Lite and starts with primary', () => {
  const ledger = new FakeLedger()
  const result = pool(ledger).nextLease(plan('routine'), { utf8Bytes: 1000 })
  assert.equal(result.kind, 'leased')
  if (result.kind !== 'leased') return
  assert.equal(result.lease.projectKey, 'pool-a')
  assert.equal(result.lease.projectLabel, 'primary')
  assert.equal(result.lease.model, 'gemini-3.5-flash-lite')
  assert.equal(result.lease.thinking, 'low')
  assert.equal(result.lease.budgetClass, 'normal')
  assert.equal(ledger.admissions[0]?.flashBudget, undefined)
})

test('automatic complex routing scans normal regions only and never reserve', () => {
  const ledger = new FakeLedger()
  ledger.handler = request => request.projectKey === 'pool-a'
    ? { kind: 'rejected', code: 'flash_request_budget', retryAt: 9000 }
    : { kind: 'admitted', reservationId: request.attemptId }

  const result = pool(ledger).nextLease(plan('complex'), { utf8Bytes: 500 })
  assert.equal(result.kind, 'leased')
  if (result.kind !== 'leased') return
  assert.equal(result.lease.projectKey, 'pool-b')
  assert.deepEqual(ledger.admissions.map(item => [item.projectKey, item.budgetClass]), [
    ['pool-a', 'normal'],
    ['pool-b', 'normal']
  ])
})

test('manual reserve authorization still scans every Project normal region before reserve', () => {
  const ledger = new FakeLedger()
  ledger.handler = request => {
    if (request.budgetClass === 'normal') {
      return { kind: 'rejected', code: 'flash_request_budget', retryAt: 9000 }
    }
    return request.projectKey === 'pool-a'
      ? { kind: 'admitted', reservationId: request.attemptId }
      : { kind: 'rejected', code: 'flash_request_budget', retryAt: 9000 }
  }

  const result = pool(ledger).nextLease(plan('complex', true, 'high'), { utf8Bytes: 500 })
  assert.equal(result.kind, 'leased')
  if (result.kind !== 'leased') return
  assert.equal(result.lease.projectKey, 'pool-a')
  assert.equal(result.lease.budgetClass, 'reserve')
  assert.deepEqual(ledger.admissions.map(item => [item.projectKey, item.budgetClass]), [
    ['pool-a', 'normal'],
    ['pool-b', 'normal'],
    ['pool-a', 'reserve']
  ])
})

test('manual route uses a backup normal region before touching primary reserve', () => {
  const ledger = new FakeLedger()
  ledger.handler = request => request.projectKey === 'pool-a'
    ? { kind: 'rejected', code: 'flash_token_budget', retryAt: 9000 }
    : { kind: 'admitted', reservationId: request.attemptId }

  const result = pool(ledger).nextLease(plan('complex', true, 'high'), { utf8Bytes: 500 })
  assert.equal(result.kind, 'leased')
  if (result.kind !== 'leased') return
  assert.equal(result.lease.projectKey, 'pool-b')
  assert.equal(result.lease.budgetClass, 'normal')
  assert.equal(ledger.admissions.some(item => item.budgetClass === 'reserve'), false)
})

test('process-disabled credentials are skipped, but Flash-domain failure does not poison Lite', () => {
  const ledger = new FakeLedger()
  ledger.disabled.add('process-1:pool-a')
  const backup = pool(ledger).nextLease(plan('routine'), { utf8Bytes: 100 })
  assert.equal(backup.kind, 'leased')
  if (backup.kind !== 'leased') return
  assert.equal(backup.lease.projectKey, 'pool-b')
  assert.equal(ledger.admissions.length, 1)

  ledger.disabled.clear()
  ledger.admissions.length = 0
  ledger.handler = request => request.model === 'gemini-3.8-flash' && request.projectKey === 'pool-a'
    ? { kind: 'rejected', code: 'domain_unavailable', retryAt: 5000 }
    : { kind: 'admitted', reservationId: request.attemptId }
  const lite = pool(ledger).nextLease(plan('routine'), { utf8Bytes: 100 })
  assert.equal(lite.kind, 'leased')
  if (lite.kind !== 'leased') return
  assert.equal(lite.lease.projectKey, 'pool-a')
})

test('primary is selected again on the next JIT admission once it becomes healthy', () => {
  const ledger = new FakeLedger()
  let primaryHealthy = false
  ledger.handler = request => request.projectKey === 'pool-a' && !primaryHealthy
    ? { kind: 'rejected', code: 'domain_unavailable', retryAt: 5000 }
    : { kind: 'admitted', reservationId: request.attemptId }

  const current = pool(ledger)
  const first = current.nextLease(plan('routine'), { utf8Bytes: 100 })
  assert.equal(first.kind, 'leased')
  if (first.kind !== 'leased') return
  assert.equal(first.lease.projectKey, 'pool-b')

  primaryHealthy = true
  const second = current.nextLease(plan('routine'), { utf8Bytes: 100 })
  assert.equal(second.kind, 'leased')
  if (second.kind !== 'leased') return
  assert.equal(second.lease.projectKey, 'pool-a')
})

test('unavailable result exposes earliest real retry and null when every credential is process-disabled', () => {
  const ledger = new FakeLedger()
  ledger.handler = request => ({
    kind: 'rejected',
    code: 'domain_unavailable',
    retryAt: request.projectKey === 'pool-a' ? 9000 : 7000
  })
  assert.deepEqual(pool(ledger).nextLease(plan('routine'), { utf8Bytes: 100 }), {
    kind: 'unavailable',
    retryAt: 7000
  })

  const disabled = new FakeLedger()
  disabled.disabled.add('process-1:pool-a')
  disabled.disabled.add('process-1:pool-b')
  assert.deepEqual(pool(disabled).nextLease(plan('routine'), { utf8Bytes: 100 }), {
    kind: 'unavailable',
    retryAt: null
  })
})
