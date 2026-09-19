import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WorkspaceSelectionSnapshotSchema
} from '../../src/workspace/contracts.js'
import {
  WorkspaceSelectionTracker
} from '../../src/workspace/selection-source.js'

function selection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'selection-1',
    generation: 1,
    worldKey: 'server:survival',
    dimension: 'overworld',
    playerId: 'player-1',
    playerName: 'Boss',
    pointA: { x: 0, y: 64, z: 0 },
    pointB: { x: 8, y: 64, z: 8 },
    selectedAt: 1_000,
    ...overrides
  }
}

function snapshot(
  selections = [selection()],
  generatedAt = 1_100
) {
  return {
    version: 1,
    generatedAt,
    selections
  }
}

test('selection snapshot contract is strict and bounded', () => {
  assert.equal(
    WorkspaceSelectionSnapshotSchema.safeParse(
      snapshot()
    ).success,
    true
  )

  assert.equal(
    WorkspaceSelectionSnapshotSchema.safeParse({
      ...snapshot(),
      rawCommand: '/fill'
    }).success,
    false
  )
})

test('tracker is unavailable before the first valid snapshot and exposes a fresh current selection afterward', () => {
  let now = 1_200
  const tracker = new WorkspaceSelectionTracker({
    now: () => now,
    maxSelectionAgeMs: 5_000
  })

  assert.deepEqual(tracker.status(), {
    state: 'unavailable',
    lastSuccessAt: null,
    lastErrorCode: null
  })
  assert.equal(
    tracker.latest({
      worldKey: 'server:survival',
      dimension: 'overworld',
      playerId: 'player-1'
    }),
    null
  )

  assert.equal(tracker.refresh(snapshot()), true)
  assert.deepEqual(tracker.status(), {
    state: 'current',
    lastSuccessAt: 1_200,
    lastErrorCode: null
  })

  const latest = tracker.latest({
    worldKey: 'server:survival',
    dimension: 'overworld',
    playerId: 'player-1'
  })
  assert.ok(latest)
  assert.equal(latest.id, 'selection-1')

  latest.pointA.x = 99
  assert.equal(
    tracker.latest({
      worldKey: 'server:survival',
      dimension: 'overworld',
      playerId: 'player-1'
    })?.pointA.x,
    0
  )
})

test('malformed refresh turns a previously current source stale and hides last-known-good selection', () => {
  const tracker = new WorkspaceSelectionTracker({
    now: () => 1_200,
    maxSelectionAgeMs: 5_000
  })

  assert.equal(tracker.refresh(snapshot()), true)
  assert.equal(
    tracker.refresh({
      version: 1,
      generatedAt: 1_300,
      selections: [{
        ...selection(),
        hiddenMutation: true
      }]
    }),
    false
  )

  assert.deepEqual(tracker.status(), {
    state: 'stale',
    lastSuccessAt: 1_200,
    lastErrorCode: 'invalid_selection_snapshot'
  })
  assert.equal(
    tracker.latest({
      worldKey: 'server:survival',
      dimension: 'overworld',
      playerId: 'player-1'
    }),
    null
  )
})

test('older selection snapshots cannot overwrite a newer accepted generation', () => {
  let now = 2_200
  const tracker = new WorkspaceSelectionTracker({
    now: () => now,
    maxSelectionAgeMs: 10_000
  })

  assert.equal(
    tracker.refresh(snapshot([
      selection({
        id: 'selection-new',
        generation: 3,
        selectedAt: 2_000
      })
    ])),
    true
  )

  now = 2_300
  assert.equal(
    tracker.refresh(snapshot([
      selection({
        id: 'selection-old',
        generation: 2,
        selectedAt: 1_900
      })
    ], 2_250)),
    false
  )

  assert.equal(tracker.status().state, 'stale')

  now = 2_400
  assert.equal(
    tracker.refresh(snapshot([
      selection({
        id: 'selection-newer',
        generation: 4,
        selectedAt: 2_350
      })
    ], 2_360)),
    true
  )

  assert.equal(
    tracker.latest({
      worldKey: 'server:survival',
      dimension: 'overworld',
      playerId: 'player-1'
    })?.id,
    'selection-newer'
  )
})

test('same generation and timestamp with conflicting geometry fails closed', () => {
  const tracker = new WorkspaceSelectionTracker({
    now: () => 1_500,
    maxSelectionAgeMs: 5_000
  })

  assert.equal(tracker.refresh(snapshot()), true)
  assert.equal(
    tracker.refresh(snapshot([
      selection({
        pointB: { x: 99, y: 64, z: 99 }
      })
    ], 1_200)),
    false
  )
  assert.equal(
    tracker.status().lastErrorCode,
    'selection_generation_conflict'
  )
})

test('latest selection is isolated by world, dimension and player identity', () => {
  const tracker = new WorkspaceSelectionTracker({
    now: () => 1_500,
    maxSelectionAgeMs: 5_000
  })

  assert.equal(
    tracker.refresh(snapshot([
      selection(),
      selection({
        id: 'selection-player-2',
        playerId: 'player-2',
        playerName: 'Friend'
      }),
      selection({
        id: 'selection-nether',
        dimension: 'the_nether'
      })
    ])),
    true
  )

  assert.equal(
    tracker.latest({
      worldKey: 'server:survival',
      dimension: 'overworld',
      playerId: 'player-2'
    })?.id,
    'selection-player-2'
  )
  assert.equal(
    tracker.latest({
      worldKey: 'server:survival',
      dimension: 'the_nether',
      playerId: 'player-1'
    })?.id,
    'selection-nether'
  )
  assert.equal(
    tracker.latest({
      worldKey: 'other:world',
      dimension: 'overworld',
      playerId: 'player-1'
    }),
    null
  )
})

test('expired selections fail closed even while source sync remains current', () => {
  let now = 1_200
  const tracker = new WorkspaceSelectionTracker({
    now: () => now,
    maxSelectionAgeMs: 500
  })

  assert.equal(tracker.refresh(snapshot()), true)
  assert.ok(
    tracker.latest({
      worldKey: 'server:survival',
      dimension: 'overworld',
      playerId: 'player-1'
    })
  )

  now = 1_501
  assert.equal(
    tracker.latest({
      worldKey: 'server:survival',
      dimension: 'overworld',
      playerId: 'player-1'
    }),
    null
  )
  assert.equal(tracker.status().state, 'current')
})

test('successful empty snapshot clears prior selections without becoming stale', () => {
  const tracker = new WorkspaceSelectionTracker({
    now: () => 2_000,
    maxSelectionAgeMs: 5_000
  })

  assert.equal(tracker.refresh(snapshot()), true)
  assert.equal(
    tracker.refresh(snapshot([], 1_900)),
    true
  )

  assert.equal(tracker.status().state, 'current')
  assert.equal(
    tracker.latest({
      worldKey: 'server:survival',
      dimension: 'overworld',
      playerId: 'player-1'
    }),
    null
  )
})
