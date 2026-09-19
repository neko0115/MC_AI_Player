import assert from 'node:assert/strict'
import test from 'node:test'
import { providerDayKey } from '../../../src/agent/routing/provider-day.js'

test('provider day follows America/Los_Angeles instead of a fixed UTC day', () => {
  assert.equal(providerDayKey(Date.parse('2026-09-12T06:59:59Z')), '2026-09-11')
  assert.equal(providerDayKey(Date.parse('2026-09-12T07:00:00Z')), '2026-09-12')
})

test('provider day also follows the winter PST offset', () => {
  assert.equal(providerDayKey(Date.parse('2026-12-01T07:59:59Z')), '2026-11-30')
  assert.equal(providerDayKey(Date.parse('2026-12-01T08:00:00Z')), '2026-12-01')
})
