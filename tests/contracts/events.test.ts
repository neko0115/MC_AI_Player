import assert from 'node:assert/strict'
import test from 'node:test'
import { RuntimeEventSchema } from '../../src/contracts/events.js'

test('runtime event contract carries current-session chat and player-left identity evidence', () => {
  assert.deepEqual(RuntimeEventSchema.parse({
    type: 'player_chat',
    at: 1,
    player: 'Boss',
    playerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    message: '墨雪跟我來'
  }), {
    type: 'player_chat',
    at: 1,
    player: 'Boss',
    playerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    message: '墨雪跟我來'
  })

  assert.deepEqual(RuntimeEventSchema.parse({
    type: 'player_left',
    at: 2,
    player: 'Boss',
    playerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  }), {
    type: 'player_left',
    at: 2,
    player: 'Boss',
    playerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  })
})

test('runtime event contract distinguishes cancellation from failure', () => {
  assert.deepEqual(RuntimeEventSchema.parse({
    type: 'goal_cancelled',
    at: 3,
    goalId: 'goal-1',
    code: 'preempted_by_player'
  }), {
    type: 'goal_cancelled',
    at: 3,
    goalId: 'goal-1',
    code: 'preempted_by_player'
  })

  assert.deepEqual(RuntimeEventSchema.parse({
    type: 'skill_cancelled',
    at: 4,
    skill: 'stay',
    code: 'operator_stop'
  }), {
    type: 'skill_cancelled',
    at: 4,
    skill: 'stay',
    code: 'operator_stop'
  })
})
