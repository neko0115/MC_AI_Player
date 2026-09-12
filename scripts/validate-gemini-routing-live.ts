import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DecisionContext } from '../src/agent/context-builder.js'
import { DecisionOutcomeV2Schema } from '../src/contracts/decision.js'
import {
  assessComplexity,
  createRoutePlan
} from '../src/agent/routing/complexity.js'
import type {
  LogicalDecisionExecutor,
  ThinkingLevel
} from '../src/agent/routing/contracts.js'
import type { RoutingConfigSnapshot } from '../src/agent/routing/config-manager.js'
import {
  createGeminiDecisionStack,
  type GeminiDecisionStackOptions
} from '../src/main.js'
import { RuntimeEventBus } from '../src/telemetry/event-bus.js'

const DEFAULT_ROUTING_CONFIG = 'data/ai-routing.json'
const DEFAULT_QUOTA_FILENAME = 'data/ai-quota.sqlite3'
const require = createRequire(import.meta.url)

interface ReadonlyStatementLike {
  get(...params: unknown[]): unknown
}

interface ReadonlyDatabaseLike {
  prepare(sql: string): ReadonlyStatementLike
  close(): void
}

type ReadonlyDatabaseConstructor = new (
  filename: string,
  options?: { readonly readonly?: boolean; readonly fileMustExist?: boolean }
) => ReadonlyDatabaseLike

const Database = require('better-sqlite3') as ReadonlyDatabaseConstructor

export interface LiveValidationStack {
  readonly executor: LogicalDecisionExecutor
  readonly configManager: {
    snapshot(): RoutingConfigSnapshot
  }
  close(): void
}

export interface LiveValidationUsageEvidence {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly thoughtTokens: number
  readonly toolTokens: number
  readonly totalTokens: number
}

export interface LiveValidationCaseEvidence {
  readonly case: 'routine' | 'complex' | 'admin_deep'
  readonly model: string
  readonly thinking: ThinkingLevel
  readonly project: string
  readonly result: 'success'
  readonly usage: LiveValidationUsageEvidence
}

export type LiveValidationResult =
  | { readonly kind: 'skipped'; readonly reason: 'not_opted_in' }
  | { readonly kind: 'passed'; readonly cases: readonly LiveValidationCaseEvidence[] }
  | { readonly kind: 'failed'; readonly code: 'validation_failed' }

export interface LiveValidationDependencies {
  readonly createStack?: (options: GeminiDecisionStackOptions) => LiveValidationStack
  readonly writeLine?: (line: string) => void
  readonly quotaFilename?: string
  readonly processInstanceId?: string
  readonly now?: () => number
  readonly readActualUsage?: (
    quotaFilename: string,
    decisionId: string,
    model: string
  ) => LiveValidationUsageEvidence | null
}

interface CapturedRoute {
  readonly model: string
  readonly thinking: ThinkingLevel
  readonly project: string
  readonly reserveAuthorized: boolean
  readonly reserveUsed: boolean
}

export async function runGeminiRoutingLiveValidation(
  env: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: LiveValidationDependencies = {}
): Promise<LiveValidationResult> {
  const writeLine = dependencies.writeLine ?? (line => console.log(line))
  if (env.MC_AI_LIVE_VALIDATION !== '1') {
    const skipped: LiveValidationResult = {
      kind: 'skipped',
      reason: 'not_opted_in'
    }
    writeLine(JSON.stringify(skipped))
    return skipped
  }

  const events = new RuntimeEventBus()
  const capturedRoutes = new Map<string, CapturedRoute>()
  const unsubscribe = events.subscribe(event => {
    if (event.type !== 'model_route') return
    capturedRoutes.set(event.decisionId, {
      model: event.model,
      thinking: event.thinking,
      project: event.project,
      reserveAuthorized: event.reserveAuthorized,
      reserveUsed: event.reserveUsed
    })
  })

  const quotaFilename = dependencies.quotaFilename ?? DEFAULT_QUOTA_FILENAME
  const readActualUsage = dependencies.readActualUsage ?? readActualUsageFromQuotaDb
  let stack: LiveValidationStack | null = null
  try {
    const createStack = dependencies.createStack ?? createGeminiDecisionStack
    stack = createStack({
      routingConfigPath: normalizedRoutingPath(env.MC_AI_ROUTING_CONFIG),
      env,
      quotaFilename,
      processInstanceId: dependencies.processInstanceId ?? randomUUID(),
      events,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now })
    })

    const snapshot = stack.configManager.snapshot()
    const routine = await executeCase({
      caseName: 'routine',
      decisionId: 'live-validation-routine',
      context: validationContext('live-validation-routine', 'Validate one safe structured routine outcome.'),
      routePlan: createRoutePlan(
        'live-validation-routine',
        assessComplexity({}),
        false
      ),
      expectedModel: snapshot.models.routine.name,
      expectedThinking: 'low',
      expectedReserveAuthorized: false,
      executor: stack.executor,
      capturedRoutes,
      quotaFilename,
      readActualUsage
    })
    const complex = await executeCase({
      caseName: 'complex',
      decisionId: 'live-validation-complex',
      context: validationContext(
        'live-validation-complex',
        'Consider the bounded state and choose one safe structured validation outcome.'
      ),
      routePlan: createRoutePlan(
        'live-validation-complex',
        assessComplexity({ openEndedMethod: true }),
        false
      ),
      expectedModel: snapshot.models.complex.name,
      expectedThinking: 'medium',
      expectedReserveAuthorized: false,
      executor: stack.executor,
      capturedRoutes,
      quotaFilename,
      readActualUsage
    })
    const adminDeep = await executeCase({
      caseName: 'admin_deep',
      decisionId: 'live-validation-admin-deep',
      context: validationContext(
        'live-validation-admin-deep',
        'Validate one trusted local-admin deep-think structured outcome without Minecraft side effects.'
      ),
      routePlan: createRoutePlan(
        'live-validation-admin-deep',
        assessComplexity({ manualDeep: true }),
        true
      ),
      expectedModel: snapshot.models.complex.name,
      expectedThinking: 'high',
      expectedReserveAuthorized: true,
      executor: stack.executor,
      capturedRoutes,
      quotaFilename,
      readActualUsage
    })

    const passed: LiveValidationResult = {
      kind: 'passed',
      cases: Object.freeze([routine, complex, adminDeep])
    }
    writeLine(JSON.stringify(passed))
    return passed
  } catch {
    const failed: LiveValidationResult = {
      kind: 'failed',
      code: 'validation_failed'
    }
    writeLine(JSON.stringify(failed))
    return failed
  } finally {
    unsubscribe()
    stack?.close()
  }
}

async function executeCase(options: {
  readonly caseName: LiveValidationCaseEvidence['case']
  readonly decisionId: string
  readonly context: DecisionContext
  readonly routePlan: Parameters<LogicalDecisionExecutor['execute']>[0]['routePlan']
  readonly expectedModel: string
  readonly expectedThinking: ThinkingLevel
  readonly expectedReserveAuthorized: boolean
  readonly executor: LogicalDecisionExecutor
  readonly capturedRoutes: ReadonlyMap<string, CapturedRoute>
  readonly quotaFilename: string
  readonly readActualUsage: NonNullable<LiveValidationDependencies['readActualUsage']>
}): Promise<LiveValidationCaseEvidence> {
  const result = await options.executor.execute(
    { context: options.context, routePlan: options.routePlan },
    new AbortController().signal
  )
  if (result.kind !== 'success') throw new Error('logical decision did not succeed')
  if (result.providerResult.kind !== 'structured') {
    throw new Error('provider did not return structured output')
  }
  if (!DecisionOutcomeV2Schema.safeParse(result.providerResult.value).success) {
    throw new Error('provider output did not match DecisionOutcomeV2')
  }

  const route = options.capturedRoutes.get(options.decisionId)
  if (!route) throw new Error('model route telemetry was not observed')
  if (route.model !== options.expectedModel) throw new Error('unexpected model route')
  if (route.thinking !== options.expectedThinking) throw new Error('unexpected thinking level')
  if (route.reserveAuthorized !== options.expectedReserveAuthorized) {
    throw new Error('unexpected reserve authorization')
  }
  if (route.reserveUsed) {
    throw new Error('live validation must not consume Flash reserve')
  }

  const usage = options.readActualUsage(
    options.quotaFilename,
    options.decisionId,
    route.model
  )
  if (!usage) throw new Error('actual usage settlement was not observed')
  validateUsageEvidence(usage)

  return Object.freeze({
    case: options.caseName,
    model: route.model,
    thinking: route.thinking,
    project: route.project,
    result: 'success' as const,
    usage: Object.freeze({ ...usage })
  })
}

function readActualUsageFromQuotaDb(
  quotaFilename: string,
  decisionId: string,
  model: string
): LiveValidationUsageEvidence | null {
  const db = new Database(quotaFilename, { readonly: true, fileMustExist: true })
  try {
    const value = db.prepare(`
      SELECT usage_quality, actual_input_tokens, actual_output_tokens,
             actual_thought_tokens, actual_tool_tokens, actual_total_tokens
      FROM quota_attempts
      WHERE decision_id = ? AND model = ? AND state = 'settled'
      ORDER BY settled_at DESC, attempt_id DESC
      LIMIT 1
    `).get(decisionId, model)
    if (!isRecord(value) || value.usage_quality !== 'actual') return null

    const usage: LiveValidationUsageEvidence = {
      inputTokens: nonNegativeInteger(value.actual_input_tokens),
      outputTokens: nonNegativeInteger(value.actual_output_tokens),
      thoughtTokens: nonNegativeInteger(value.actual_thought_tokens),
      toolTokens: nonNegativeInteger(value.actual_tool_tokens),
      totalTokens: nonNegativeInteger(value.actual_total_tokens)
    }
    validateUsageEvidence(usage)
    return usage
  } catch {
    return null
  } finally {
    db.close()
  }
}

function validateUsageEvidence(usage: LiveValidationUsageEvidence): void {
  for (const value of Object.values(usage)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error('invalid actual usage evidence')
    }
  }
  if (usage.totalTokens < usage.inputTokens) {
    throw new Error('invalid actual usage total')
  }
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error('invalid actual usage token count')
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validationContext(taskId: string, objective: string): DecisionContext {
  return {
    worldKey: 'gemini-live-validation',
    task: {
      taskId,
      objective,
      phase: 'active',
      consecutiveReplans: 0,
      previousAction: null
    },
    currentGoal: null,
    self: {
      connected: true,
      spawned: true,
      health: 20,
      food: 20,
      dimension: 'overworld',
      position: { x: 0, y: 64, z: 0 }
    },
    nearbyPlayers: [],
    inventory: [],
    recentEvents: [],
    memories: [],
    skills: [{ name: 'stay', description: 'Hold the current position safely.' }],
    safetyConstraints: [
      'This is a provider compatibility validation. No Minecraft action will be executed.',
      'Return exactly one structured DecisionOutcomeV2 through the required tool call.'
    ]
  }
}

function normalizedRoutingPath(value: string | undefined): string {
  const normalized = value?.trim()
  return normalized || DEFAULT_ROUTING_CONFIG
}

function isEntrypoint(): boolean {
  const script = process.argv[1]
  if (!script) return false
  return import.meta.url === pathToFileURL(resolve(script)).href
}

if (isEntrypoint()) {
  void runGeminiRoutingLiveValidation().then(result => {
    if (result.kind === 'failed') process.exitCode = 1
  })
}
