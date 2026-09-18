import assert from 'node:assert/strict'
import { createServer, type RequestListener, type Server } from 'node:http'
import test from 'node:test'
import { MoxueBridgeResourceCatalog } from '../../src/minecraft/moxuebridge-resources.js'

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
    throw new Error('test server did not bind')
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    }
  }
}

test('loads authoritative plugin resource semantics with authentication', async t => {
  let authorization = ''
  const fixture = await createTestServer((request, response) => {
    authorization = request.headers.authorization ?? ''
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify([
      {
        id: 'examplemod:rubber_log',
        kind: 'log',
        aliases: ['examplemod:rubber_wood'],
        block_ids: ['examplemod:rubber_log'],
        collected_item_ids: ['examplemod:rubber_log'],
        minimum_drop_count: 1,
        tool_kind: 'axe',
        forbidden_enchantments: [],
        capability_id: 'tree_felling',
        related_blocks: {
          leaves: ['examplemod:rubber_leaves']
        },
        cleanup_policy: 'remove_after_felling',
        confidence: 'authoritative'
      }
    ]))
  })
  t.after(() => fixture.close())

  const catalog = new MoxueBridgeResourceCatalog({
    baseUrl: fixture.baseUrl,
    bearerToken: 'secret-token',
    timeoutMs: 1000
  })

  assert.equal(await catalog.refresh(), true)
  assert.equal(authorization, 'Bearer secret-token')

  for (const lookup of [
    'examplemod:rubber_log',
    'examplemod:rubber_wood'
  ]) {
    const profile = catalog.resolve(lookup)
    assert.ok(profile)
    assert.deepEqual(profile.blockNames, ['examplemod:rubber_log'])
    assert.deepEqual(profile.collectedItemNames, ['examplemod:rubber_log'])
    assert.equal(profile.capabilityId, 'tree_felling')
    assert.equal(profile.minimumOnePerBlock, true)
    assert.equal(profile.toolKind, 'axe')
    assert.deepEqual(profile.relatedLeafNames, ['examplemod:rubber_leaves'])
    assert.equal(profile.leafCleanupPolicy, 'remove_after_felling')
  }
})

test('normalizes minecraft namespaced ids to Mineflayer runtime names', async t => {
  const fixture = await createTestServer((_request, response) => {
    response.end(JSON.stringify([
      {
        id: 'minecraft:oak_log',
        kind: 'log',
        aliases: [],
        block_ids: ['minecraft:oak_log'],
        collected_item_ids: ['minecraft:oak_log'],
        minimum_drop_count: 1,
        tool_kind: 'axe',
        forbidden_enchantments: [],
        capability_id: 'tree_felling',
        related_blocks: {
          leaves: ['minecraft:oak_leaves']
        },
        cleanup_policy: 'natural_decay',
        confidence: 'authoritative'
      }
    ]))
  })
  t.after(() => fixture.close())

  const catalog = new MoxueBridgeResourceCatalog({
    baseUrl: fixture.baseUrl,
    bearerToken: 'secret',
    timeoutMs: 1000
  })

  assert.equal(await catalog.refresh(), true)
  const profile = catalog.resolve('minecraft:oak_log')
  assert.ok(profile)
  assert.deepEqual(profile.blockNames, ['oak_log'])
  assert.deepEqual(profile.collectedItemNames, ['oak_log'])
  assert.deepEqual(profile.relatedLeafNames, ['oak_leaves'])
})

test('inferred resource semantics never become mutation-authoritative profiles', async t => {
  const fixture = await createTestServer((_request, response) => {
    response.end(JSON.stringify([
      {
        id: 'examplemod:mystery_ore',
        kind: 'ore',
        aliases: [],
        block_ids: ['examplemod:mystery_ore'],
        collected_item_ids: ['examplemod:mystery_dust'],
        minimum_drop_count: 1,
        tool_kind: 'pickaxe',
        forbidden_enchantments: [],
        capability_id: 'vein_mining',
        related_blocks: {},
        cleanup_policy: null,
        confidence: 'inferred'
      }
    ]))
  })
  t.after(() => fixture.close())

  const catalog = new MoxueBridgeResourceCatalog({
    baseUrl: fixture.baseUrl,
    bearerToken: 'secret',
    timeoutMs: 1000
  })

  assert.equal(await catalog.refresh(), true)
  assert.equal(catalog.resolve('examplemod:mystery_ore'), undefined)
})

test('older Bridge without resource endpoint falls back safely to static profiles', async t => {
  const fixture = await createTestServer((_request, response) => {
    response.statusCode = 404
    response.end('not found')
  })
  t.after(() => fixture.close())

  const catalog = new MoxueBridgeResourceCatalog({
    baseUrl: fixture.baseUrl,
    bearerToken: 'secret',
    timeoutMs: 1000
  })

  assert.equal(await catalog.refresh(), true)
  assert.equal(catalog.resolve('minecraft:iron_ore'), undefined)
})

test('ambiguous duplicate resource lookup keys fail closed', async t => {
  const descriptor = (id: string) => ({
    id,
    kind: 'ore',
    aliases: ['examplemod:shared'],
    block_ids: [id],
    collected_item_ids: [`${id}_drop`],
    minimum_drop_count: 1,
    tool_kind: 'pickaxe',
    forbidden_enchantments: [],
    capability_id: 'vein_mining',
    related_blocks: {},
    cleanup_policy: null,
    confidence: 'authoritative'
  })
  const fixture = await createTestServer((_request, response) => {
    response.end(JSON.stringify([
      descriptor('examplemod:ore_a'),
      descriptor('examplemod:ore_b')
    ]))
  })
  t.after(() => fixture.close())

  const catalog = new MoxueBridgeResourceCatalog({
    baseUrl: fixture.baseUrl,
    bearerToken: 'secret',
    timeoutMs: 1000
  })

  assert.equal(await catalog.refresh(), false)
  assert.equal(catalog.resolve('examplemod:shared'), undefined)
})
