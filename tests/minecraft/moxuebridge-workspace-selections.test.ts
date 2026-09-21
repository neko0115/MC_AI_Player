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
import {
  WorkspaceManagementService
} from '../../src/workspace/management-service.js'
import {
  SqliteWorkspaceRepository
} from '../../src/workspace/sqlite-repository.js'

const HYPHENATED_PLAYER_UUID =
  'b19a556a-0e50-40ec-88db-4e587dede94c'
const CANONICAL_PLAYER_UUID =
  'b19a556a0e5040ec88db4e587dede94c'

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

function wireSnapshot(
  playerId = 'player-1'
) {
  return {
    version: 1,
    generated_at: 1_100,
    selections: [{
      id: 'selection-1',
      generation: 2,
      dimension: 'overworld',
      player_id: playerId,
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

test('canonicalizes bridge player UUIDs for both hyphenated and hyphenless selection queries', async t => {
  const fixture = await createTestServer(
    (_request, response) => {
      response.setHeader(
        'content-type',
        'application/json'
      )
      response.end(
        JSON.stringify(
          wireSnapshot(
            HYPHENATED_PLAYER_UUID
          )
        )
      )
    }
  )
  t.after(() => fixture.close())

  const source =
    new MoxueBridgeWorkspaceSelections({
      baseUrl: fixture.baseUrl,
      bearerToken: 'secret-token',
      worldKey: '127.0.0.1:25565',
      timeoutMs: 1_000,
      maxSelectionAgeMs: 10_000,
      now: () => 1_200
    })

  assert.equal(await source.refresh(), true)

  const canonical = source.latest({
    worldKey: '127.0.0.1:25565',
    dimension: 'overworld',
    playerId: CANONICAL_PLAYER_UUID
  })
  assert.equal(
    canonical?.playerId,
    CANONICAL_PLAYER_UUID
  )

  const hyphenated = source.latest({
    worldKey: '127.0.0.1:25565',
    dimension: 'overworld',
    playerId: HYPHENATED_PLAYER_UUID
  })
  assert.deepEqual(
    hyphenated,
    canonical
  )
})

test('bridge UUID canonicalization lets a trusted actor create from its current selection', async t => {
  const fixture = await createTestServer(
    (_request, response) => {
      response.setHeader(
        'content-type',
        'application/json'
      )
      response.end(
        JSON.stringify(
          wireSnapshot(
            HYPHENATED_PLAYER_UUID
          )
        )
      )
    }
  )
  t.after(() => fixture.close())

  const source =
    new MoxueBridgeWorkspaceSelections({
      baseUrl: fixture.baseUrl,
      bearerToken: 'secret-token',
      worldKey: '127.0.0.1:25565',
      timeoutMs: 1_000,
      maxSelectionAgeMs: 10_000,
      now: () => 1_200
    })
  const repository =
    new SqliteWorkspaceRepository(
      ':memory:'
    )
  t.after(() => repository.close())

  assert.equal(await source.refresh(), true)

  const management =
    new WorkspaceManagementService({
      worldKey: '127.0.0.1:25565',
      repository,
      selections: source
    })
  const workspace = management.create({
    dimension: 'overworld',
    actorPrincipal:
      CANONICAL_PLAYER_UUID,
    label: 'W5C-LiveFarm-A',
    purpose: 'farm',
    moxueUsePolicy: 'owner_only'
  })

  assert.equal(
    workspace.ownerPrincipal,
    CANONICAL_PLAYER_UUID
  )
  assert.equal(
    workspace.sourceSelectionId,
    'selection-1'
  )
})

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

test('blank bridge player identity remains an invalid response', async t => {
  const snapshot = wireSnapshot()
  snapshot.selections[0]!.player_id =
    '   '

  const fixture = await createTestServer(
    (_request, response) => {
      response.setHeader(
        'content-type',
        'application/json'
      )
      response.end(
        JSON.stringify(snapshot)
      )
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
    source.status().lastErrorCode,
    'invalid_response'
  )
})
