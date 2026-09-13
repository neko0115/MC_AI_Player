import { readFileSync } from 'node:fs'
import { GoogleGenAI } from '@google/genai'
import type { DecisionContext } from '../src/agent/context-builder.js'
import { GeminiTransport } from '../src/agent/providers/gemini.js'

const OPT_IN = 'MC_AI_LIVE_DIAGNOSTIC'
const DEFAULT_ROUTING_CONFIG = 'data/ai-routing.json'
const ALLOWED_OUTCOMES = new Set(['action', 'complete', 'blocked'])
const ALLOWED_INTENTS = new Set([
  'follow_player',
  'stay',
  'go_to',
  'return_home',
  'eat',
  'equip',
  'gather_resource',
  'deposit_item',
  'withdraw_item'
])
const ALLOWED_REASONS = new Set([
  'no_safe_action',
  'missing_information',
  'capability_unavailable'
])

interface RoutingFile {
  readonly models?: {
    readonly routine?: { readonly name?: unknown }
  }
  readonly projects?: ReadonlyArray<{
    readonly apiKeyEnv?: unknown
  }>
}

interface InteractionLike {
  readonly status?: unknown
  readonly steps?: unknown
}

interface StepLike {
  readonly type?: unknown
  readonly name?: unknown
  readonly arguments?: unknown
}

function main(): void {
  if (process.env[OPT_IN] !== '1') {
    console.log(JSON.stringify({ kind: 'skipped', reason: 'not_opted_in' }))
    return
  }

  const routingPath = process.env.MC_AI_ROUTING_CONFIG?.trim() || DEFAULT_ROUTING_CONFIG
  const routing = JSON.parse(readFileSync(routingPath, 'utf8')) as RoutingFile
  const model = typeof routing.models?.routine?.name === 'string'
    ? routing.models.routine.name.trim()
    : ''
  const apiKeyEnv = typeof routing.projects?.[0]?.apiKeyEnv === 'string'
    ? routing.projects[0].apiKeyEnv.trim()
    : ''
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv]?.trim() : undefined

  if (!model || !apiKeyEnv || !apiKey) {
    throw new Error('live diagnostic routing prerequisites are missing')
  }

  const context: DecisionContext = {
    worldKey: '127.0.0.1:25565',
    task: {
      taskId: 'shape-diagnostic-stay',
      objective: '待在這裡',
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
      position: { x: 9.5, y: 76, z: -6.5 }
    },
    nearbyPlayers: [
      { name: 'Moxueneko', position: { x: 9.5, y: 76, z: -6.5 } },
      { name: 'Neko0115', position: { x: 18.98, y: 71, z: -4.18 } }
    ],
    inventory: [],
    recentEvents: [],
    memories: [],
    skills: [{ name: 'stay', description: 'Hold the current position safely.' }],
    safetyConstraints: [
      'PvP is disabled.',
      'Generic navigation cannot dig or build.',
      'Only registered high-level skills may reach deterministic gameplay execution.',
      'SafetyPolicy remains authoritative after every model decision.'
    ]
  }

  const prepared = new GeminiTransport().prepare(context)
  const client = new GoogleGenAI({ apiKey }) as unknown as {
    readonly interactions: {
      create(request: unknown, options: { timeout: number; maxRetries: number }): Promise<unknown>
    }
  }

  void client.interactions.create({
    model,
    input: prepared.input,
    store: false,
    stream: false,
    system_instruction: prepared.systemInstruction,
    tools: prepared.tools,
    generation_config: {
      thinking_level: 'low',
      thinking_summaries: 'none',
      tool_choice: 'any'
    }
  }, {
    timeout: 30_000,
    maxRetries: 0
  }).then(interaction => {
    console.log(JSON.stringify(sanitizeInteraction(interaction), null, 2))
  }).catch(() => {
    console.log(JSON.stringify({ kind: 'failed', code: 'provider_request_failed' }))
    process.exitCode = 1
  })
}

function sanitizeInteraction(value: unknown): unknown {
  if (!isRecord(value)) return { kind: 'diagnostic', responseType: typeOf(value) }
  const interaction = value as InteractionLike
  const steps = Array.isArray(interaction.steps) ? interaction.steps : []
  const stepTypes = steps.map(step => isRecord(step) && typeof step.type === 'string' ? step.type : typeOf(step))
  const call = steps.find(step => isRecord(step) && step.type === 'function_call') as StepLike | undefined

  return {
    kind: 'diagnostic',
    status: typeof interaction.status === 'string' ? interaction.status : typeOf(interaction.status),
    stepTypes,
    functionCall: call
      ? {
          name: typeof call.name === 'string' ? call.name : typeOf(call.name),
          arguments: sanitizeArguments(call.arguments)
        }
      : null
  }
}

function sanitizeArguments(value: unknown): unknown {
  if (!isRecord(value)) {
    return { type: typeOf(value) }
  }

  const action = value.action
  const actionRecord = isRecord(action) ? action : null
  const args = actionRecord?.args
  const argsRecord = isRecord(args) ? args : null

  return {
    type: 'object',
    keys: Object.keys(value).sort(),
    version: safeLiteral(value.version, new Set(['2'])),
    outcome: safeLiteral(value.outcome, ALLOWED_OUTCOMES),
    reason: safeLiteral(value.reason, ALLOWED_REASONS),
    action: actionRecord
      ? {
          type: 'object',
          keys: Object.keys(actionRecord).sort(),
          intent: safeLiteral(actionRecord.intent, ALLOWED_INTENTS),
          args: argsRecord
            ? {
                type: 'object',
                keys: Object.keys(argsRecord).sort(),
                valueTypes: Object.fromEntries(
                  Object.entries(argsRecord)
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([key, entry]) => [key, typeOf(entry)])
                )
              }
            : { type: typeOf(args) }
        }
      : { type: typeOf(action) }
  }
}

function safeLiteral(value: unknown, allowed: ReadonlySet<string>): unknown {
  if (typeof value === 'number' && Number.isInteger(value) && allowed.has(String(value))) {
    return { type: 'number', value }
  }
  if (typeof value === 'string' && allowed.has(value)) {
    return { type: 'string', value }
  }
  return { type: typeOf(value) }
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

main()
