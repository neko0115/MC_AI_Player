import assert from 'node:assert/strict'
import test from 'node:test'
import { TriggerClassifier } from '../../src/runtime/trigger-classifier.js'

const classifier = new TriggerClassifier({ botUsername: 'Moxue_Test' })
const active = { taskId: 'task-1', activeGoalId: 'goal-1' }

test('state observations and cooperative pickup update context without creating AI demand', () => {
  for (const event of [
    { type: 'position_changed' as const, at: 1, position: { x: 1, y: 64, z: 2 } },
    { type: 'inventory_changed' as const, at: 2, items: [{ name: 'oak_log', count: 1 }] },
    { type: 'cooperative_pickup' as const, at: 3, resource: 'oak_log', player: 'Boss', interceptedCount: 1, remaining: 2 }
  ]) {
    assert.deepEqual(classifier.classify(event, active), { kind: 'state_only' })
  }
})

test('only deterministically addressed chat creates an explicit instruction', () => {
  assert.deepEqual(classifier.classify({
    type: 'player_chat', at: 1, player: 'Boss', message: '大家晚安'
  }, active), { kind: 'state_only' })

  const addressed = classifier.classify({
    type: 'player_chat', at: 2, player: 'Boss', playerId: 'uuid-1',
    message: '墨雪，採木頭然後回基地放箱子'
  }, active)
  assert.equal(addressed.kind, 'explicit_instruction')
  if (addressed.kind !== 'explicit_instruction') return
  assert.equal(addressed.instruction, '採木頭然後回基地放箱子')
  assert.equal(addressed.player, 'Boss')
  assert.equal(addressed.playerId, 'uuid-1')
  assert.equal(addressed.baseComplexityEvidence.multiStep, true)
  assert.equal(addressed.baseComplexityEvidence.multiSkill, true)
})

test('CJK bot address may directly prefix an instruction without whitespace', () => {
  const addressed = classifier.classify({
    type: 'player_chat',
    at: 3,
    player: 'Boss',
    message: '墨雪幫我採一組石頭'
  }, active)

  assert.equal(addressed.kind, 'explicit_instruction')
  if (addressed.kind !== 'explicit_instruction') return
  assert.equal(addressed.instruction, '幫我採一組石頭')
})

test('configured bot username and moxue aliases are deterministic addresses', () => {
  for (const message of ['Moxue_Test: 跟我來', 'moxue 跟我來', '!moxue 跟我來']) {
    const result = classifier.classify({
      type: 'player_chat', at: 1, player: 'Boss', message
    }, active)
    assert.equal(result.kind, 'explicit_instruction', message)
  }
})

test('empty addressed chat is not turned into an empty task', () => {
  for (const message of ['墨雪', '墨雪：', '!moxue   ']) {
    assert.deepEqual(classifier.classify({
      type: 'player_chat', at: 1, player: 'Boss', message
    }, active), { kind: 'state_only' })
  }
})

test('stuck and skill_failed attach bounded evidence to the active goal without dispatching yet', () => {
  assert.deepEqual(classifier.classify({
    type: 'stuck', at: 1, code: 'path_stuck'
  }, active), {
    kind: 'failure_evidence', causeKey: 'goal:goal-1', reason: 'stuck'
  })
  assert.deepEqual(classifier.classify({
    type: 'skill_failed', at: 2, skill: 'gather_resource', code: 'no_path'
  }, active), {
    kind: 'failure_evidence', causeKey: 'goal:goal-1', reason: 'skill_failed'
  })
})

test('goal_failed is the authoritative replan boundary and goal_cancelled never replans', () => {
  assert.deepEqual(classifier.classify({
    type: 'goal_failed', at: 3, goalId: 'goal-1', code: 'no_path'
  }, active), {
    kind: 'replan', causeKey: 'goal:goal-1', goalId: 'goal-1'
  })
  assert.deepEqual(classifier.classify({
    type: 'goal_cancelled', at: 4, goalId: 'goal-1', code: 'preempted_by_player'
  }, active), { kind: 'cancelled', goalId: 'goal-1' })
})

test('goal_completed continues only the active task goal', () => {
  assert.deepEqual(classifier.classify({
    type: 'goal_completed', at: 1, goalId: 'goal-1'
  }, active), { kind: 'goal_completed', goalId: 'goal-1' })
  assert.deepEqual(classifier.classify({
    type: 'goal_completed', at: 2, goalId: 'other-goal'
  }, active), { kind: 'state_only' })
})

test('same explicit text arriving as different ingress events stays as separate instructions', () => {
  const one = classifier.classify({ type: 'player_chat', at: 10, player: 'A', message: '墨雪 跟我來' }, active)
  const two = classifier.classify({ type: 'player_chat', at: 11, player: 'B', message: '墨雪 跟我來' }, active)
  assert.equal(one.kind, 'explicit_instruction')
  assert.equal(two.kind, 'explicit_instruction')
  if (one.kind === 'explicit_instruction' && two.kind === 'explicit_instruction') {
    assert.notEqual(one.ingressKey, two.ingressKey)
  }
})
