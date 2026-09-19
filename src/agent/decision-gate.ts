import {
  DecisionOutcomeV2Schema,
  type DecisionAction,
  type DecisionBlockedReason
} from '../contracts/decision.js'
import type { GoalRequest } from '../contracts/goals.js'
import type { SkillName } from '../contracts/skills.js'
import type { SafetyPolicy } from '../safety/policy.js'
import type { WorldStateSnapshot } from '../state/world-state.js'
import type { RuntimeEventBus } from '../telemetry/event-bus.js'
import {
  ProviderResultSchema,
  type StructuredProviderMode
} from './provider.js'

export interface GatedAction {
  readonly kind: 'action'
  readonly provider: string
  readonly mode: StructuredProviderMode
  readonly intent: DecisionAction['intent']
  readonly goal: GoalRequest
}

export interface GatedComplete {
  readonly kind: 'complete'
  readonly provider: string
  readonly mode: StructuredProviderMode
}

export interface GatedBlocked {
  readonly kind: 'blocked'
  readonly provider: string
  readonly mode: StructuredProviderMode
  readonly reason: DecisionBlockedReason
}

export interface RejectedDecision {
  readonly kind: 'rejected'
  readonly provider: string
  readonly code: string
}

export type GatedOutcome = GatedAction | GatedComplete | GatedBlocked | RejectedDecision

interface DecisionGateDependencies {
  readonly safety: SafetyPolicy
  readonly events?: RuntimeEventBus
  readonly now?: () => number
}

export class DecisionGate {
  private readonly events: RuntimeEventBus | undefined
  private readonly now: () => number

  constructor(private readonly dependencies: DecisionGateDependencies) {
    this.events = dependencies.events
    this.now = dependencies.now ?? Date.now
  }

  async accept(
    input: unknown,
    state: WorldStateSnapshot,
    isSkillRegistered: (name: SkillName) => boolean
  ): Promise<GatedOutcome> {
    const envelope = ProviderResultSchema.safeParse(input)
    if (!envelope.success) {
      return this.reject(providerFromUnknown(input), 'provider_result_invalid')
    }

    const result = envelope.data
    const provider = result.provider

    if (result.kind === 'timeout') {
      return this.reject(provider, 'provider_timeout')
    }

    if (result.kind === 'invalid') {
      return this.reject(provider, normalizeCode(result.code, 'provider_invalid'))
    }

    const parsed = DecisionOutcomeV2Schema.safeParse(result.value)
    if (!parsed.success) {
      return this.reject(provider, 'decision_schema_invalid')
    }

    const outcome = parsed.data
    if (outcome.outcome === 'complete') {
      return {
        kind: 'complete',
        provider,
        mode: result.mode
      }
    }

    if (outcome.outcome === 'blocked') {
      return {
        kind: 'blocked',
        provider,
        mode: result.mode,
        reason: outcome.reason
      }
    }

    const action = outcome.action
    if (!isSkillRegistered(action.intent)) {
      return this.reject(provider, 'skill_not_registered')
    }

    const goal = actionToGoal(action)
    const skillAuthorization = this.dependencies.safety.authorizeSkill(
      action.intent,
      state
    )
    if (skillAuthorization.kind !== 'allow') {
      return this.reject(provider, skillAuthorization.code)
    }

    const runtimeAuthorization = this.dependencies.safety.runtimeAction(state, goal)
    if (runtimeAuthorization.kind !== 'allow') {
      return this.reject(provider, runtimeAuthorization.code)
    }

    await this.events?.publish({
      type: 'decision_accepted',
      at: this.now(),
      intent: action.intent
    })

    return {
      kind: 'action',
      provider,
      mode: result.mode,
      intent: action.intent,
      goal
    }
  }

  private async reject(provider: string, code: string): Promise<RejectedDecision> {
    const safeCode = normalizeCode(code, 'decision_rejected')
    await this.events?.publish({
      type: 'decision_rejected',
      at: this.now(),
      code: safeCode
    })
    return {
      kind: 'rejected',
      provider,
      code: safeCode
    }
  }
}

function actionToGoal(action: DecisionAction): GoalRequest {
  return {
    kind: action.intent,
    args: structuredClone(action.args)
  } as GoalRequest
}

function providerFromUnknown(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return 'unknown_provider'
  }
  const provider = (value as { provider?: unknown }).provider
  return typeof provider === 'string'
    ? normalizeProvider(provider)
    : 'unknown_provider'
}

function normalizeProvider(value: string): string {
  const normalized = value.trim().slice(0, 128)
  return normalized || 'unknown_provider'
}

function normalizeCode(value: string, fallback: string): string {
  const normalized = value.trim().replace(/\s+/g, '_').slice(0, 128)
  return normalized || fallback
}
