import assert from 'node:assert/strict'
import { createServer, type RequestListener, type Server } from 'node:http'
import test from 'node:test'
import { MoxueBridgeCapabilities } from '../../src/minecraft/moxuebridge-capabilities.js'

interface TestServer {
  readonly server: Server
  readonly baseUrl: string
  close(): Promise<void>
}

async function createTestServer(
  handler: RequestListener
): Promise<TestServer> {
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('test server did not bind to TCP')
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) reject(error)
          else resolve()
        })
      })
    }
  }
}

test('loads authenticated MoxueBridge capabilities and exposes only available entries', async t => {
  let authorization = ''
  const fixture = await createTestServer((request, response) => {
    authorization = request.headers.authorization ?? ''
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify([
      {
        id: 'vein_mining',
        name: '連鎖挖礦',
        description: '一次挖掘相連的礦物方塊',
        available: true,
        source: {
          plugin: 'VeinMiner',
          version: '2.11.2',
          provenance: 'integration'
        },
        usage: {
          trigger: 'sneak_and_break',
          human: '蹲下並使用正確的十字鎬挖掘相連礦物'
        },
        constraints: {
          max_chain: 100,
          correct_tool_required: true,
          must_sneak: true
        }
      },
      {
        id: 'disabled_feature',
        name: 'Disabled',
        description: 'Unavailable capability',
        available: false,
        source: {
          plugin: 'Example',
          version: '1.0.0',
          provenance: 'integration'
        },
        usage: {
          trigger: 'break',
          human: 'break'
        },
        constraints: {}
      }
    ]))
  })
  t.after(() => fixture.close())

  let now = 1000
  const capabilities = new MoxueBridgeCapabilities({
    baseUrl: fixture.baseUrl,
    bearerToken: 'secret-token',
    timeoutMs: 1000,
    now: () => now
  })

  assert.equal(await capabilities.refresh(), true)
  assert.equal(authorization, 'Bearer secret-token')
  assert.equal(capabilities.has('vein_mining'), true)
  assert.equal(capabilities.has('disabled_feature'), false)
  assert.equal(capabilities.get('vein_mining')?.usage.trigger, 'sneak_and_break')
  assert.deepEqual(capabilities.status(), {
    state: 'current',
    lastSuccessAt: 1000,
    lastErrorCode: null
  })

  now = 2000
  const snapshot = capabilities.snapshot()
  assert.equal(snapshot.length, 1)
  assert.equal(snapshot[0]?.id, 'vein_mining')
})

test('retains last-known-good capabilities and marks them stale after a refresh failure', async t => {
  let healthy = true
  const fixture = await createTestServer((_request, response) => {
    if (!healthy) {
      response.statusCode = 503
      response.end('unavailable')
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify([
      {
        id: 'tree_felling',
        name: '連鎖伐木',
        description: '一次砍伐相連的原木方塊',
        available: true,
        source: {
          plugin: 'VeinMiner',
          version: '2.11.2',
          provenance: 'integration'
        },
        usage: {
          trigger: 'sneak_and_break',
          human: '蹲下並使用斧頭砍伐相連原木'
        },
        constraints: {
          max_chain: 100,
          correct_tool_required: true,
          must_sneak: true
        }
      }
    ]))
  })
  t.after(() => fixture.close())

  const capabilities = new MoxueBridgeCapabilities({
    baseUrl: fixture.baseUrl,
    bearerToken: 'secret-token',
    timeoutMs: 1000,
    now: () => 1234
  })

  assert.equal(await capabilities.refresh(), true)
  healthy = false
  assert.equal(await capabilities.refresh(), false)

  assert.equal(capabilities.has('tree_felling'), true)
  assert.deepEqual(capabilities.status(), {
    state: 'stale',
    lastSuccessAt: 1234,
    lastErrorCode: 'http_503'
  })
})

test('fails closed on malformed capability payloads', async t => {
  const fixture = await createTestServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify([{ id: 'vein_mining' }]))
  })
  t.after(() => fixture.close())

  const capabilities = new MoxueBridgeCapabilities({
    baseUrl: fixture.baseUrl,
    bearerToken: 'secret-token',
    timeoutMs: 1000
  })

  assert.equal(await capabilities.refresh(), false)
  assert.deepEqual(capabilities.snapshot(), [])
  assert.equal(capabilities.status().state, 'unavailable')
  assert.equal(capabilities.status().lastErrorCode, 'invalid_response')
})


test('accepts additive future fields but strips them from the capability snapshot', async t => {
  const fixture = await createTestServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify([
      {
        id: 'vein_mining',
        name: '連鎖挖礦',
        description: '一次挖掘相連的礦物方塊',
        available: true,
        future_top_level: 'ignored',
        source: {
          plugin: 'VeinMiner',
          version: '2.11.2',
          provenance: 'integration',
          future_source_field: 'ignored'
        },
        usage: {
          trigger: 'sneak_and_break',
          human: '蹲下並使用正確的十字鎬挖掘相連礦物',
          future_usage_field: 'ignored'
        },
        constraints: {
          max_chain: 100
        }
      }
    ]))
  })
  t.after(() => fixture.close())

  const capabilities = new MoxueBridgeCapabilities({
    baseUrl: fixture.baseUrl,
    bearerToken: 'secret-token',
    timeoutMs: 1000
  })

  assert.equal(await capabilities.refresh(), true)
  const [capability] = capabilities.snapshot()
  assert.ok(capability)
  assert.equal('future_top_level' in capability, false)
  assert.equal('future_source_field' in capability.source, false)
  assert.equal('future_usage_field' in capability.usage, false)
})

test('duplicate available capability ids fail closed instead of selecting an ambiguous definition', async t => {
  const capability = {
    id: 'vein_mining',
    name: '連鎖挖礦',
    description: '一次挖掘相連的礦物方塊',
    available: true,
    source: {
      plugin: 'VeinMiner',
      version: '2.11.2',
      provenance: 'integration'
    },
    usage: {
      trigger: 'sneak_and_break',
      human: '蹲下並使用正確的十字鎬挖掘相連礦物'
    },
    constraints: {
      max_chain: 100
    }
  }
  const fixture = await createTestServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify([capability, capability]))
  })
  t.after(() => fixture.close())

  const capabilities = new MoxueBridgeCapabilities({
    baseUrl: fixture.baseUrl,
    bearerToken: 'secret-token',
    timeoutMs: 1000
  })

  assert.equal(await capabilities.refresh(), false)
  assert.deepEqual(capabilities.snapshot(), [])
  assert.equal(capabilities.status().lastErrorCode, 'invalid_response')
})

