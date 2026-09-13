import type {
  ComplexityAssessment,
  ComplexityEvidence,
  HighReason,
  RoutePlan
} from './contracts.js'

const OPEN_ENDED = [
  '自己想辦法',
  '找個辦法',
  '你自己決定',
  'figure it out',
  'find a way'
] as const

const MANUAL_HINTS = [
  '仔細想',
  '認真想',
  '用大模型',
  'think hard',
  'use the big model'
] as const

const STEP_CONNECTORS = [
  '然後',
  '之後',
  '接著',
  '再',
  'then',
  'and then'
] as const

const SKILL_FAMILIES = [
  ['採', '採集', '收集', '木頭', '木材', '原木', '鐵', 'gather', 'collect', 'resource'],
  ['回家', '回基地', '跟我', '跟著', '前往', '導航', 'navigate', 'follow', 'go to'],
  ['箱', '儲存', '存放', '放進', '拿出', 'withdraw', 'deposit', 'storage', 'chest'],
  ['吃', '食物', '補血', 'eat', 'food'],
  ['裝備', '穿上', '拿著', 'equip', 'equipment']
] as const

const CONTEXT_DOMAINS = [
  ['之前', '上次', '說過', '說的', '記得', 'remember', 'previous'],
  ['背包', '身上', '庫存', 'inventory', '拿出'],
  ['基地', '箱子', '這裡', '那裡', '位置', 'world', 'location'],
  ['玩家', 'boss', '跟我', 'player']
] as const

const WEIGHTS = {
  multiStep: 3,
  multiSkill: 2,
  openEndedMethod: 4,
  crossContextReasoning: 2,
  goalFailed: 2,
  stuck: 2,
  manualComplexityHint: 2,
  riskContext: 3
} as const

const REASON_NAMES: Record<keyof typeof WEIGHTS, string> = {
  multiStep: 'multi_step',
  multiSkill: 'multi_skill',
  openEndedMethod: 'open_ended_method',
  crossContextReasoning: 'cross_context_reasoning',
  goalFailed: 'goal_failed',
  stuck: 'stuck',
  manualComplexityHint: 'manual_complexity_hint',
  riskContext: 'risk_context'
}

export function analyzeInstructionComplexity(instruction: string): ComplexityEvidence {
  const normalized = instruction.trim().toLowerCase()
  if (!normalized) return {}

  const evidence: {
    multiStep?: true
    multiSkill?: true
    openEndedMethod?: true
    crossContextReasoning?: true
    manualComplexityHint?: true
  } = {}

  if (containsAny(normalized, STEP_CONNECTORS)) evidence.multiStep = true
  if (matchingGroupCount(normalized, SKILL_FAMILIES) >= 2) evidence.multiSkill = true
  if (containsAny(normalized, OPEN_ENDED)) evidence.openEndedMethod = true
  if (matchingGroupCount(normalized, CONTEXT_DOMAINS) >= 2) evidence.crossContextReasoning = true
  if (containsAny(normalized, MANUAL_HINTS)) evidence.manualComplexityHint = true

  return evidence
}

export function assessComplexity(evidence: ComplexityEvidence): ComplexityAssessment {
  let score = 0
  const reasons: string[] = []

  for (const key of Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>) {
    if (evidence[key] !== true) continue
    score += WEIGHTS[key]
    reasons.push(REASON_NAMES[key])
  }

  const highReason = highReasonOf(evidence)
  if (highReason && !reasons.includes(highReason)) {
    reasons.push(highReason)
  }

  const routeClass = highReason || score >= 4 ? 'complex' : 'routine'
  const thinking = highReason ? 'high' : routeClass === 'complex' ? 'medium' : 'low'

  return Object.freeze({
    policy: 'balanced-v1' as const,
    score,
    routeClass,
    thinking,
    reasons: Object.freeze(reasons),
    highReason
  })
}

export function createRoutePlan(
  decisionId: string,
  assessment: ComplexityAssessment,
  reserveAuthorized: boolean
): RoutePlan {
  const normalizedId = decisionId.trim()
  if (!normalizedId || normalizedId.length > 128) {
    throw new RangeError('decisionId must be between 1 and 128 characters')
  }

  return Object.freeze({
    decisionId: normalizedId,
    policy: 'balanced-v1' as const,
    routeClass: assessment.routeClass,
    thinking: assessment.thinking,
    reserveAuthorized,
    reasons: Object.freeze([...assessment.reasons]),
    highReason: assessment.highReason
  })
}

function highReasonOf(evidence: ComplexityEvidence): HighReason | null {
  if (evidence.manualDeep === true) return 'manual_deep_think'
  if (evidence.criticalContext === true) return 'critical_context'
  if ((evidence.replanCount ?? 0) >= 2) return 'repeated_replanning'
  return null
}

function containsAny(value: string, phrases: readonly string[]): boolean {
  return phrases.some(phrase => value.includes(phrase))
}

function matchingGroupCount(
  value: string,
  groups: ReadonlyArray<readonly string[]>
): number {
  let count = 0
  for (const group of groups) {
    if (containsAny(value, group)) count += 1
  }
  return count
}
