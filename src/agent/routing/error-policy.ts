import type { GeminiAttemptResult } from '../providers/gemini.js'
import { nextProviderDayStart } from './provider-day.js'

export type AttemptPolicy =
  | { readonly kind: 'success' }
  | { readonly kind: 'credential_fatal'; readonly safeCode: string }
  | {
      readonly kind: 'quota_unavailable'
      readonly safeCode: string
      readonly retryAt: number
    }
  | {
      readonly kind: 'transient'
      readonly safeCode: string
      readonly retryAfterMs?: number
    }
  | { readonly kind: 'safety_terminal'; readonly safeCode: 'content_blocked' }
  | { readonly kind: 'generation_retry'; readonly safeCode: string }
  | { readonly kind: 'configuration_error'; readonly safeCode: string }
  | { readonly kind: 'cancelled' }

export function classifyAttemptResult(
  result: GeminiAttemptResult,
  now: number
): AttemptPolicy {
  switch (result.kind) {
    case 'success':
      return { kind: 'success' }
    case 'content_blocked':
      return { kind: 'safety_terminal', safeCode: 'content_blocked' }
    case 'generation_error':
      return { kind: 'generation_retry', safeCode: result.code }
    case 'timeout':
      return { kind: 'transient', safeCode: 'timeout' }
    case 'network_error':
      return { kind: 'transient', safeCode: 'network_error' }
    case 'cancelled':
      return { kind: 'cancelled' }
    case 'api_error':
      return classifyApiError(result, now)
  }
}

function classifyApiError(
  result: Extract<GeminiAttemptResult, { kind: 'api_error' }>,
  now: number
): AttemptPolicy {
  const code = result.providerCode

  if (code === 'content_blocked') {
    return { kind: 'safety_terminal', safeCode: 'content_blocked' }
  }

  if (code === 'authentication' || result.httpStatus === 401) {
    return {
      kind: 'credential_fatal',
      safeCode: code ?? 'http_401'
    }
  }

  if (code === 'permission_denied' || result.httpStatus === 403) {
    return {
      kind: 'credential_fatal',
      safeCode: code ?? 'http_403'
    }
  }

  if (code === 'quota_exceeded') {
    const providerDayReset = nextProviderDayStart(now)
    const retryAfterReset = result.retryAfterMs === undefined
      ? providerDayReset
      : now + result.retryAfterMs
    return {
      kind: 'quota_unavailable',
      safeCode: 'quota_exceeded',
      retryAt: Math.max(providerDayReset, retryAfterReset)
    }
  }

  if (code === 'rate_limit_exceeded' || code === 'too_many_requests') {
    return {
      kind: 'transient',
      safeCode: code,
      ...(result.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: result.retryAfterMs })
    }
  }

  if (result.httpStatus === 429) {
    return {
      kind: 'transient',
      safeCode: 'rate_limit_unknown',
      ...(result.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: result.retryAfterMs })
    }
  }

  if (code === 'aborted') {
    return transient(code, result.retryAfterMs)
  }

  if (code === 'invalid_request' || code === 'parameter_unknown' || code === 'model_not_found') {
    return { kind: 'configuration_error', safeCode: code }
  }

  if (
    result.httpStatus === 408 ||
    result.httpStatus === 500 ||
    result.httpStatus === 502 ||
    result.httpStatus === 503 ||
    result.httpStatus === 504
  ) {
    return transient(`http_${result.httpStatus}`, result.retryAfterMs)
  }

  if (result.httpStatus >= 400 && result.httpStatus < 500) {
    return {
      kind: 'configuration_error',
      safeCode: code ?? `http_${result.httpStatus}`
    }
  }

  return transient(code ?? `http_${result.httpStatus}`, result.retryAfterMs)
}

function transient(safeCode: string, retryAfterMs?: number): AttemptPolicy {
  return {
    kind: 'transient',
    safeCode,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs })
  }
}
