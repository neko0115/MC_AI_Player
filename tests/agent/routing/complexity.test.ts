import assert from 'node:assert/strict'
import test from 'node:test'
import {
  analyzeInstructionComplexity,
  assessComplexity,
  createRoutePlan
} from '../../../src/agent/routing/complexity.js'

test('instruction analyzer derives only deterministic bounded complexity signals', () => {
  assert.deepEqual(analyzeInstructionComplexity('跟我來'), {})

  const multi = analyzeInstructionComplexity('採木頭然後回基地放箱子')
  assert.equal(multi.multiStep, true)
  assert.equal(multi.multiSkill, true)

  assert.equal(
    analyzeInstructionComplexity('自己想辦法找到鐵').openEndedMethod,
    true
  )
  assert.equal(
    analyzeInstructionComplexity('把之前說的木頭拿出來，背包不夠就再補').crossContextReasoning,
    true
  )
  assert.deepEqual(analyzeInstructionComplexity('墨雪仔細想一下'), {
    manualComplexityHint: true
  })
})

test('balanced-v1 threshold routes routine versus complex without high-by-score', () => {
  const cases = [
    [{}, 0, 'routine', 'low'],
    [{ multiStep: true }, 3, 'routine', 'low'],
    [{ openEndedMethod: true }, 4, 'complex', 'medium'],
    [{ multiStep: true, multiSkill: true }, 5, 'complex', 'medium'],
    [{ goalFailed: true, stuck: true }, 4, 'complex', 'medium'],
    [{ manualComplexityHint: true }, 2, 'routine', 'low'],
    [{ multiStep: true, multiSkill: true, openEndedMethod: true, riskContext: true }, 12, 'complex', 'medium']
  ] as const

  for (const [evidence, score, routeClass, thinking] of cases) {
    const result = assessComplexity(evidence)
    assert.equal(result.score, score)
    assert.equal(result.routeClass, routeClass)
    assert.equal(result.thinking, thinking)
  }
})

test('high thinking comes only from explicit high overrides and not score', () => {
  assert.equal(
    assessComplexity({ replanCount: 2 }).highReason,
    'repeated_replanning'
  )
  assert.equal(
    assessComplexity({ criticalContext: true }).highReason,
    'critical_context'
  )
  assert.equal(
    assessComplexity({ manualDeep: true }).highReason,
    'manual_deep_think'
  )
  assert.equal(assessComplexity({ replanCount: 1 }).thinking, 'low')
})

test('RoutePlan freezes routing semantics and keeps reserve authorization separate from scoring', () => {
  const assessment = assessComplexity({ openEndedMethod: true, manualDeep: true })
  const plan = createRoutePlan('decision-1', assessment, true)

  assert.deepEqual(plan, {
    decisionId: 'decision-1',
    policy: 'balanced-v1',
    routeClass: 'complex',
    thinking: 'high',
    reserveAuthorized: true,
    reasons: ['open_ended_method', 'manual_deep_think'],
    highReason: 'manual_deep_think'
  })
  assert.equal(Object.isFrozen(plan), true)
  assert.equal(Object.isFrozen(plan.reasons), true)
})
