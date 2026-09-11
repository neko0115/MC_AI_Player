import assert from 'node:assert/strict'
import test from 'node:test'
import { loadAiConfig } from '../../src/config.js'

test('AI provider defaults to fake without requiring secrets', () => {
  assert.deepEqual(loadAiConfig({}), { provider: 'fake' })
  assert.deepEqual(loadAiConfig({ MC_AI_PROVIDER: 'fake' }), { provider: 'fake' })
})

test('Gemini provider requires explicit model and API key with no model fallback', () => {
  assert.throws(
    () => loadAiConfig({ MC_AI_PROVIDER: 'gemini', MC_AI_API_KEY: 'secret' }),
    /MC_AI_MODEL/
  )
  assert.throws(
    () => loadAiConfig({ MC_AI_PROVIDER: 'gemini', MC_AI_MODEL: 'gemini-3.8-flash' }),
    /MC_AI_API_KEY/
  )

  assert.deepEqual(loadAiConfig({
    MC_AI_PROVIDER: 'gemini',
    MC_AI_MODEL: 'gemini-3.8-flash',
    MC_AI_API_KEY: 'test-api-key'
  }), {
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    apiKey: 'test-api-key'
  })
})

test('unsupported AI provider fails closed', () => {
  assert.throws(() => loadAiConfig({ MC_AI_PROVIDER: 'text-parser' }), /MC_AI_PROVIDER/)
})
