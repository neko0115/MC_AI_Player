import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  SqliteQuotaLedger,
  type QuotaAdmissionRequest
} from '../../../src/agent/routing/quota-ledger.js'

function withLedger(run: (ledger: SqliteQuotaLedger, filename: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'mc-ai-quota-'))
  const filename = join(directory, 'ai-quota.sqlite3')
  const ledger = new SqliteQuotaLedger(filename)
  try {
    run(ledger, filename)
  } finally {
    ledger.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

function request(
  attemptId: string,
  overrides: Partial<QuotaAdmissionRequest> = {}
): QuotaAdmissionRequest {
  return {
    attemptId,
    decisionId: `decision-${attemptId}`,
    configGeneration: 1,
    projectKey: 'pool-a',
    model: 'gemini-3.8-flash',
    thinking: 'medium',
    budgetClass: 'normal',
    now: Date.parse('2026-09-12T12:00:00Z'),
    reservedInputTokens: 10,
    reservedTotalTokens: 20,
    providerLimits: { rpm: 100, inputTpm: 100000, rpd: 1000 },
    flashBudget: { requestLimit: 100, totalTokenLimit: 1000 },
    ...overrides
  }
}

test('config generation remains globally monotonic across reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mc-ai-generation-'))
  const filename = join(directory, 'ai-quota.sqlite3')
  try {
    const first = new SqliteQuotaLedger(filename)
    assert.equal(first.allocateConfigGeneration(), 1)
    assert.equal(first.allocateConfigGeneration(), 2)
    first.close()

    const second = new SqliteQuotaLedger(filename)
    assert.equal(second.allocateConfigGeneration(), 3)
    second.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('actual settlement replaces the temporary reservation instead of double counting it', () => {
  withLedger(ledger => {
    const first = ledger.admitAttempt(request('a1', {
      reservedInputTokens: 40,
      reservedTotalTokens: 60,
      flashBudget: { requestLimit: 100, totalTokenLimit: 100 }
    }))
    assert.equal(first.kind, 'admitted')
    if (first.kind !== 'admitted') return

    ledger.markDispatched(first.reservationId, Date.parse('2026-09-12T12:00:01Z'))
    ledger.settleAttempt(first.reservationId, {
      now: Date.parse('2026-09-12T12:00:02Z'),
      resultClass: 'success',
      usage: {
        inputTokens: 5,
        outputTokens: 2,
        thoughtTokens: 2,
        toolTokens: 1,
        totalTokens: 10
      }
    })

    const second = ledger.admitAttempt(request('a2', {
      now: Date.parse('2026-09-12T12:01:10Z'),
      reservedInputTokens: 30,
      reservedTotalTokens: 60,
      flashBudget: { requestLimit: 100, totalTokenLimit: 100 }
    }))
    assert.equal(second.kind, 'admitted')
  })
})

test('pre-dispatch reservations release safely but dispatched crashes become conservative uncertain usage', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mc-ai-recovery-'))
  const filename = join(directory, 'ai-quota.sqlite3')
  try {
    const ledger = new SqliteQuotaLedger(filename)
    const reserved = ledger.admitAttempt(request('reserved'))
    const dispatched = ledger.admitAttempt(request('dispatched'))
    assert.equal(reserved.kind, 'admitted')
    assert.equal(dispatched.kind, 'admitted')
    if (reserved.kind !== 'admitted' || dispatched.kind !== 'admitted') return

    ledger.markDispatched(dispatched.reservationId, Date.parse('2026-09-12T12:00:01Z'))
    ledger.close()

    const reopened = new SqliteQuotaLedger(filename)
    assert.deepEqual(reopened.recoverIncompleteAttempts(Date.parse('2026-09-12T12:10:00Z')), {
      released: 1,
      uncertain: 1
    })
    const snapshot = reopened.adminSnapshot(Date.parse('2026-09-12T12:10:00Z'))
    assert.equal(snapshot[0]?.domains[0]?.dayRequests, 1)
    assert.equal(snapshot[0]?.domains[0]?.dayTotalTokens, 20)
    reopened.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('rolling RPM and input TPM include active holds and released reservations stop counting', () => {
  withLedger(ledger => {
    const first = ledger.admitAttempt(request('r1', {
      providerLimits: { rpm: 1, inputTpm: 10, rpd: 1000 },
      reservedInputTokens: 10,
      reservedTotalTokens: 10
    }))
    assert.equal(first.kind, 'admitted')
    if (first.kind !== 'admitted') return

    const blocked = ledger.admitAttempt(request('r2', {
      providerLimits: { rpm: 1, inputTpm: 10, rpd: 1000 },
      reservedInputTokens: 1,
      reservedTotalTokens: 1
    }))
    assert.deepEqual(blocked, { kind: 'rejected', code: 'rpm', retryAt: Date.parse('2026-09-12T12:01:00Z') })

    ledger.releaseReservation(first.reservationId, Date.parse('2026-09-12T12:00:05Z'))
    assert.equal(ledger.admitAttempt(request('r3', {
      providerLimits: { rpm: 1, inputTpm: 10, rpd: 1000 },
      reservedInputTokens: 10,
      reservedTotalTokens: 10
    })).kind, 'admitted')
  })
})

test('RPD is scoped to the Los Angeles provider day', () => {
  withLedger(ledger => {
    const first = ledger.admitAttempt(request('day1', {
      now: Date.parse('2026-09-12T06:59:00Z'),
      providerLimits: { rpm: 100, inputTpm: 100000, rpd: 1 }
    }))
    assert.equal(first.kind, 'admitted')
    if (first.kind !== 'admitted') return
    ledger.markDispatched(first.reservationId, Date.parse('2026-09-12T06:59:01Z'))
    ledger.settleAttempt(first.reservationId, {
      now: Date.parse('2026-09-12T06:59:02Z'),
      resultClass: 'success',
      usage: { inputTokens: 1, outputTokens: 1, thoughtTokens: 0, toolTokens: 0, totalTokens: 2 }
    })

    assert.equal(ledger.admitAttempt(request('day2', {
      now: Date.parse('2026-09-12T07:00:01Z'),
      providerLimits: { rpm: 100, inputTpm: 100000, rpd: 1 }
    })).kind, 'admitted')
  })
})

test('normal Flash admission protects both 70 percent request and token ceilings', () => {
  withLedger(ledger => {
    for (let index = 0; index < 7; index += 1) {
      assert.equal(ledger.admitAttempt(request(`n${index}`, {
        flashBudget: { requestLimit: 10, totalTokenLimit: 1000 },
        reservedInputTokens: 1,
        reservedTotalTokens: 1
      })).kind, 'admitted')
    }
    assert.deepEqual(ledger.admitAttempt(request('n8', {
      flashBudget: { requestLimit: 10, totalTokenLimit: 1000 },
      reservedInputTokens: 1,
      reservedTotalTokens: 1
    })), { kind: 'rejected', code: 'flash_request_budget', retryAt: Date.parse('2026-09-13T07:00:00Z') })
  })

  withLedger(ledger => {
    assert.equal(ledger.admitAttempt(request('tokens1', {
      flashBudget: { requestLimit: 100, totalTokenLimit: 100 },
      reservedInputTokens: 30,
      reservedTotalTokens: 60
    })).kind, 'admitted')
    assert.deepEqual(ledger.admitAttempt(request('tokens2', {
      flashBudget: { requestLimit: 100, totalTokenLimit: 100 },
      reservedInputTokens: 10,
      reservedTotalTokens: 11
    })), { kind: 'rejected', code: 'flash_token_budget', retryAt: Date.parse('2026-09-13T07:00:00Z') })
  })
})

test('reserve admission may use the full Flash policy budget while normal remains protected', () => {
  withLedger(ledger => {
    assert.equal(ledger.admitAttempt(request('normal', {
      flashBudget: { requestLimit: 10, totalTokenLimit: 100 },
      reservedInputTokens: 30,
      reservedTotalTokens: 70
    })).kind, 'admitted')
    assert.equal(ledger.admitAttempt(request('reserve', {
      budgetClass: 'reserve',
      flashBudget: { requestLimit: 10, totalTokenLimit: 100 },
      reservedInputTokens: 10,
      reservedTotalTokens: 30
    })).kind, 'admitted')
  })
})

test('settlement records budget overrun truthfully instead of relabelling a normal attempt as reserve', () => {
  withLedger(ledger => {
    const first = ledger.admitAttempt(request('overrun', {
      flashBudget: { requestLimit: 100, totalTokenLimit: 100 },
      reservedInputTokens: 30,
      reservedTotalTokens: 60
    }))
    assert.equal(first.kind, 'admitted')
    if (first.kind !== 'admitted') return
    ledger.markDispatched(first.reservationId, Date.parse('2026-09-12T12:00:01Z'))
    ledger.settleAttempt(first.reservationId, {
      now: Date.parse('2026-09-12T12:00:02Z'),
      resultClass: 'success',
      usage: { inputTokens: 40, outputTokens: 10, thoughtTokens: 20, toolTokens: 5, totalTokens: 75 }
    })

    const domain = ledger.adminSnapshot(Date.parse('2026-09-12T12:00:03Z'))[0]?.domains[0]
    assert.equal(domain?.budgetOverrunCount, 1)
    assert.equal(domain?.normalTotalTokens, 75)
  })
})

test('domain cooldown, quota-unavailable state, and process credential health are separate', () => {
  withLedger(ledger => {
    const now = Date.parse('2026-09-12T12:00:00Z')
    assert.equal(ledger.recordTransientFailure('pool-a', 'gemini-3.8-flash', now), 5000)
    assert.equal(ledger.recordTransientFailure('pool-a', 'gemini-3.8-flash', now + 5000), 15000)
    assert.deepEqual(ledger.domainAvailability('pool-a', 'gemini-3.8-flash', now + 6000), {
      available: false,
      retryAt: now + 20000
    })
    ledger.recordDomainSuccess('pool-a', 'gemini-3.8-flash')
    assert.deepEqual(ledger.domainAvailability('pool-a', 'gemini-3.8-flash', now + 6000), {
      available: true,
      retryAt: null
    })

    ledger.markQuotaUnavailable('pool-a', 'gemini-3.8-flash', now + 60000, 'quota_exceeded')
    assert.deepEqual(ledger.domainAvailability('pool-a', 'gemini-3.8-flash', now + 10000), {
      available: false,
      retryAt: now + 60000
    })

    ledger.disableCredentialForProcess('pool-a', 'process-1', 'authentication', now)
    assert.equal(ledger.credentialDisabled('pool-a', 'process-1'), true)
    assert.equal(ledger.credentialDisabled('pool-a', 'process-2'), false)
  })
})
