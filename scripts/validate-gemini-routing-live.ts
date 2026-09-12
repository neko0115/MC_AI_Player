import { randomUUID } from 'node:crypto'
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

export interface LiveValidationStack {
  readonly executor: LogicalDecisionExecutor
  readonly configManager: {
    snapshot(): RoutingConfigSnapshot
  }
  close(): void
}

export interface LiveValidationCaseEvidence {
  readonly case: 'routine' | 'complex' | 'admin_deep'
  readonly model: string
  readonly thinking: ThinkingLevel
  readonly project: string
  readonly result: 'success'
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

  let stack: LiveValidationStack | null = null
  try {
    const createStack = dependencies.createStack ?? createGeminiDecisionStack
    stack = createStack({
      routingConfigPath: normalizedRoutingPath(env.MC_AI_ROUTING_CONFIG),
      env,
      quotaFilename: dependencies.quotaFilename ?? DEFAULT_QUOTA_FILENAME,
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
      capturedRoutes
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
      capturedRoutes
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
      capturedRoutes
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

  return Object.freeze({
    case: options.caseName,
    model: route.model,
    thinking: route.thinking,
    project: route.project,
    result: 'success' as const
  })
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
