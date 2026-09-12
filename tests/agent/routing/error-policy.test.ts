import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyAttemptResult } from '../../../src/agent/routing/error-policy.js'
import { nextProviderDayStart } from '../../../src/agent/routing/provider-day.js'

const NOW = Date.parse('2026-09-12T12:00:00Z')

test('successful attempt is terminal success', () => {
  assert.deepEqual(classifyAttemptResult({
    kind: 'success',
    providerResult: { kind: 'structured', provider: 'gemini', mode: 'function_call', value: {} }
  }, NOW), { kind: 'success' })
})

test('401 and 403 disable the credential instead of transiently retrying it', () => {
  assert.deepEqual(classifyAttemptResult({
    kind: 'api_error', httpStatus: 401, providerCode: 'authentication'
  }, NOW), { kind: 'credential_fatal', safeCode: 'authentication' })
  assert.deepEqual(classifyAttemptResult({
    kind: 'api_error', httpStatus: 403, providerCode: 'permission_denied'
  }, NOW), { kind: 'credential_fatal', safeCode: 'permission_denied' })
})

test('quota_exceeded blocks the model domain until the provider day resets', () => {
  assert.deepEqual(classifyAttemptResult({
    kind: 'api_error', httpStatus: 429, providerCode: 'quota_exceeded'
  }, NOW), {
    kind: 'quota_unavailable', safeCode: 'quota_exceeded', retryAt: nextProviderDayStart(NOW)
  })
})

test('rate-limit 429 variants are transient and preserve Retry-After', () => {
  assert.deepEqual(classifyAttemptResult({
    kind: 'api_error', httpStatus: 429, providerCode: 'rate_limit_exceeded', retryAfterMs: 12_000
  }, NOW), { kind: 'transient', safeCode: 'rate_limit_exceeded', retryAfterMs: 12_000 })
  assert.deepEqual(classifyAttemptResult({
    kind: 'api_error', httpStatus: 429, providerCode: 'too_many_requests'
  }, NOW), { kind: 'transient', safeCode: 'too_many_requests' })
  assert.deepEqual(classifyAttemptResult({
    kind: 'api_error', httpStatus: 429, providerCode: null
  }, NOW), { kind: 'transient', safeCode: 'rate_limit_unknown' })
})

test('timeouts network failures retryable server failures and aborted conflicts are transient', () => {
  assert.deepEqual(classifyAttemptResult({ kind: 'timeout' }, NOW), {
    kind: 'transient', safeCode: 'timeout'
  })
  assert.deepEqual(classifyAttemptResult({ kind: 'network_error' }, NOW), {
    kind: 'transient', safeCode: 'network_error'
  })
  for (const httpStatus of [408, 500, 502, 503, 504]) {
    assert.deepEqual(classifyAttemptResult({
      kind: 'api_error', httpStatus, providerCode: null
    }, NOW), { kind: 'transient', safeCode: `http_${httpStatus}` })
  }
  assert.deepEqual(classifyAttemptResult({
    kind: 'api_error', httpStatus: 409, providerCode: 'aborted'
  }, NOW), { kind: 'transient', safeCode: 'aborted' })
})

test('provider content blocking is terminal safety and never a failover signal', () => {
  assert.deepEqual(classifyAttemptResult({
    kind: 'content_blocked', code: 'content_blocked'
  }, NOW), { kind: 'safety_terminal', safeCode: 'content_blocked' })
})

test('invalid generation gets the bounded generation-retry policy class', () => {
  assert.deepEqual(classifyAttemptResult({
    kind: 'generation_error', code: 'malformed_tool_call'
  }, NOW), { kind: 'generation_retry', safeCode: 'malformed_tool_call' })
})

test('local cancellation is terminal cancellation with no provider penalty', () => {
  assert.deepEqual(classifyAttemptResult({ kind: 'cancelled' }, NOW), { kind: 'cancelled' })
})

test('invalid request and model configuration errors stop without cross-project retry', () => {
  for (const [httpStatus, providerCode] of [
    [400, 'invalid_request'],
    [400, 'parameter_unknown'],
    [404, 'model_not_found'],
    [422, null]
  ] as const) {
    assert.deepEqual(classifyAttemptResult({
      kind: 'api_error', httpStatus, providerCode
    }, NOW), {
      kind: 'configuration_error', safeCode: providerCode ?? `http_${httpStatus}`
    })
  }
})

test('non-aborted 409 is a configuration/protocol failure rather than transient retry', () => {
  assert.deepEqual(classifyAttemptResult({
    kind: 'api_error', httpStatus: 409, providerCode: null
  }, NOW), { kind: 'configuration_error', safeCode: 'http_409' })
})
