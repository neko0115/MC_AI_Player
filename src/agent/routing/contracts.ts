import type { DecisionContext } from '../context-builder.js'
import type { ProviderResult } from '../provider.js'

export type RouteClass = 'routine' | 'complex'
export type ThinkingLevel = 'low' | 'medium' | 'high'
export type BudgetClass = 'normal' | 'reserve'
export type HighReason =
  | 'manual_deep_think'
  | 'repeated_replanning'
  | 'critical_context'

export interface ComplexityEvidence {
  readonly multiStep?: boolean
  readonly multiSkill?: boolean
  readonly openEndedMethod?: boolean
  readonly crossContextReasoning?: boolean
  readonly goalFailed?: boolean
  readonly stuck?: boolean
  readonly manualComplexityHint?: boolean
  readonly riskContext?: boolean
  readonly replanCount?: number
  readonly criticalContext?: boolean
  readonly manualDeep?: boolean
}

export interface ComplexityAssessment {
  readonly policy: 'balanced-v1'
  readonly score: number
  readonly routeClass: RouteClass
  readonly thinking: ThinkingLevel
  readonly reasons: readonly string[]
  readonly highReason: HighReason | null
}

export interface RoutePlan {
  readonly decisionId: string
  readonly policy: 'balanced-v1'
  readonly routeClass: RouteClass
  readonly thinking: ThinkingLevel
  readonly reserveAuthorized: boolean
  readonly reasons: readonly string[]
  readonly highReason: HighReason | null
}

export interface AttemptLease {
  readonly attemptId: string
  readonly decisionId: string
  readonly configGeneration: number
  readonly projectKey: string
  readonly projectLabel: string
  readonly credentialHandle: string
  readonly model: string
  readonly thinking: ThinkingLevel
  readonly budgetClass: BudgetClass
  readonly reservationId: string
}

export interface LogicalDecisionRequest {
  readonly context: DecisionContext
  readonly routePlan: RoutePlan
}

export type LogicalDecisionResult =
  | { readonly kind: 'success'; readonly providerResult: ProviderResult }
  | { readonly kind: 'safety_blocked'; readonly code: 'content_blocked' }
  | { readonly kind: 'unavailable'; readonly retryAt: number | null }
  | { readonly kind: 'invalid_response'; readonly code: string }
  | { readonly kind: 'configuration_error'; readonly code: string }
  | { readonly kind: 'cancelled' }

export interface LogicalDecisionExecutor {
  execute(
    request: LogicalDecisionRequest,
    signal: AbortSignal
  ): Promise<LogicalDecisionResult>
}
