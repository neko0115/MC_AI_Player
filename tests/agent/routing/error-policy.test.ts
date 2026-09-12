import assert from 'node:assert/strict'
import test from 'node:test'

test('error-policy module exports the deterministic attempt classifier', async () => {
  let module: Record<string, unknown> | null = null
  try {
    module = await import('../../../src/agent/routing/error-policy.js') as Record<string, unknown>
  } catch {
    // RED: module does not exist yet.
  }
  assert.equal(typeof module?.classifyAttemptResult, 'function')
})
