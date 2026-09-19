import assert from 'node:assert/strict'
import test from 'node:test'
import {
  loadAdminApiConfig,
  loadAiConfig,
  loadMinecraftServerIdentityMode
} from '../../src/config.js'

test('AI provider defaults to fake without requiring secrets', () => {
  assert.deepEqual(loadAiConfig({}), { provider: 'fake' })
  assert.deepEqual(loadAiConfig({ MC_AI_PROVIDER: 'fake' }), { provider: 'fake' })
})

test('Gemini provider uses routing-file authority and ignores legacy single-model values', () => {
  assert.deepEqual(loadAiConfig({
    MC_AI_PROVIDER: 'gemini',
    MC_AI_MODEL: 'legacy-model-must-not-win',
    MC_AI_API_KEY: 'legacy-key-must-not-win'
  }), {
    provider: 'gemini',
    routingConfigPath: 'data/ai-routing.json'
  })

  assert.deepEqual(loadAiConfig({
    MC_AI_PROVIDER: 'gemini',
    MC_AI_ROUTING_CONFIG: 'D:/private/router.json'
  }), {
    provider: 'gemini',
    routingConfigPath: 'D:/private/router.json'
  })
})

test('server identity mode fails closed to offline', () => {
  assert.equal(loadMinecraftServerIdentityMode({}), 'offline')
  assert.equal(
    loadMinecraftServerIdentityMode({ MC_SERVER_IDENTITY_MODE: 'online' }),
    'online'
  )
  assert.equal(
    loadMinecraftServerIdentityMode({ MC_SERVER_IDENTITY_MODE: 'typo' }),
    'offline'
  )
})

test('Admin API is disabled without its dedicated token and fixed to loopback when enabled', () => {
  assert.deepEqual(loadAdminApiConfig({}), { enabled: false })
  assert.deepEqual(loadAdminApiConfig({
    MC_ADMIN_TOKEN: 'admin-secret',
    MC_ADMIN_PORT: '8767'
  }), {
    enabled: true,
    host: '127.0.0.1',
    port: 8767,
    bearerToken: 'admin-secret'
  })
})

test('unsupported AI provider fails closed', () => {
  assert.throws(() => loadAiConfig({ MC_AI_PROVIDER: 'text-parser' }), /MC_AI_PROVIDER/)
})
