import type { DecisionV1 } from '../contracts/decision.js'

export type ChatOutcome =
  | {
      readonly kind: 'goal_started'
      readonly intent: DecisionV1['intent']
      readonly target?: string
      readonly quantity?: number
    }
  | {
      readonly kind: 'goal_completed'
      readonly intent: DecisionV1['intent']
    }
  | {
      readonly kind: 'goal_failed'
      readonly intent: DecisionV1['intent']
      readonly code?: string
    }

export interface ChatRendererOptions {
  readonly maxLength?: number
}

export class ChatRenderer {
  private readonly maxLength: number

  constructor(options: ChatRendererOptions = {}) {
    this.maxLength = options.maxLength ?? 180
    if (!Number.isInteger(this.maxLength) || this.maxLength < 32 || this.maxLength > 256) {
      throw new RangeError('maxLength must be an integer between 32 and 256')
    }
  }

  render(outcome: ChatOutcome): string {
    let message: string
    switch (outcome.kind) {
      case 'goal_completed':
        message = '完成了。'
        break
      case 'goal_failed':
        message = '這次沒有完成。'
        break
      case 'goal_started':
        message = renderStarted(outcome)
        break
    }
    return truncate(message, this.maxLength)
  }
}

function renderStarted(outcome: Extract<ChatOutcome, { kind: 'goal_started' }>): string {
  switch (outcome.intent) {
    case 'gather_resource': {
      const resource = safeIdentifier(outcome.target)
      const quantity = safeQuantity(outcome.quantity)
      return resource && quantity !== null
        ? `好，我去找 ${quantity} 個 ${resource}。`
        : '好，我去收集資源。'
    }
    case 'follow_player': {
      const player = safePlayerName(outcome.target)
      return player ? `好，我跟著 ${player}。` : '好，我開始跟隨。'
    }
    case 'stay':
      return '好，我先待在這裡。'
    case 'go_to':
      return '好，我過去看看。'
    case 'return_home':
      return '好，我回家。'
    case 'eat':
      return '我先吃點東西。'
    case 'equip':
      return '好，我先換上裝備。'
    case 'deposit_item':
      return '好，我去把物品放好。'
    case 'withdraw_item':
      return '好，我去拿指定的物品。'
  }
}

function safeIdentifier(value: string | undefined): string | null {
  const candidate = firstToken(value)
  return candidate && /^[a-z0-9_.:-]{1,128}$/.test(candidate)
    ? candidate
    : null
}

function safePlayerName(value: string | undefined): string | null {
  const firstLine = value?.split(/[\r\n\0]/, 1)[0]?.trim() ?? ''
  const match = /^[A-Za-z0-9_]{1,16}/.exec(firstLine)
  return match?.[0] ?? null
}

function firstToken(value: string | undefined): string | null {
  const token = value?.trim().split(/\s/, 1)[0] ?? ''
  return token || null
}

function safeQuantity(value: number | undefined): number | null {
  return Number.isInteger(value) && (value ?? 0) >= 1 && (value ?? 0) <= 2304
    ? value as number
    : null
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum)
}
