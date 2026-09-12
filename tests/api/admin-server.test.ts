import assert from 'node:assert/strict'
import test from 'node:test'
import type { AdminQuotaProjectSnapshot } from '../../src/agent/routing/quota-ledger.js'
import type {
  RoutingConfigSnapshot,
  RoutingReloadResult
} from '../../src/agent/routing/config-manager.js'
import type {
  AdminDeepThinkRequest,
  CoordinatorCommandResult
} from '../../src/runtime/decision-coordinator.js'
import { AdminServer } from '../../src/api/admin-server.js'

class FakeQuota {
  snapshots: readonly AdminQuotaProjectSnapshot[] = []
  nowValues: number[] = []

  adminSnapshot(now: number): readonly AdminQuotaProjectSnapshot[] {
    this.nowValues.push(now)
    return structuredClone(this.snapshots)
  }
}

class FakeRouting {
  reloadResult: RoutingReloadResult = {
    kind: 'reloaded', generation: 2, authorizationChanged: false
  }
  reloadCalls = 0
  current: RoutingConfigSnapshot = {
    generation: 1,
    models: {
      routine: {
        name: 'gemini-3.5-flash-lite',
        reservation: {
          inputTokenOverhead: 16,
          generationTokenAllowance: { low: 64 }
        }
      },
      complex: {
        name: 'gemini-3.8-flash',
        reservation: {
          inputTokenOverhead: 32,
          generationTokenAllowance: { medium: 128, high: 256 }
        }
      }
    },
    projects: [
      {
        projectKey: 'internal-project-a', credentialHandle: 'secret-handle-a',
        providerLimits: {
          routine: { rpm: 10, inputTpm: 10_000, rpd: 100 },
          complex: { rpm: 5, inputTpm: 5_000, rpd: 50 }
        },
        flashBudget: {
          requestLimit: 50,
          totalTokenLimit: 50_000,
          resetWindow: 'america-los-angeles-day',
          source: 'operator_policy'
        }
      },
      {
        projectKey: 'internal-project-b', credentialHandle: 'secret-handle-b',
        providerLimits: {
          routine: { rpm: 10, inputTpm: 10_000, rpd: 100 },
          complex: { rpm: 5, inputTpm: 5_000, rpd: 50 }
        },
        flashBudget: {
          requestLimit: 50,
          totalTokenLimit: 50_000,
          resetWindow: 'america-los-angeles-day',
          source: 'operator_policy'
        }
      }
    ],
    manualAccess: {
      ownerUuid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      operatorAllowlistUuids: []
    }
  }

  reload(): RoutingReloadResult {
    this.reloadCalls += 1
    if (this.reloadResult.kind === 'reloaded') {
      this.current = { ...this.current, generation: this.reloadResult.generation }
    }
    return this.reloadResult
  }

  snapshot(): RoutingConfigSnapshot {
    return this.current
  }
}

class FakeCoordinator {
  readonly requests: AdminDeepThinkRequest[] = []
  invalidateCalls = 0

  async submitAdminDeepThink(request: AdminDeepThinkRequest): Promise<CoordinatorCommandResult> {
    this.requests.push(structuredClone(request))
    return { kind: 'accepted', taskId: `task-${this.requests.length}` }
  }

  invalidateManualGrants(): void {
    this.invalidateCalls += 1
  }
}

function dependencies() {
  const quota = new FakeQuota()
  const routing = new FakeRouting()
  const coordinator = new FakeCoordinator()
  const server = new AdminServer({
    port: 0,
    bearerToken: 'ADMIN_TOKEN_DO_NOT_LEAK',
    quota,
    routing,
    coordinator,
    now: () => 1_234
  })
  return { server, quota, routing, coordinator }
}

async function started() {
  const current = dependencies()
  const address = await current.server.start()
  return { ...current, address }
}

function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: 'Bearer ADMIN_TOKEN_DO_NOT_LEAK',
    ...extra
  }
}

async function body(response: Response): Promise<any> {
  return response.json()
}

test('AdminServer has no configurable bind host and always listens on IPv4 loopback', async () => {
  const current = await started()
  try {
    assert.equal(current.address.host, '127.0.0.1')
    assert.match(current.address.baseUrl, /^http:\/\/127\.0\.0\.1:/)
    assert.equal('host' in (current.server as unknown as Record<string, unknown>), false)
  } finally {
    await current.server.close()
  }
})

test('every Admin endpoint requires the dedicated bearer and never echoes supplied secrets', async () => {
  const current = await started()
  try {
    for (const authorization of [undefined, 'Bearer wrong', 'Bearer CONTROL_TOKEN_DO_NOT_ACCEPT']) {
      const headers = authorization ? { authorization } : {}
      const response = await fetch(`${current.address.baseUrl}/v1/admin/ai-quota`, { headers })
      assert.equal(response.status, 401)
      const text = await response.text()
      assert.equal(text.includes('wrong'), false)
      assert.equal(text.includes('CONTROL_TOKEN_DO_NOT_ACCEPT'), false)
      assert.equal(text.includes('ADMIN_TOKEN_DO_NOT_LEAK'), false)
    }

    const valid = await fetch(`${current.address.baseUrl}/v1/admin/ai-quota`, {
      headers: adminHeaders()
    })
    assert.equal(valid.status, 200)
  } finally {
    await current.server.close()
  }
})

test('quota endpoint exposes anonymous project labels and safe metrics without internal keys or credential handles', async () => {
  const current = dependencies()
  current.quota.snapshots = [{
    projectKey: 'internal-project-a',
    domains: [{
      model: 'gemini-3.8-flash',
      rollingRequests: 2,
      rollingInputTokens: 120,
      dayRequests: 3,
      dayInputTokens: 150,
      dayTotalTokens: 220,
      normalRequests: 2,
      normalTotalTokens: 140,
      reserveRequests: 1,
      reserveTotalTokens: 80,
      budgetOverrunCount: 0,
      transientFailureCount: 1,
      cooldownUntil: 2_000,
      quotaUnavailableUntil: null,
      lastSafeError: 'transient',
      lastSafeErrorAt: 1_100
    }]
  }]
  const address = await current.server.start()
  try {
    const response = await fetch(`${address.baseUrl}/v1/admin/ai-quota`, {
      headers: adminHeaders()
    })
    assert.equal(response.status, 200)
    const payload = await body(response)
    assert.equal(JSON.stringify(payload).includes('internal-project-a'), false)
    assert.equal(JSON.stringify(payload).includes('secret-handle-a'), false)
    assert.equal(JSON.stringify(payload).includes('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), false)
    assert.equal(current.quota.nowValues.at(-1), 1_234)
    assert.deepEqual(payload.projects, [{
      project: 'primary',
      domains: current.quota.snapshots[0]?.domains
    }])
  } finally {
    await current.server.close()
  }
})

test('reload returns the new generation, keeps rejection safe, and invalidates grants only when authorization changes', async () => {
  const current = await started()
  try {
    current.routing.reloadResult = {
      kind: 'reloaded', generation: 7, authorizationChanged: true
    }
    const reloaded = await fetch(`${current.address.baseUrl}/v1/admin/ai-routing/reload`, {
      method: 'POST', headers: adminHeaders()
    })
    assert.equal(reloaded.status, 200)
    assert.deepEqual(await body(reloaded), { reloaded: true, generation: 7 })
    assert.equal(current.coordinator.invalidateCalls, 1)

    current.routing.reloadResult = { kind: 'rejected', code: 'invalid_config' }
    const rejected = await fetch(`${current.address.baseUrl}/v1/admin/ai-routing/reload`, {
      method: 'POST', headers: adminHeaders()
    })
    assert.equal(rejected.status, 400)
    assert.deepEqual(await body(rejected), { error: 'invalid_config' })
    assert.equal(current.coordinator.invalidateCalls, 1)
  } finally {
    await current.server.close()
  }
})

test('deep-think requires strict bounded input and Idempotency-Key', async () => {
  const current = await started()
  try {
    const missingKey = await fetch(`${current.address.baseUrl}/v1/admin/ai/deep-think`, {
      method: 'POST',
      headers: adminHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ instruction: 'plan safely' })
    })
    assert.equal(missingKey.status, 400)

    const invalid = await fetch(`${current.address.baseUrl}/v1/admin/ai/deep-think`, {
      method: 'POST',
      headers: adminHeaders({
        'content-type': 'application/json',
        'idempotency-key': 'deep-invalid'
      }),
      body: JSON.stringify({ instruction: '', project: 'pick-me', reserve: true })
    })
    assert.equal(invalid.status, 400)
    assert.equal(current.coordinator.requests.length, 0)

    const accepted = await fetch(`${current.address.baseUrl}/v1/admin/ai/deep-think`, {
      method: 'POST',
      headers: adminHeaders({
        'content-type': 'application/json',
        'idempotency-key': 'deep-1'
      }),
      body: JSON.stringify({ instruction: 'plan safely', target_goal_id: 'goal-7' })
    })
    assert.equal(accepted.status, 202)
    assert.deepEqual(await body(accepted), { accepted: true, task_id: 'task-1' })
    assert.deepEqual(current.coordinator.requests, [{
      instruction: 'plan safely', targetGoalId: 'goal-7'
    }])
  } finally {
    await current.server.close()
  }
})

test('deep-think idempotency returns the original response for same key/body and 409 for key reuse with different body', async () => {
  const current = await started()
  try {
    const request = (instruction: string) => fetch(`${current.address.baseUrl}/v1/admin/ai/deep-think`, {
      method: 'POST',
      headers: adminHeaders({
        'content-type': 'application/json',
        'idempotency-key': 'same-key'
      }),
      body: JSON.stringify({ instruction })
    })

    const first = await request('first instruction')
    assert.equal(first.status, 202)
    const firstBody = await body(first)
    const replay = await request('first instruction')
    assert.equal(replay.status, 202)
    assert.deepEqual(await body(replay), firstBody)
    assert.equal(current.coordinator.requests.length, 1)

    const conflict = await request('different instruction')
    assert.equal(conflict.status, 409)
    assert.deepEqual(await body(conflict), { error: 'idempotency_conflict' })
    assert.equal(current.coordinator.requests.length, 1)
  } finally {
    await current.server.close()
  }
})

test('idempotency cache is capped at 256 entries and evicts oldest first', async () => {
  const current = await started()
  try {
    const send = (key: string, instruction: string) => fetch(`${current.address.baseUrl}/v1/admin/ai/deep-think`, {
      method: 'POST',
      headers: adminHeaders({
        'content-type': 'application/json',
        'idempotency-key': key
      }),
      body: JSON.stringify({ instruction })
    })

    for (let index = 0; index < 257; index += 1) {
      const response = await send(`key-${index}`, `instruction-${index}`)
      assert.equal(response.status, 202)
    }
    assert.equal(current.coordinator.requests.length, 257)

    const replayOldest = await send('key-0', 'instruction-0')
    assert.equal(replayOldest.status, 202)
    assert.equal(current.coordinator.requests.length, 258)

    const replayNewest = await send('key-256', 'instruction-256')
    assert.equal(replayNewest.status, 202)
    assert.equal(current.coordinator.requests.length, 258)
  } finally {
    await current.server.close()
  }
})
