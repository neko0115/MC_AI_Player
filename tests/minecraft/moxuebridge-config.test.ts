import assert from 'node:assert/strict'
import test from 'node:test'
import { loadMoxueBridgeConfig } from '../../src/config.js'

test('MoxueBridge discovery is disabled when no base URL is configured', () => {
  assert.deepEqual(loadMoxueBridgeConfig({}), { enabled: false })
})

test('loads explicit MoxueBridge discovery settings', () => {
  assert.deepEqual(loadMoxueBridgeConfig({
    MC_MOXUEBRIDGE_BASE_URL: 'http://192.168.50.159:8766/',
    MC_MOXUEBRIDGE_TOKEN: 'secret',
    MC_MOXUEBRIDGE_TIMEOUT_MS: '900',
    MC_MOXUEBRIDGE_REFRESH_INTERVAL_MS: '45000'
  }), {
    enabled: true,
    baseUrl: 'http://192.168.50.159:8766',
    bearerToken: 'secret',
    timeoutMs: 900,
    refreshIntervalMs: 45000
  })
})

test('requires a token whenever MoxueBridge discovery is enabled', () => {
  assert.throws(
    () => loadMoxueBridgeConfig({
      MC_MOXUEBRIDGE_BASE_URL: 'http://127.0.0.1:8766'
    }),
    /MC_MOXUEBRIDGE_TOKEN/
  )
})

test('rejects credential-bearing or non-http MoxueBridge URLs', () => {
  assert.throws(
    () => loadMoxueBridgeConfig({
      MC_MOXUEBRIDGE_BASE_URL: 'ftp://127.0.0.1:8766',
      MC_MOXUEBRIDGE_TOKEN: 'secret'
    }),
    /http or https/
  )
  assert.throws(
    () => loadMoxueBridgeConfig({
      MC_MOXUEBRIDGE_BASE_URL: 'http://user:pass@127.0.0.1:8766',
      MC_MOXUEBRIDGE_TOKEN: 'secret'
    }),
    /must not contain credentials/
  )
})
