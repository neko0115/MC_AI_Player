import assert from 'node:assert/strict'
import test from 'node:test'
import { loadControlApiConfig } from '../../src/config.js'

test('control API defaults to loopback with bounded body size', () => {
  assert.deepEqual(loadControlApiConfig({}), {
    host: '127.0.0.1',
    port: 8766,
    maxBodyBytes: 16 * 1024
  })
})

test('non-loopback control bind requires an explicit bearer token', () => {
  assert.throws(
    () => loadControlApiConfig({ MC_CONTROL_HOST: '0.0.0.0' }),
    /MC_CONTROL_TOKEN/
  )

  assert.deepEqual(loadControlApiConfig({
    MC_CONTROL_HOST: '0.0.0.0',
    MC_CONTROL_PORT: '9000',
    MC_CONTROL_TOKEN: 'secret-token',
    MC_CONTROL_MAX_BODY_BYTES: '32768'
  }), {
    host: '0.0.0.0',
    port: 9000,
    bearerToken: 'secret-token',
    maxBodyBytes: 32768
  })
})

test('control API config rejects unsafe or malformed values', () => {
  assert.throws(() => loadControlApiConfig({ MC_CONTROL_PORT: '0' }), /MC_CONTROL_PORT/)
  assert.throws(() => loadControlApiConfig({ MC_CONTROL_PORT: '65536' }), /MC_CONTROL_PORT/)
  assert.throws(() => loadControlApiConfig({ MC_CONTROL_MAX_BODY_BYTES: '0' }), /MC_CONTROL_MAX_BODY_BYTES/)
  assert.throws(() => loadControlApiConfig({ MC_CONTROL_MAX_BODY_BYTES: '1048577' }), /MC_CONTROL_MAX_BODY_BYTES/)
  assert.throws(() => loadControlApiConfig({ MC_CONTROL_HOST: ' ' }), /MC_CONTROL_HOST/)
})
