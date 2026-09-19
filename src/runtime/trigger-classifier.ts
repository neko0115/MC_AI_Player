import { analyzeInstructionComplexity } from '../agent/routing/complexity.js'
import type { ComplexityEvidence } from '../agent/routing/contracts.js'
import type { RuntimeEvent } from '../contracts/events.js'

export interface TriggerClassifierOptions {
  readonly botUsername: string
}

export interface TriggerContext {
  readonly taskId: string
  readonly activeGoalId: string | null
}

export type TriggerClassification =
  | { readonly kind: 'state_only' }
  | {
      readonly kind: 'explicit_instruction'
      readonly instruction: string
      readonly player: string
      readonly playerId?: string
      readonly ingressKey: string
      readonly baseComplexityEvidence: ComplexityEvidence
    }
  | {
      readonly kind: 'failure_evidence'
      readonly causeKey: string
      readonly reason: 'stuck' | 'skill_failed'
    }
  | {
      readonly kind: 'replan'
      readonly causeKey: string
      readonly goalId: string
    }
  | { readonly kind: 'cancelled'; readonly goalId: string }
  | { readonly kind: 'goal_completed'; readonly goalId: string }

export class TriggerClassifier {
  private readonly addresses: readonly string[]

  constructor(options: TriggerClassifierOptions) {
    const botUsername = options.botUsername.trim()
    if (botUsername.length < 1 || botUsername.length > 64) {
      throw new RangeError('botUsername must be between 1 and 64 characters')
    }
    this.addresses = Object.freeze([
      `!moxue`,
      '墨雪',
      'moxue',
      botUsername.toLowerCase()
    ].sort((left, right) => right.length - left.length))
  }

  classify(event: RuntimeEvent, context: TriggerContext): TriggerClassification {
    switch (event.type) {
      case 'player_chat':
        return this.classifyChat(event)

      case 'stuck':
        if (!context.activeGoalId) return { kind: 'state_only' }
        return {
          kind: 'failure_evidence',
          causeKey: `goal:${context.activeGoalId}`,
          reason: 'stuck'
        }

      case 'skill_failed':
        if (!context.activeGoalId) return { kind: 'state_only' }
        return {
          kind: 'failure_evidence',
          causeKey: `goal:${context.activeGoalId}`,
          reason: 'skill_failed'
        }

      case 'goal_failed':
        if (!context.activeGoalId || event.goalId !== context.activeGoalId) {
          return { kind: 'state_only' }
        }
        return {
          kind: 'replan',
          causeKey: `goal:${event.goalId}`,
          goalId: event.goalId
        }

      case 'goal_cancelled':
        if (!context.activeGoalId || event.goalId !== context.activeGoalId) {
          return { kind: 'state_only' }
        }
        return { kind: 'cancelled', goalId: event.goalId }

      case 'goal_completed':
        if (!context.activeGoalId || event.goalId !== context.activeGoalId) {
          return { kind: 'state_only' }
        }
        return { kind: 'goal_completed', goalId: event.goalId }

      default:
        return { kind: 'state_only' }
    }
  }

  private classifyChat(
    event: Extract<RuntimeEvent, { type: 'player_chat' }>
  ): TriggerClassification {
    const instruction = extractAddressedInstruction(event.message, this.addresses)
    if (instruction === null) return { kind: 'state_only' }

    return {
      kind: 'explicit_instruction',
      instruction,
      player: event.player,
      ...(event.playerId === undefined ? {} : { playerId: event.playerId }),
      ingressKey: `chat:${event.at}:${event.player}:${event.playerId ?? ''}`,
      baseComplexityEvidence: analyzeInstructionComplexity(instruction)
    }
  }
}

function extractAddressedInstruction(
  message: string,
  addresses: readonly string[]
): string | null {
  const trimmed = message.trim()
  const lowered = trimmed.toLowerCase()

  for (const address of addresses) {
    if (!lowered.startsWith(address)) continue

    const following = trimmed.slice(address.length)
    if (following.length > 0 && !isAddressBoundary(following[0] ?? '')) {
      continue
    }

    const instruction = following
      .replace(/^\s*[,，:：]\s*/, '')
      .trim()
    return instruction.length > 0 ? instruction : null
  }

  return null
}

function isAddressBoundary(value: string): boolean {
  return /[\s,，:：]/u.test(value)
}
