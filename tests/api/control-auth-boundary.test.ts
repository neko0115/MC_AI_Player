import assert from 'node:assert/strict'
import test from 'node:test'
import { ControlServer } from '../../src/api/control-server.js'

function server(host: string) {
  return new ControlServer({
    host,
    port: 0,
    goals: {
      async submit() { throw new Error('not used') },
      activeGoal: () => null,
      queuedGoals: () => [],
      async emergencyStop() {}
    },
    state: {
      snapshot: () => ({
        connected: false,
        spawned: false,
        health: 20,
        food: 20,
        dimension: null,
        position: null,
        nearbyPlayers: [],
        inventory: [],
        recentEvents: []
      })
    },
    memory: { search: () => [] },
    events: { subscribe: () => () => {} }
  })
}

test('ControlServer itself treats loopback-lookalike DNS names as non-loopback', async () => {
  const current = server('127.example.com')
  await assert.rejects(
    () => current.start(),
    /bearer token/i
  )
})
