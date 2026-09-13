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

test('safe AI telemetry schemas accept only bounded routing metadata', () => {
  const events = [
    {
      type: 'complexity_assessment', at: 10, decisionId: 'decision-1', taskId: 'task-1',
      score: 6, routeClass: 'complex', thinking: 'medium',
      reasons: ['multi_step', 'goal_failed'], highReason: null
    },
    {
      type: 'model_route', at: 11, decisionId: 'decision-1',
      model: 'gemini-3.8-flash', thinking: 'medium', project: 'backup-1',
      reasons: ['multi_step'], reserveAuthorized: false, reserveUsed: false
    },
    {
      type: 'attempt_result', at: 12, decisionId: 'decision-1',
      model: 'gemini-3.8-flash', project: 'backup-1', result: 'transient',
      safeCode: 'rate_limit_exceeded'
    },
    { type: 'ai_availability_changed', at: 13, available: false, retryAt: 20_000 },
    { type: 'task_started', at: 14, taskId: 'task-1', source: 'minecraft' },
    { type: 'task_completed', at: 15, taskId: 'task-1' },
    { type: 'task_blocked', at: 16, taskId: 'task-2', code: 'missing_information' },
    { type: 'task_superseded', at: 17, taskId: 'task-3', code: 'preempted_by_player' }
  ] as const

  for (const event of events) {
    assert.deepEqual(RuntimeEventSchema.parse(event), event)
  }
})

test('AI telemetry schema rejects prompt objective identity credential and raw error fields', () => {
  const safeRoute = {
    type: 'model_route', at: 20, decisionId: 'decision-1',
    model: 'gemini-3.8-flash', thinking: 'high', project: 'primary',
    reasons: ['manual_deep_think'], reserveAuthorized: true, reserveUsed: true
  }
  for (const forbidden of [
    { prompt: 'secret prompt' },
    { objective: 'private task text' },
    { playerUuid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    { projectKey: 'google-project-real-name' },
    { apiKey: 'SECRET_KEY' },
    { rawError: 'provider stack trace SECRET_KEY' }
  ]) {
    assert.equal(RuntimeEventSchema.safeParse({ ...safeRoute, ...forbidden }).success, false)
  }
})
