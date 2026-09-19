import { randomUUID } from 'node:crypto'
import type { AttemptLease, RoutePlan } from './contracts.js'
import type { RoutingConfigSnapshot } from './config-manager.js'
import type {
  QuotaAdmissionRequest,
  QuotaAdmissionResult
} from './quota-ledger.js'

export interface ProjectPoolConfigSource {
  snapshot(): RoutingConfigSnapshot
}

export interface ProjectPoolLedgerPort {
  credentialDisabled(projectKey: string, processInstanceId: string): boolean
  admitAttempt(request: QuotaAdmissionRequest): QuotaAdmissionResult
}

export interface PreparedPayloadMetrics {
  readonly utf8Bytes: number
}

export type ProjectPoolLeaseResult =
  | { readonly kind: 'leased'; readonly lease: AttemptLease }
  | { readonly kind: 'unavailable'; readonly retryAt: number | null }

interface ProjectPoolOptions {
  readonly config: ProjectPoolConfigSource
  readonly ledger: ProjectPoolLedgerPort
  readonly processInstanceId: string
  readonly now?: () => number
  readonly nextAttemptId?: () => string
}

export class ProjectPool {
  private readonly now: () => number
  private readonly nextAttemptId: () => string

  constructor(private readonly options: ProjectPoolOptions) {
    this.now = options.now ?? Date.now
    this.nextAttemptId = options.nextAttemptId ?? randomUUID
  }

  configuredProjectCount(): number {
    return this.options.config.snapshot().projects.length
  }

  nextLease(
    plan: RoutePlan,
    prepared: PreparedPayloadMetrics
  ): ProjectPoolLeaseResult {
    if (!Number.isInteger(prepared.utf8Bytes) || prepared.utf8Bytes < 0) {
      throw new RangeError('utf8Bytes must be a non-negative integer')
    }

    const snapshot = this.options.config.snapshot()
    const modelConfig = plan.routeClass === 'routine'
      ? snapshot.models.routine
      : snapshot.models.complex
    const generationAllowance = plan.routeClass === 'routine'
      ? snapshot.models.routine.reservation.generationTokenAllowance.low
      : plan.thinking === 'high'
        ? snapshot.models.complex.reservation.generationTokenAllowance.high
        : snapshot.models.complex.reservation.generationTokenAllowance.medium
    const reservation = estimateReservation(
      prepared.utf8Bytes,
      modelConfig.reservation.inputTokenOverhead,
      generationAllowance
    )
    const now = this.now()
    const retryTimes: number[] = []

    const normal = this.scan(
      snapshot,
      plan,
      modelConfig.name,
      reservation,
      now,
      'normal',
      retryTimes
    )
    if (normal) return normal

    if (plan.routeClass === 'complex' && plan.reserveAuthorized) {
      const reserve = this.scan(
        snapshot,
        plan,
        modelConfig.name,
        reservation,
        now,
        'reserve',
        retryTimes
      )
      if (reserve) return reserve
    }

    return {
      kind: 'unavailable',
      retryAt: retryTimes.length > 0 ? Math.min(...retryTimes) : null
    }
  }

  private scan(
    snapshot: RoutingConfigSnapshot,
    plan: RoutePlan,
    model: string,
    reservation: { inputTokens: number; totalTokens: number },
    now: number,
    budgetClass: 'normal' | 'reserve',
    retryTimes: number[]
  ): ProjectPoolLeaseResult | null {
    for (let index = 0; index < snapshot.projects.length; index += 1) {
      const project = snapshot.projects[index]
      if (!project) continue
      if (this.options.ledger.credentialDisabled(
        project.projectKey,
        this.options.processInstanceId
      )) {
        continue
      }

      const attemptId = this.nextAttemptId()
      const providerLimits = plan.routeClass === 'routine'
        ? project.providerLimits.routine
        : project.providerLimits.complex
      const admission = this.options.ledger.admitAttempt({
        attemptId,
        decisionId: plan.decisionId,
        configGeneration: snapshot.generation,
        projectKey: project.projectKey,
        model,
        thinking: plan.thinking,
        budgetClass,
        now,
        reservedInputTokens: reservation.inputTokens,
        reservedTotalTokens: reservation.totalTokens,
        providerLimits,
        ...(plan.routeClass === 'complex'
          ? { flashBudget: project.flashBudget }
          : {})
      })

      if (admission.kind === 'admitted') {
        return {
          kind: 'leased',
          lease: Object.freeze({
            attemptId,
            decisionId: plan.decisionId,
            configGeneration: snapshot.generation,
            projectKey: project.projectKey,
            projectLabel: index === 0 ? 'primary' : `backup-${index}`,
            credentialHandle: project.credentialHandle,
            model,
            thinking: plan.thinking,
            budgetClass,
            reservationId: admission.reservationId
          })
        }
      }

      if (admission.retryAt !== null) retryTimes.push(admission.retryAt)
    }
    return null
  }
}

export function estimateReservation(
  utf8PayloadBytes: number,
  inputTokenOverhead: number,
  generationAllowance: number
): { inputTokens: number; totalTokens: number } {
  for (const [name, value] of Object.entries({
    utf8PayloadBytes,
    inputTokenOverhead,
    generationAllowance
  })) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative integer`)
    }
  }
  const inputTokens = utf8PayloadBytes + inputTokenOverhead
  return {
    inputTokens,
    totalTokens: inputTokens + generationAllowance
  }
}
