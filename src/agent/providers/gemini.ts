import { GoogleGenAI } from '@google/genai'
import type { DecisionContext } from '../context-builder.js'
import type { AttemptLease } from '../routing/contracts.js'
import {
  SAFE_GAMEPLAY_PROVIDER_CAPABILITIES,
  type DecisionProvider,
  type DecisionRequest,
  type ProviderResult
} from '../provider.js'

export type GeminiThinkingLevel = 'low' | 'medium' | 'high'

export interface GeminiFunctionTool {
  readonly type: 'function'
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
}

export interface GeminiInteractionRequest {
  readonly model: string
  readonly input: string
  readonly store: false
  readonly stream?: false
  readonly system_instruction: string
  readonly tools: readonly GeminiFunctionTool[]
  readonly generation_config: {
    readonly thinking_level: GeminiThinkingLevel
    readonly thinking_summaries: 'none'
    readonly tool_choice: 'any'
  }
}

export type GeminiInteractionStep =
  | {
      readonly type: 'thought'
      readonly summary?: unknown
      readonly signature?: unknown
    }
  | {
      readonly type: 'function_call'
      readonly id?: string
      readonly name?: string
      readonly arguments?: unknown
    }
  | {
      readonly type: string
      readonly [key: string]: unknown
    }

export interface GeminiInteractionUsage {
  readonly total_input_tokens?: number
  readonly total_output_tokens?: number
  readonly total_thought_tokens?: number
  readonly total_tool_use_tokens?: number
  readonly total_tokens?: number
}

export interface GeminiInteractionResponse {
  readonly status: string
  readonly steps?: readonly GeminiInteractionStep[]
  readonly usage?: GeminiInteractionUsage
}

export interface GeminiInteractionClient {
  create(
    request: GeminiInteractionRequest,
    options: { readonly timeout: number }
  ): Promise<GeminiInteractionResponse>
}

export interface GeminiDecisionProviderOptions {
  readonly interactions: GeminiInteractionClient
  readonly model: string
  readonly timeoutMs?: number
  readonly thinkingLevel?: GeminiThinkingLevel
}

export interface CreateGeminiDecisionProviderOptions {
  readonly apiKey: string
  readonly model: string
  readonly timeoutMs?: number
  readonly thinkingLevel?: GeminiThinkingLevel
}

export interface PreparedGeminiPayload {
  readonly input: string
  readonly systemInstruction: string
  readonly tools: readonly GeminiFunctionTool[]
  readonly utf8Bytes: number
}

export interface GeminiAttemptClient {
  create(
    request: GeminiInteractionRequest,
    options: {
      readonly timeout: number
      readonly retryAttempts: 1
      readonly signal: AbortSignal
    }
  ): Promise<GeminiInteractionResponse>
}

export interface GeminiTransportOptions {
  readonly timeoutMs?: number
  readonly resolveCredential?: (credentialHandle: string) => string
  readonly createClient?: (apiKey: string) => GeminiAttemptClient
}

export interface GeminiUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly thoughtTokens: number
  readonly toolTokens: number
  readonly totalTokens: number
}

export interface GeminiAttemptSuccess {
  readonly kind: 'success'
  readonly providerResult: ProviderResult
  readonly usage?: GeminiUsage
}

const PROVIDER_NAME = 'gemini'
const FUNCTION_NAME = 'submit_decision'
const DEFAULT_TIMEOUT_MS = 30_000
const SYSTEM_INSTRUCTION = [
  'You are the high-level Minecraft decision planner for a deterministic gameplay runtime.',
  'Use the supplied bounded context and safety constraints to choose exactly one high-level action.',
  `You MUST call the ${FUNCTION_NAME} function exactly once.`,
  'Do not emit model text as the answer.',
  'Keep internal reasoning private. Never put reasoning, analysis, thought, or explanations inside function arguments.',
  'The deterministic runtime, not the model, performs movement, digging, inventory operations, and safety enforcement.'
].join(' ')

const DECISION_PARAMETER_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  oneOf: [
    decisionBranch('follow_player', {
      player: stringSchema(64),
      range: numberSchema(1, 16)
    }, ['player']),
    decisionBranch('stay', {}, []),
    decisionBranch('go_to', {
      x: finiteNumberSchema(),
      y: finiteNumberSchema(),
      z: finiteNumberSchema(),
      radius: numberSchema(0, 16)
    }, ['x', 'y', 'z']),
    decisionBranch('return_home', {}, []),
    decisionBranch('eat', {}, []),
    decisionBranch('equip', {
      item: stringSchema(128),
      destination: {
        type: 'string',
        enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet']
      }
    }, ['item']),
    decisionBranch('gather_resource', {
      resource: stringSchema(128),
      quantity: integerSchema(1, 2304)
    }, ['resource', 'quantity']),
    decisionBranch('deposit_item', {
      item: stringSchema(128),
      quantity: integerSchema(1, 2304),
      storage: stringSchema(128)
    }, ['item', 'quantity', 'storage']),
    decisionBranch('withdraw_item', {
      item: stringSchema(128),
      quantity: integerSchema(1, 2304),
      storage: IdentifierSchema()
    }, ['item', 'quantity', 'storage'])
  ]
})

const DECISION_OUTCOME_V2_PARAMETER_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        version: { const: 2, type: 'integer' },
        outcome: { const: 'action', type: 'string' },
        action: {
          oneOf: [
            actionBranch('follow_player', {
              player: stringSchema(64),
              range: numberSchema(1, 16)
            }, ['player']),
            actionBranch('stay', {}, []),
            actionBranch('go_to', {
              x: finiteNumberSchema(),
              y: finiteNumberSchema(),
              z: finiteNumberSchema(),
              radius: numberSchema(0, 16)
            }, ['x', 'y', 'z']),
            actionBranch('return_home', {}, []),
            actionBranch('eat', {}, []),
            actionBranch('equip', {
              item: stringSchema(128),
              destination: {
                type: 'string',
                enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet']
              }
            }, ['item']),
            actionBranch('gather_resource', {
              resource: stringSchema(128),
              quantity: integerSchema(1, 2304)
            }, ['resource', 'quantity']),
            actionBranch('deposit_item', {
              item: stringSchema(128),
              quantity: integerSchema(1, 2304),
              storage: IdentifierSchema()
            }, ['item', 'quantity', 'storage']),
            actionBranch('withdraw_item', {
              item: stringSchema(128),
              quantity: integerSchema(1, 2304),
              storage: IdentifierSchema()
            }, ['item', 'quantity', 'storage'])
          ]
        }
      },
      required: ['version', 'outcome', 'action']
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        version: { const: 2, type: 'integer' },
        outcome: { const: 'complete', type: 'string' }
      },
      required: ['version', 'outcome']
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        version: { const: 2, type: 'integer' },
        outcome: { const: 'blocked', type: 'string' },
        reason: {
          type: 'string',
          enum: ['no_safe_action', 'missing_information', 'capability_unavailable']
        }
      },
      required: ['version', 'outcome', 'reason']
    }
  ]
})

export class GeminiDecisionProvider implements DecisionProvider<DecisionContext> {
  readonly capabilities = SAFE_GAMEPLAY_PROVIDER_CAPABILITIES
  private readonly timeoutMs: number
  private readonly thinkingLevel: GeminiThinkingLevel
  private readonly model: string

  constructor(private readonly options: GeminiDecisionProviderOptions) {
    this.model = normalizeModel(options.model)
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000) {
      throw new RangeError('timeoutMs must be an integer between 1 and 300000')
    }
    this.thinkingLevel = options.thinkingLevel ?? 'high'
  }

  async decide(request: DecisionRequest<DecisionContext>): Promise<ProviderResult> {
    const interactionRequest = buildInteractionRequest(
      this.model,
      this.thinkingLevel,
      request.context
    )

    let response: GeminiInteractionResponse
    try {
      response = await this.options.interactions.create(
        interactionRequest,
        { timeout: this.timeoutMs }
      )
    } catch (error) {
      if (isTimeoutError(error)) {
        return { kind: 'timeout', provider: PROVIDER_NAME }
      }
      return {
        kind: 'invalid',
        provider: PROVIDER_NAME,
        code: 'provider_request_failed'
      }
    }

    return extractDecisionFunctionCall(response)
  }
}

export function createGeminiDecisionProvider(
  options: CreateGeminiDecisionProviderOptions
): GeminiDecisionProvider {
  const apiKey = options.apiKey.trim()
  if (!apiKey) {
    throw new TypeError('Gemini apiKey must be a non-empty string')
  }

  const client = new GoogleGenAI({ apiKey })
  const interactions: GeminiInteractionClient = {
    async create(request, callOptions) {
      const interaction = await client.interactions.create(
        toSdkInteractionRequest(request),
        { timeout: callOptions.timeout }
      )

      return normalizeSdkInteraction(interaction)
    }
  }

  return new GeminiDecisionProvider({
    interactions,
    model: options.model,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel })
  })
}

function buildInteractionRequest(
  model: string,
  thinkingLevel: GeminiThinkingLevel,
  context: DecisionContext
): GeminiInteractionRequest {
  return {
    model,
    input: JSON.stringify({
      task: 'Choose exactly one safe high-level Minecraft intent from the available skills.',
      context
    }),
    store: false,
    stream: false,
    system_instruction: SYSTEM_INSTRUCTION,
    tools: [{
      type: 'function',
      name: FUNCTION_NAME,
      description: 'Submit exactly one validated high-level Minecraft decision. Never include reasoning.',
      parameters: DECISION_PARAMETER_SCHEMA
    }],
    generation_config: {
      thinking_level: thinkingLevel,
      thinking_summaries: 'none',
      tool_choice: 'any'
    }
  }
}

function extractDecisionFunctionCall(response: GeminiInteractionResponse): ProviderResult {
  if (response.status !== 'requires_action') {
    return invalid('interaction_status_invalid')
  }

  if (!Array.isArray(response.steps)) {
    return {
      kind: 'invalid',
      provider: PROVIDER_NAME,
      code: 'response_steps_missing'
    }
  }

  const calls: Array<Extract<GeminiInteractionStep, { type: 'function_call' }>> = []
  for (const step of response.steps) {
    if (!step || typeof step !== 'object' || typeof step.type !== 'string') {
      return invalid('unexpected_provider_step')
    }
    if (step.type === 'thought') continue
    if (step.type !== 'function_call') return invalid('unexpected_provider_step')
    calls.push(step as Extract<GeminiInteractionStep, { type: 'function_call' }>)
  }

  if (calls.length === 0) return invalid('function_call_missing')
  if (calls.length !== 1) return invalid('function_call_count_invalid')

  const call = calls[0]
  if (!call || call.name !== FUNCTION_NAME) return invalid('unexpected_function_call')
  if (call.arguments === undefined || call.arguments === null) {
    return invalid('function_arguments_missing')
  }
  if (typeof call.arguments !== 'object' || Array.isArray(call.arguments)) {
    return invalid('function_arguments_invalid')
  }

  let value: unknown
  try {
    value = structuredClone(call.arguments)
  } catch {
    return invalid('function_arguments_invalid')
  }

  return {
    kind: 'structured',
    provider: PROVIDER_NAME,
    mode: 'function_call',
    value
  }
}

function normalizeSdkStep(step: unknown): GeminiInteractionStep {
  if (!step || typeof step !== 'object') return { type: 'invalid_sdk_step' }
  const candidate = step as {
    type?: unknown
    id?: unknown
    name?: unknown
    arguments?: unknown
  }
  const type = typeof candidate.type === 'string' ? candidate.type : 'invalid_sdk_step'
  if (type === 'thought') return { type: 'thought' }
  if (type === 'function_call') {
    return {
      type: 'function_call',
      ...(typeof candidate.id === 'string' ? { id: candidate.id } : {}),
      ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
      ...(candidate.arguments === undefined ? {} : { arguments: candidate.arguments })
    }
  }
  return { type }
}

function normalizeSdkInteraction(interaction: unknown): GeminiInteractionResponse {
  if (!interaction || typeof interaction !== 'object') {
    return { status: 'invalid_sdk_response' }
  }
  const candidate = interaction as {
    status?: unknown
    steps?: unknown
    usage?: unknown
  }
  return {
    status: typeof candidate.status === 'string' ? candidate.status : 'invalid_sdk_response',
    ...(Array.isArray(candidate.steps)
      ? { steps: candidate.steps.map(normalizeSdkStep) }
      : {}),
    ...(isRecord(candidate.usage) ? { usage: normalizeSdkUsage(candidate.usage) } : {})
  }
}

function normalizeSdkUsage(usage: Record<string, unknown>): GeminiInteractionUsage {
  return {
    ...(nonNegativeInteger(usage.total_input_tokens) === undefined
      ? {}
      : { total_input_tokens: nonNegativeInteger(usage.total_input_tokens) }),
    ...(nonNegativeInteger(usage.total_output_tokens) === undefined
      ? {}
      : { total_output_tokens: nonNegativeInteger(usage.total_output_tokens) }),
    ...(nonNegativeInteger(usage.total_thought_tokens) === undefined
      ? {}
      : { total_thought_tokens: nonNegativeInteger(usage.total_thought_tokens) }),
    ...(nonNegativeInteger(usage.total_tool_use_tokens) === undefined
      ? {}
      : { total_tool_use_tokens: nonNegativeInteger(usage.total_tool_use_tokens) }),
    ...(nonNegativeInteger(usage.total_tokens) === undefined
      ? {}
      : { total_tokens: nonNegativeInteger(usage.total_tokens) })
  }
}

function normalizeUsage(usage: GeminiInteractionUsage | undefined): GeminiUsage | undefined {
  if (!usage) return undefined
  const inputTokens = nonNegativeInteger(usage.total_input_tokens)
  const outputTokens = nonNegativeInteger(usage.total_output_tokens)
  const thoughtTokens = nonNegativeInteger(usage.total_thought_tokens)
  const toolTokens = nonNegativeInteger(usage.total_tool_use_tokens)
  const totalTokens = nonNegativeInteger(usage.total_tokens)
  if (
    inputTokens === undefined || outputTokens === undefined ||
    thoughtTokens === undefined || toolTokens === undefined || totalTokens === undefined
  ) {
    return undefined
  }
  return { inputTokens, outputTokens, thoughtTokens, toolTokens, totalTokens }
}

function invalid(code: string): ProviderResult {
  return { kind: 'invalid', provider: PROVIDER_NAME, code }
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'TimeoutError' || error.name === 'RequestTimeoutError'
}

function normalizeModel(value: string): string {
  const model = value.trim()
  if (model.length < 1 || model.length > 256) {
    throw new RangeError('model must be between 1 and 256 characters')
  }
  return model
}

function decisionBranch(
  intent: string,
  argsProperties: Record<string, unknown>,
  requiredArgs: readonly string[]
): Readonly<Record<string, unknown>> {
  return {
    type: 'object', additionalProperties: false,
    properties: {
      version: { const: 1, type: 'integer' },
      intent: { const: intent, type: 'string' },
      args: argsSchema(argsProperties, requiredArgs)
    },
    required: ['version', 'intent', 'args']
  }
}

function actionBranch(
  intent: string,
  argsProperties: Record<string, unknown>,
  requiredArgs: readonly string[]
): Readonly<Record<string, unknown>> {
  return {
    type: 'object', additionalProperties: false,
    properties: {
      intent: { const: intent, type: 'string' },
      args: argsSchema(argsProperties, requiredArgs)
    },
    required: ['intent', 'args']
  }
}

function argsSchema(
  properties: Record<string, unknown>,
  required: readonly string[]
): Readonly<Record<string, unknown>> {
  return {
    type: 'object', additionalProperties: false,
    properties, required: [...required]
  }
}

function IdentifierSchema(): Readonly<Record<string, unknown>> {
  return stringSchema(128)
}

function stringSchema(maxLength: number): Readonly<Record<string, unknown>> {
  return { type: 'string', minLength: 1, maxLength }
}

function finiteNumberSchema(): Readonly<Record<string, unknown>> {
  return { type: 'number' }
}

function numberSchema(minimum: number, maximum: number): Readonly<Record<string, unknown>> {
  return { type: 'number', minimum, maximum }
}

function integerSchema(minimum: number, maximum: number): Readonly<Record<string, unknown>> {
  return { type: 'integer', minimum, maximum }
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toSdkInteractionRequest(request: GeminiInteractionRequest) {
  return {
    model: request.model,
    input: request.input,
    store: request.store,
    stream: false as const,
    system_instruction: request.system_instruction,
    tools: request.tools.map(tool => ({
      type: tool.type,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    })),
    generation_config: {
      thinking_level: request.generation_config.thinking_level,
      thinking_summaries: request.generation_config.thinking_summaries,
      tool_choice: request.generation_config.tool_choice
    }
  }
}

export class GeminiTransport {
  private readonly timeoutMs: number

  constructor(private readonly options: GeminiTransportOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000) {
      throw new RangeError('timeoutMs must be an integer between 1 and 300000')
    }
  }

  prepare(context: DecisionContext): PreparedGeminiPayload {
    const input = JSON.stringify({
      task: 'Choose exactly one safe high-level Minecraft outcome from the available skills.',
      context
    })
    const tool: GeminiFunctionTool = Object.freeze({
      type: 'function',
      name: FUNCTION_NAME,
      description: 'Submit exactly one validated high-level Minecraft outcome. Never include reasoning.',
      parameters: DECISION_OUTCOME_V2_PARAMETER_SCHEMA
    })
    return Object.freeze({
      input,
      systemInstruction: SYSTEM_INSTRUCTION,
      tools: Object.freeze([tool]),
      utf8Bytes: Buffer.byteLength(input, 'utf8')
    })
  }

  async execute(
    prepared: PreparedGeminiPayload,
    lease: AttemptLease,
    signal: AbortSignal
  ): Promise<GeminiAttemptSuccess> {
    const resolveCredential = this.options.resolveCredential
    const createClient = this.options.createClient
    if (!resolveCredential || !createClient) {
      throw new Error('GeminiTransport execution dependencies are not configured')
    }

    const apiKey = resolveCredential(lease.credentialHandle)
    const client = createClient(apiKey)
    const response = await client.create({
      model: normalizeModel(lease.model),
      input: prepared.input,
      store: false,
      stream: false,
      system_instruction: prepared.systemInstruction,
      tools: prepared.tools,
      generation_config: {
        thinking_level: lease.thinking,
        thinking_summaries: 'none',
        tool_choice: 'any'
      }
    }, {
      timeout: this.timeoutMs,
      retryAttempts: 1,
      signal
    })

    const providerResult = extractDecisionFunctionCall(response)
    const usage = normalizeUsage(response.usage)
    return {
      kind: 'success',
      providerResult,
      ...(usage === undefined ? {} : { usage })
    }
  }
}
