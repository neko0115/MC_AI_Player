import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MinecraftIdentityRegistry,
  normalizeMinecraftUuid
} from '../../src/minecraft/identity-registry.js'

const policy = {
  ownerUuid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  operatorAllowlistUuids: ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']
}

test('UUID normalization accepts canonical/hyphenless forms and rejects malformed values', () => {
  assert.equal(
    normalizeMinecraftUuid('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'),
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  )
  assert.equal(
    normalizeMinecraftUuid('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  )
  assert.equal(normalizeMinecraftUuid('Boss'), null)
  assert.equal(normalizeMinecraftUuid(undefined), null)
})

test('offline server identity always resolves Minecraft chat as untrusted', () => {
  const registry = new MinecraftIdentityRegistry()
  registry.beginSession()
  registry.observePlayer('Boss', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')

  assert.deepEqual(registry.resolveChat({
    mode: 'offline',
    player: 'Boss',
    playerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    policy
  }), {
    kind: 'minecraft_untrusted',
    capabilities: []
  })
})

test('stable workspace identity requires online current-session UUID evidence', () => {
  const registry =
    new MinecraftIdentityRegistry()
  registry.beginSession()
  registry.observePlayer(
    'Boss',
    'cccccccc-cccc-cccc-cccc-cccccccccccc'
  )

  assert.equal(
    registry.resolveObservedPlayerId({
      mode: 'online',
      player: 'Boss',
      playerId:
        'CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC'
    }),
    'cccccccccccccccccccccccccccccccc'
  )
  assert.equal(
    registry.resolveObservedPlayerId({
      mode: 'offline',
      player: 'Boss',
      playerId:
        'cccccccc-cccc-cccc-cccc-cccccccccccc'
    }),
    null
  )
  assert.equal(
    registry.resolveObservedPlayerId({
      mode: 'online',
      player: 'Boss',
      playerId:
        'dddddddd-dddd-dddd-dddd-dddddddddddd'
    }),
    null
  )
})

test('online current-session owner and operator UUIDs gain only Minecraft deep/reserve capabilities', () => {
  const registry = new MinecraftIdentityRegistry()
  registry.beginSession()
  registry.observePlayer('Boss', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  registry.observePlayer('Op', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')

  assert.deepEqual(registry.resolveChat({
    mode: 'online',
    player: 'Boss',
    playerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    policy
  }), {
    kind: 'minecraft_owner',
    capabilities: ['manual_deep_think', 'flash_reserve_access']
  })
  assert.deepEqual(registry.resolveChat({
    mode: 'online',
    player: 'Op',
    playerId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    policy
  }), {
    kind: 'minecraft_operator',
    capabilities: ['manual_deep_think', 'flash_reserve_access']
  })
})

test('missing or mismatched current chat UUID evidence fails closed', () => {
  const registry = new MinecraftIdentityRegistry()
  registry.beginSession()
  registry.observePlayer('Boss', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')

  assert.equal(registry.resolveChat({ mode: 'online', player: 'Boss', policy }).kind, 'minecraft_untrusted')
  assert.equal(registry.resolveChat({
    mode: 'online',
    player: 'Boss',
    playerId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    policy
  }).kind, 'minecraft_untrusted')
})

test('player leave and reconnect invalidate prior session trust', () => {
  const registry = new MinecraftIdentityRegistry()
  const first = registry.beginSession()
  registry.observePlayer('Boss', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  registry.removePlayer('Boss', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  assert.equal(registry.resolveChat({
    mode: 'online', player: 'Boss', playerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', policy
  }).kind, 'minecraft_untrusted')

  registry.observePlayer('Boss', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  registry.endSession()
  const second = registry.beginSession()
  assert.notEqual(second, first)
  assert.equal(registry.resolveChat({
    mode: 'online', player: 'Boss', playerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', policy
  }).kind, 'minecraft_untrusted')
})
