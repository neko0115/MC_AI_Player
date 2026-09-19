import assert from 'node:assert/strict'
import {
  createServer,
  type RequestListener,
  type Server
} from 'node:http'
import test from 'node:test'
import {
  MoxueBridgeWorkspaceSelections
} from '../../src/minecraft/moxuebridge-workspace-selections.js'

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
    server.listen(
      0,
      '127.0.0.1',
      () => {
        server.off('error', reject)
        resolve()
      }
    )
  })

  const address = server.address()
  if (
    !address ||
    typeof address === 'string'
  ) {
    throw new Error(
      'test server did not bind to TCP'
    )
  }

  return {
    server,
    baseUrl:
      `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>(
        (resolve, reject) => {
          server.close(error => {
            if (error) reject(error)
            else resolve()
          })
        }
      )
    }
  }
}

function wireSnapshot() {
  return {
    version: 1,
    generated_at: 1_100,
    selections: [{
      id: 'selection-1',
      generation: 2,
      dimension: 'overworld',
      player_id: 'player-1',
      player_name: 'Boss',
      point_a: {
        x: 0,
        y: 64,
        z: 0
      },
      point_b: {
        x: 8,
        y: 64,
        z: 8
      },
      selected_at: 1_000
    }]
  }
}

test('loads authenticated workspace selections and injects the MC connection world key', async t => {
  let authorization = ''
  let path = ''

  const fixture = await createTestServer(
    (request, response) => {
      authorization =
        request.headers.authorization ?? ''
      path = request.url ?? ''
      response.setHeader(
        'content-type',
        'application/json'
      )
      response.end(
        JSON.stringify(wireSnapshot())
      )
    }
  )
  t.after(() => fixture.close())

  const source =
    new MoxueBridgeWorkspaceSelections({
      baseUrl: fixture.baseUrl,
      bearerToken: 'secret-token',
      worldKey: 'localhost:25565',
      timeoutMs: 1_000,
      maxSelectionAgeMs: 10_000,
      now: () => 1_200
    })

  assert.equal(await source.refresh(), true)
  assert.equal(
    authorization,
    'Bearer secret-token'
  )
  assert.equal(
    path,
    '/api/v1/workspace-selections'
  )

  assert.deepEqual(
    source.latest({
      worldKey: 'localhost:25565',
      dimension: 'overworld',
      playerId: 'player-1'
    }),
    {
      id: 'selection-1',
      generation: 2,
      worldKey: 'localhost:25565',
      dimension: 'overworld',
      playerId: 'player-1',
      playerName: 'Boss',
      pointA: {
        x: 0,
        y: 64,
        z: 0
      },
      pointB: {
        x: 8,
        y: 64,
        z: 8
      },
      selectedAt: 1_000
    }
  )
})

test('bridge refresh failure makes last-known-good selection unavailable for new actions', async t => {
  let healthy = true
  const fixture = await createTestServer(
    (_request, response) => {
      if (!healthy) {
        response.statusCode = 503
        response.end('unavailable')
        return
      }

      response.setHeader(
        'content-type',
        'application/json'
      )
      response.end(
        JSON.stringify(wireSnapshot())
      )
    }
  )
  t.after(() => fixture.close())

  const source =
    new MoxueBridgeWorkspaceSelections({
      baseUrl: fixture.baseUrl,
      bearerToken: 'secret-token',
      worldKey: 'localhost:25565',
      timeoutMs: 1_000,
      maxSelectionAgeMs: 10_000,
      now: () => 1_200
    })

  assert.equal(await source.refresh(), true)
  healthy = false
  assert.equal(await source.refresh(), false)

  assert.equal(
    source.status().state,
    'stale'
  )
  assert.equal(
    source.status().lastErrorCode,
    'http_503'
  )
  assert.equal(
    source.latest({
      worldKey: 'localhost:25565',
      dimension: 'overworld',
      playerId: 'player-1'
    }),
    null
  )
})

test('malformed bridge payload never becomes a workspace selection', async t => {
  const fixture = await createTestServer(
    (_request, response) => {
      response.setHeader(
        'content-type',
        'application/json'
      )
      response.end(JSON.stringify({
        version: 1,
        generated_at: 1_100,
        selections: [{
          player_id: 'player-1',
          hidden_command: '/fill'
        }]
      }))
    }
  )
  t.after(() => fixture.close())

  const source =
    new MoxueBridgeWorkspaceSelections({
      baseUrl: fixture.baseUrl,
      bearerToken: 'secret-token',
      worldKey: 'localhost:25565',
      timeoutMs: 1_000
    })

  assert.equal(await source.refresh(), false)
  assert.equal(
    source.status().state,
    'unavailable'
  )
  assert.equal(
    source.status().lastErrorCode,
    'invalid_response'
  )
})
