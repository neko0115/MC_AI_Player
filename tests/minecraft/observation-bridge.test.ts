import assert from 'node:assert/strict'
import test from 'node:test'
import { ObservationBridge } from '../../src/minecraft/observation-bridge.js'

const bridge = new ObservationBridge(() => 1234)

const botView = {
  game: { dimension: 'overworld' },
  entity: { position: { x: 10.25, y: 64, z: -3.5 } },
  health: 18,
  food: 16,
  inventory: {
    items: () => [
      { name: 'oak_log', count: 4, slot: 9 },
      { name: 'bread', count: 2, slot: 10 }
    ]
  }
}

test('spawn maps to a bounded spawned event', () => {
  assert.deepEqual(bridge.spawned(botView), {
    type: 'spawned',
    at: 1234,
    dimension: 'overworld',
    position: { x: 10.25, y: 64, z: -3.5 },
    health: 18,
    food: 16
  })
})

test('player entity appearance maps identity and position', () => {
  assert.deepEqual(
    bridge.playerSeen({
      username: 'Boss',
      uuid: 'player-uuid',
      entity: { position: { x: 2, y: 65, z: 7 } }
    }),
    {
      type: 'player_seen',
      at: 1234,
      player: {
        name: 'Boss',
        id: 'player-uuid',
        position: { x: 2, y: 65, z: 7 }
      }
    }
  )
})

test('player info without a spawned entity is not treated as a positioned player', () => {
  assert.equal(
    bridge.playerSeen({
      username: 'Boss',
      uuid: 'player-uuid',
      entity: undefined
    }),
    null
  )
})

test('hostile observations expose only bounded semantic identity and position', () => {
  assert.deepEqual(
    bridge.hostileSeen({
      id: 42,
      name: 'creeper',
      position: { x: 4, y: 64, z: -2 }
    }),
    {
      type: 'hostile_seen',
      at: 1234,
      hostile: {
        entityId: 42,
        kind: 'creeper',
        position: { x: 4, y: 64, z: -2 }
      }
    }
  )

  assert.deepEqual(bridge.hostileLeft(42), {
    type: 'hostile_left',
    at: 1234,
    entityId: 42
  })
})

test('chat carries current-session identity evidence and player-left invalidates it', () => {
  assert.deepEqual(bridge.chat('Boss', '跟我來', 'player-uuid'), {
    type: 'player_chat',
    at: 1234,
    player: 'Boss',
    playerId: 'player-uuid',
    message: '跟我來'
  })
  assert.deepEqual(bridge.playerLeft('Boss', 'player-uuid'), {
    type: 'player_left',
    at: 1234,
    player: 'Boss',
    playerId: 'player-uuid'
  })
})

test('chat may remain unprivileged when no current UUID evidence exists', () => {
  assert.deepEqual(bridge.chat('Guest', 'hello'), {
    type: 'player_chat',
    at: 1234,
    player: 'Guest',
    message: 'hello'
  })
})

test('health is normalized without raw provider data', () => {
  assert.deepEqual(bridge.health(botView), {
    type: 'health_changed',
    at: 1234,
    health: 18,
    food: 16
  })
})

test('inventory update becomes a current bounded snapshot', () => {
  assert.deepEqual(bridge.inventory(botView), {
    type: 'inventory_changed',
    at: 1234,
    items: [
      { name: 'oak_log', count: 4, slot: 9 },
      { name: 'bread', count: 2, slot: 10 }
    ]
  })
})

test('kicked, error and end map to explicit connection events', () => {
  assert.deepEqual(bridge.kicked('duplicate login'), {
    type: 'adapter_error',
    at: 1234,
    code: 'kicked',
    message: 'duplicate login'
  })
  assert.deepEqual(bridge.error(new Error('socket failed')), {
    type: 'adapter_error',
    at: 1234,
    code: 'error',
    message: 'socket failed'
  })
  assert.deepEqual(bridge.ended('socketClosed'), {
    type: 'disconnected',
    at: 1234,
    reason: 'socketClosed'
  })
})
