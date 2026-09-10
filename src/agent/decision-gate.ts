import { DecisionV1Schema, type DecisionV1 } from '../contracts/decision.js'
import type { GoalRequest, GoalSource } from '../contracts/goals.js'
import type { SafetyPolicy } from '../safety/policy.js'
import type { WorldStateSnapshot } from '../state/world-state.js'
import type { RuntimeEventBus } from '../telemetry/event-bus.js'
import type { ProviderResult, StructuredProviderMode } from './provider.js'

export interface AiGoalSubmitter {
  submit(request: GoalRequest, source: GoalSource): Promise<unknown>
}

export interface AcceptedDecision {
  readonly kind: 'accepted'
  readonly provider: string
  readonly mode: StructuredProviderMode
  readonly intent: DecisionV1['intent']
  readonly goal: GoalRequest
}

export interface RejectedDecision {
  readonly kind: 'rejected'
  readonly provider: string
  readonly code: string
}

export type GatedDecision = AcceptedDecision | RejectedDecision

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
    result: ProviderResult,
    state: WorldStateSnapshot
  ): Promise<GatedDecision> {
    const provider = normalizeProvider(result.provider)

    if (result.kind === 'timeout') {
      return this.reject(provider, 'provider_timeout')
    }

    if (result.kind === 'invalid') {
      return this.reject(provider, normalizeCode(result.code, 'provider_invalid'))
    }

    const parsed = DecisionV1Schema.safeParse(result.value)
    if (!parsed.success) {
      return this.reject(provider, 'decision_schema_invalid')
    }

    const goal = decisionToGoal(parsed.data)
    const skillAuthorization = this.dependencies.safety.authorizeSkill(
      parsed.data.intent,
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
      intent: parsed.data.intent
    })

    return {
      kind: 'accepted',
      provider,
      mode: result.mode,
      intent: parsed.data.intent,
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

export class DecisionPipeline {
  constructor(
    private readonly gate: DecisionGate,
    private readonly goals: AiGoalSubmitter
  ) {}

  async handle(
    result: ProviderResult,
    state: WorldStateSnapshot
  ): Promise<GatedDecision> {
    const gated = await this.gate.accept(result, state)
    if (gated.kind !== 'accepted') {
      return gated
    }

    await this.goals.submit(gated.goal, 'ai')
    return gated
  }
}

function decisionToGoal(decision: DecisionV1): GoalRequest {
  switch (decision.intent) {
    case 'follow_player':
      return { kind: 'follow_player', args: { ...decision.args } }
    case 'stay':
      return { kind: 'stay', args: {} }
    case 'go_to':
      return { kind: 'go_to', args: { ...decision.args } }
    case 'return_home':
      return { kind: 'return_home', args: {} }
    case 'eat':
      return { kind: 'eat', args: {} }
    case 'equip':
      return { kind: 'equip', args: { ...decision.args } }
    case 'gather_resource':
      return { kind: 'gather_resource', args: { ...decision.args } }
    case 'deposit_item':
      return { kind: 'deposit_item', args: { ...decision.args } }
    case 'withdraw_item':
      return { kind: 'withdraw_item', args: { ...decision.args } }
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
