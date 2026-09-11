import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertGameplayProviderCapabilities,
  type DecisionProvider,
  type ProviderCapabilities
} from '../../src/agent/provider.js'
import { FakeDecisionProvider } from '../../src/agent/fake-provider.js'
import { GeminiDecisionProvider } from '../../src/agent/providers/gemini.js'

function providerWith(capabilities: ProviderCapabilities): DecisionProvider {
  return {
    capabilities,
    async decide() {
      return { kind: 'timeout', provider: 'test' }
    }
  }
}

test('fake and Gemini decision providers explicitly declare a safe structured reasoning boundary', () => {
  const fake = new FakeDecisionProvider([])
  const gemini = new GeminiDecisionProvider({
    interactions: {
      async create() {
        return { status: 'requires_action', steps: [] }
      }
    },
    model: 'gemini-3.8-flash'
  })

  assert.deepEqual(fake.capabilities, {
    structuredFinal: true,
    reasoningSeparated: true
  })
  assert.deepEqual(gemini.capabilities, {
    structuredFinal: true,
    reasoningSeparated: true
  })
  assert.doesNotThrow(() => assertGameplayProviderCapabilities(fake))
  assert.doesNotThrow(() => assertGameplayProviderCapabilities(gemini))
})

test('gameplay capability gate rejects providers without structured final output or separated reasoning', () => {
  assert.throws(
    () => assertGameplayProviderCapabilities(providerWith({
      structuredFinal: false,
      reasoningSeparated: true
    })),
    /structured final/i
  )
  assert.throws(
    () => assertGameplayProviderCapabilities(providerWith({
      structuredFinal: true,
      reasoningSeparated: false
    })),
    /reasoning separation/i
  )
})
