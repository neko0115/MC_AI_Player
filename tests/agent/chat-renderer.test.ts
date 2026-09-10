import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatRenderer } from '../../src/agent/chat-renderer.js'

const renderer = new ChatRenderer({ maxLength: 180 })

test('chat renderer turns semantic gather outcomes into deterministic player chat', () => {
  assert.equal(renderer.render({
    kind: 'goal_started',
    intent: 'gather_resource',
    target: 'oak_log',
    quantity: 16
  }), '好，我去找 16 個 oak_log。')

  assert.equal(renderer.render({
    kind: 'goal_completed',
    intent: 'gather_resource'
  }), '完成了。')
})

test('chat renderer never renders provider free text or reasoning-shaped extra fields', () => {
  const outcome = {
    kind: 'goal_started',
    intent: 'stay',
    providerText: 'PRIVATE_REASONING_SENTINEL',
    reasoning: 'PRIVATE_REASONING_SENTINEL'
  } as never

  const message = renderer.render(outcome)

  assert.equal(message.includes('PRIVATE_REASONING_SENTINEL'), false)
  assert.equal(message, '好，我先待在這裡。')
})

test('chat renderer sanitizes player-visible target text and bounds final message length', () => {
  const message = renderer.render({
    kind: 'goal_started',
    intent: 'follow_player',
    target: 'Boss\nPRIVATE_REASONING_SENTINEL'.repeat(20)
  })

  assert.equal(message.includes('\n'), false)
  assert.equal(message.includes('PRIVATE_REASONING_SENTINEL'), false)
  assert.ok(message.length <= 180)
})

test('failure chat never echoes arbitrary failure detail', () => {
  const message = renderer.render({
    kind: 'goal_failed',
    intent: 'go_to',
    code: 'no_path\nSECRET_NETWORK_DETAIL'
  })

  assert.equal(message, '這次沒有完成。')
  assert.equal(message.includes('SECRET_NETWORK_DETAIL'), false)
})
