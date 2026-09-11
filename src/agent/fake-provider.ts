import {
  SAFE_GAMEPLAY_PROVIDER_CAPABILITIES,
  type DecisionProvider,
  type DecisionRequest,
  type ProviderResult,
  type StructuredProviderMode
} from './provider.js'

export type FakeSdkResponse =
  | {
      readonly kind: 'structured'
      readonly value: unknown
      readonly mode: StructuredProviderMode
      readonly reasoning?: string
    }
  | {
      readonly kind: 'raw_text'
      readonly text: string
    }
  | {
      readonly kind: 'invalid'
      readonly code: string
    }
  | {
      readonly kind: 'timeout'
    }

export function adaptFakeSdkResponse(
  response: FakeSdkResponse,
  provider = 'fake'
): ProviderResult {
  const providerName = normalizeProvider(provider)

  switch (response.kind) {
    case 'structured':
      return {
        kind: 'structured',
        provider: providerName,
        mode: response.mode,
        value: cloneValue(response.value)
      }
    case 'raw_text':
      return {
        kind: 'invalid',
        provider: providerName,
        code: 'unstructured_response'
      }
    case 'invalid':
      return {
        kind: 'invalid',
        provider: providerName,
        code: normalizeCode(response.code, 'provider_invalid')
      }
    case 'timeout':
      return { kind: 'timeout', provider: providerName }
  }
}

export class FakeDecisionProvider<TContext = unknown> implements DecisionProvider<TContext> {
  readonly capabilities = SAFE_GAMEPLAY_PROVIDER_CAPABILITIES
  private index = 0

  constructor(
    private readonly responses: readonly FakeSdkResponse[],
    private readonly provider = 'fake'
  ) {}

  async decide(_request: DecisionRequest<TContext>): Promise<ProviderResult> {
    const response = this.responses[this.index]
    this.index += 1
    if (!response) {
      return {
        kind: 'invalid',
        provider: normalizeProvider(this.provider),
        code: 'fake_response_exhausted'
      }
    }
    return adaptFakeSdkResponse(response, this.provider)
  }
}

function cloneValue(value: unknown): unknown {
  try {
    return structuredClone(value)
  } catch {
    return value
  }
}

function normalizeProvider(value: string): string {
  const normalized = value.trim().slice(0, 128)
  return normalized || 'unknown_provider'
}

function normalizeCode(value: string, fallback: string): string {
  const normalized = value.trim().replace(/\s+/g, '_').slice(0, 128)
  return normalized || fallback
}
