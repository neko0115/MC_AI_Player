import type { DecisionContext } from '../context-builder.js'
import type {
  GeminiAttemptResult,
  GeminiTransport,
  PreparedGeminiPayload
} from '../providers/gemini.js'
import type {
  LogicalDecisionExecutor,
  LogicalDecisionRequest,
  LogicalDecisionResult,
  RoutePlan
} from './contracts.js'
import { classifyAttemptResult, type AttemptPolicy } from './error-policy.js'
import type { ProjectPoolLeaseResult } from './project-pool.js'
import type { AttemptSettlement } from './quota-ledger.js'

export interface RoutedExecutorPoolPort {
  configuredProjectCount(): number
  nextLease(plan: RoutePlan, prepared: { readonly utf8Bytes: number }): ProjectPoolLeaseResult
}

export interface RoutedExecutorLedgerPort {
  markDispatched(reservationId: string, dispatchedAt: number): void
  settleAttempt(reservationId: string, settlement: AttemptSettlement): void
  recordTransientFailure(
    projectKey: string,
    model: string,
    now: number,
    retryAfterMs?: number
  ): number
  recordDomainSuccess(projectKey: string, model: string): void
  markQuotaUnavailable(
    projectKey: string,
    model: string,
    until: number,
    safeCode: string
  ): void
  disableCredentialForProcess(
    projectKey: string,
    processInstanceId: string,
    safeCode: string,
    now: number
  ): void
}

export interface RoutedExecutorTransportPort {
  prepare(context: DecisionContext): PreparedGeminiPayload
  execute(
    prepared: PreparedGeminiPayload,
    lease: Parameters<GeminiTransport['execute']>[1],
    signal: AbortSignal
  ): Promise<GeminiAttemptResult>
}

export interface RoutedDecisionExecutorOptions {
  readonly pool: RoutedExecutorPoolPort
  readonly ledger: RoutedExecutorLedgerPort
  readonly transport: RoutedExecutorTransportPort
  readonly processInstanceId: string
  readonly now?: () => number
}

export class RoutedDecisionExecutor implements LogicalDecisionExecutor {
  private readonly now: () => number

  constructor(private readonly options: RoutedDecisionExecutorOptions) {
    if (!options.processInstanceId.trim()) {
      throw new TypeError('processInstanceId must be non-empty')
    }
    this.now = options.now ?? Date.now
  }

  async execute(
    request: LogicalDecisionRequest,
    signal: AbortSignal
  ): Promise<LogicalDecisionResult> {
    const prepared = this.options.transport.prepare(request.context)
    const maxAttempts = this.options.pool.configuredProjectCount() + 4
    let generationRepairUsed = false

    for (let attempts = 0; attempts < maxAttempts; attempts += 1) {
      if (signal.aborted) return { kind: 'cancelled' }

      const leaseResult = this.options.pool.nextLease(request.routePlan, prepared)
      if (leaseResult.kind === 'unavailable') {
        return { kind: 'unavailable', retryAt: leaseResult.retryAt }
      }

      const lease = leaseResult.lease
      const dispatchedAt = this.now()
      this.options.ledger.markDispatched(lease.reservationId, dispatchedAt)

      const attempt = await this.options.transport.execute(prepared, lease, signal)
      const policy = classifyAttemptResult(attempt, this.now())
      this.options.ledger.settleAttempt(
        lease.reservationId,
        settlementFor(attempt, policy, this.now())
      )

      switch (policy.kind) {
        case 'success':
          this.options.ledger.recordDomainSuccess(lease.projectKey, lease.model)
          if (attempt.kind !== 'success') {
            throw new Error('success policy requires successful attempt')
          }
          return { kind: 'success', providerResult: attempt.providerResult }

        case 'credential_fatal':
          this.options.ledger.disableCredentialForProcess(
            lease.projectKey,
            this.options.processInstanceId,
            policy.safeCode,
            this.now()
          )
          break

        case 'quota_unavailable':
          this.options.ledger.markQuotaUnavailable(
            lease.projectKey,
            lease.model,
            policy.retryAt,
            policy.safeCode
          )
          break

        case 'transient':
          this.options.ledger.recordTransientFailure(
            lease.projectKey,
            lease.model,
            this.now(),
            policy.retryAfterMs
          )
          break

        case 'safety_terminal':
          return { kind: 'safety_blocked', code: 'content_blocked' }

        case 'generation_retry':
          if (generationRepairUsed) {
            return { kind: 'invalid_response', code: policy.safeCode }
          }
          generationRepairUsed = true
          break

        case 'configuration_error':
          return { kind: 'configuration_error', code: policy.safeCode }

        case 'cancelled':
          return { kind: 'cancelled' }
      }
    }

    return { kind: 'unavailable', retryAt: null }
  }
}

function settlementFor(
  attempt: GeminiAttemptResult,
  policy: AttemptPolicy,
  now: number
): AttemptSettlement {
  const usage = 'usage' in attempt ? attempt.usage : undefined
  const safeErrorCode = 'safeCode' in policy ? policy.safeCode : undefined

  return {
    now,
    resultClass: policy.kind,
    ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
    ...(usage === undefined
      ? { missingUsagePolicy: missingUsagePolicy(attempt) }
      : { usage })
  }
}

function missingUsagePolicy(
  attempt: GeminiAttemptResult
): 'rejected' | 'unknown' {
  if (
    attempt.kind === 'api_error' &&
    attempt.httpStatus >= 400 &&
    attempt.httpStatus < 500 &&
    attempt.httpStatus !== 408 &&
    !(attempt.httpStatus === 409 && attempt.providerCode === 'aborted')
  ) {
    return 'rejected'
  }
  return 'unknown'
}
