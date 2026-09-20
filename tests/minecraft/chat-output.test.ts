import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bot } from 'mineflayer'
import {
  MineflayerChatOutput
} from '../../src/minecraft/chat-output.js'

class FakeBot {
  readonly sent: string[] = []
  chat(message: string): void {
    this.sent.push(message)
  }
}

test('bounded chat output sends ordinary text only when bot is ready', () => {
  const bot = new FakeBot()
  const output =
    new MineflayerChatOutput(
      () =>
        bot as unknown as Bot
    )

  assert.deepEqual(
    output.sendMessage(
      '好，我記住這個農田了。'
    ),
    { status: 'sent' }
  )
  assert.deepEqual(
    bot.sent,
    ['好，我記住這個農田了。']
  )
})

test('chat output fails closed for slash-prefixed multiline control or oversized messages', () => {
  const bot = new FakeBot()
  const output =
    new MineflayerChatOutput(
      () =>
        bot as unknown as Bot
    )

  for (const message of [
    '/workspace-test',
    'hello\n/workspace-test',
    'hello\u0000world',
    'x'.repeat(257),
    '   '
  ]) {
    assert.deepEqual(
      output.sendMessage(message),
      {
        status: 'failed',
        code: 'invalid_chat_message'
      }
    )
  }

  assert.deepEqual(bot.sent, [])
})

test('chat output fails closed while Mineflayer bot is unavailable', () => {
  const output =
    new MineflayerChatOutput(
      () => null
    )

  assert.deepEqual(
    output.sendMessage('hello'),
    {
      status: 'failed',
      code: 'minecraft_not_ready'
    }
  )
})
