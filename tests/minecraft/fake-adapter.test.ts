import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { FakeMinecraftAdapter } from '../../src/minecraft/fake-adapter.js'

const fixturePath = fileURLToPath(new URL('../../fixtures/observations/basic-session.json', import.meta.url))

test('fake adapter replays validated fixture events in order', async () => {
  const adapter = await FakeMinecraftAdapter.fromFile(fixturePath)
  const seen: string[] = []

  adapter.onEvent(event => {
    seen.push(event.type)
  })

  await adapter.connect()

  assert.deepEqual(seen, [
    'connected',
    'spawned',
    'player_seen',
    'player_chat',
    'inventory_changed'
  ])
})

test('fake adapter does not expose an underlying mineflayer bot', async () => {
  const adapter = await FakeMinecraftAdapter.fromFile(fixturePath)

  assert.equal('bot' in adapter, false)
})

test('fake adapter stopMotion is observable without low-level controls', async () => {
  const adapter = await FakeMinecraftAdapter.fromFile(fixturePath)

  await adapter.stopMotion()

  assert.equal(adapter.stopMotionCount, 1)
})
