import { GoogleGenAI } from '@google/genai'
import { DecisionOutcomeV2Schema } from '../../contracts/decision.js'
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
  | { readonly type: 'thought'; readonly summary?: unknown; readonly signature?: unknown }
  | { readonly type: 'function_call'; readonly id?: string; readonly name?: string; readonly arguments?: unknown }
  | { readonly type: string; readonly [key: string]: unknown }

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
  create(request: GeminiInteractionRequest, options: { readonly timeout: number }): Promise<GeminiInteractionResponse>
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
    options: { readonly timeout: number; readonly retryAttempts: 1; readonly signal: AbortSignal }
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

export type GeminiAttemptResult =
  | GeminiAttemptSuccess
  | { readonly kind: 'generation_error'; readonly code: string; readonly usage?: GeminiUsage }
  | { readonly kind: 'content_blocked'; readonly code: 'content_blocked'; readonly usage?: GeminiUsage }
  | {
      readonly kind: 'api_error'
      readonly httpStatus: number
      readonly providerCode: string | null
      readonly retryAfterMs?: number
    }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'network_error' }
  | { readonly kind: 'cancelled' }

export interface GeminiSdkClientLike {
  readonly interactions: {
    create(
      request: unknown,
      options: {
        readonly timeout?: number
        readonly maxRetries?: number
        readonly signal?: AbortSignal
      }
    ): Promise<unknown>
  }
}

export type GeminiSdkFactory = (apiKey: string) => GeminiSdkClientLike

const PROVIDER_NAME = 'gemini'
const FUNCTION_NAME = 'submit_decision'
const DEFAULT_TIMEOUT_MS = 30_000
const SAFE_PROVIDER_CODES = new Set([
  'authentication',
  'permission_denied',
  'quota_exceeded',
  'rate_limit_exceeded',
  'too_many_requests',
  'aborted',
  'invalid_request',
  'parameter_unknown',
  'model_not_found',
  'content_blocked',
  'malformed_function_call',
  'malformed_tool_call',
  'unexpected_tool_call',
  'too_many_tool_calls',
  'missing_thought_signature'
])

const SYSTEM_INSTRUCTION = [
  'You are the high-level Minecraft decision planner for a deterministic gameplay runtime.',
  'Use the supplied bounded context and safety constraints to choose exactly one high-level action.',
  `You MUST call the ${FUNCTION_NAME} function exactly once.`,
  'Do not emit model text as the answer.',
  'Keep internal reasoning private. Never put reasoning, analysis, thought, or explanations inside function arguments.',
  'The deterministic runtime, not the model, performs movement, digging, inventory operations, and safety enforcement.'
].join(' ')

const ROUTED_SYSTEM_INSTRUCTION = [
  'You are the high-level Minecraft decision planner for a deterministic gameplay runtime.',
  'Choose exactly one outcome by calling exactly one of the provided decision functions exactly once.',
  'Only action functions for currently registered gameplay skills are provided.',
  'Use decision_complete only when the task is already complete.',
  'Use decision_blocked only when no safe registered action can continue the task.',
  'Do not emit model text as the answer.',
  'Keep internal reasoning private. Never put reasoning, analysis, thought, or explanations inside function arguments.',
  'The deterministic runtime, not the model, performs movement, digging, inventory operations, and safety enforcement.'
].join(' ')

const DECISION_PARAMETER_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  oneOf: [
    decisionBranch('follow_player', { player: stringSchema(64), range: numberSchema(1, 16) }, ['player']),
    decisionBranch('stay', {}, []),
    decisionBranch('go_to', {
      x: finiteNumberSchema(), y: finiteNumberSchema(), z: finiteNumberSchema(), radius: numberSchema(0, 16)
    }, ['x', 'y', 'z']),
    decisionBranch('return_home', {}, []),
    decisionBranch('eat', {}, []),
    decisionBranch('equip', {
      item: stringSchema(128),
      destination: { type: 'string', enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'] }
    }, ['item']),
    decisionBranch('gather_resource', { resource: stringSchema(128), quantity: integerSchema(1, 2304) }, ['resource', 'quantity']),
    decisionBranch('acquire_resource', {
      resource: stringSchema(128),
      quantity: integerSchema(1, 2304),
      exploreRadius: integerSchema(4, 64),
      exploreSteps: integerSchema(1, 16),
      excavateLength: integerSchema(1, 16)
    }, ['resource', 'quantity']),
    decisionBranch('deposit_item', { item: stringSchema(128), quantity: integerSchema(1, 2304), storage: identifierSchema() }, ['item', 'quantity', 'storage']),
    decisionBranch('withdraw_item', { item: stringSchema(128), quantity: integerSchema(1, 2304), storage: identifierSchema() }, ['item', 'quantity', 'storage'])
  ]
})

interface RoutedActionToolDefinition {
  readonly skillName: DecisionContext['skills'][number]['name']
  readonly intent:
    | 'follow_player'
    | 'stay'
    | 'go_to'
    | 'return_home'
    | 'eat'
    | 'equip'
    | 'gather_resource'
    | 'acquire_resource'
    | 'deposit_item'
    | 'withdraw_item'
  readonly tool: GeminiFunctionTool
}

const ROUTED_ACTION_TOOL_DEFINITIONS: readonly RoutedActionToolDefinition[] = Object.freeze([
  routedActionTool(
    'follow_player',
    'action_follow_player',
    'Follow one named nearby player at an optional bounded range.',
    { player: stringSchema(64), range: numberSchema(1, 16) },
    ['player']
  ),
  routedActionTool(
    'stay',
    'action_stay',
    'Hold the current position until safely superseded.',
    {},
    []
  ),
  routedActionTool(
    'go_to',
    'action_go_to',
    'Navigate to one bounded coordinate target without generic digging.',
    { x: finiteNumberSchema(), y: finiteNumberSchema(), z: finiteNumberSchema(), radius: numberSchema(0, 16) },
    ['x', 'y', 'z']
  ),
  routedActionTool(
    'return_home',
    'action_return_home',
    'Return to the configured home location.',
    {},
    []
  ),
  routedActionTool(
    'eat',
    'action_eat',
    'Eat one approved ordinary food item.',
    {},
    []
  ),
  routedActionTool(
    'equip',
    'action_equip',
    'Equip one exact inventory item to an approved destination.',
    {
      item: stringSchema(128),
      destination: { type: 'string', enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'] }
    },
    ['item']
  ),
  routedActionTool(
    'gather_resource',
    'action_gather_resource',
    'Gather an exact bounded quantity of one resource.',
    { resource: stringSchema(128), quantity: integerSchema(1, 2304) },
    ['resource', 'quantity']
  ),
  routedActionTool(
    'acquire_resource',
    'action_acquire_resource',
    'Acquire at least a bounded quantity of one resource through deterministic search, memory, exploration, excavation, and gathering.',
    {
      resource: stringSchema(128),
      quantity: integerSchema(1, 2304),
      exploreRadius: integerSchema(4, 64),
      exploreSteps: integerSchema(1, 16),
      excavateLength: integerSchema(1, 16)
    },
    ['resource', 'quantity']
  ),
  routedActionTool(
    'deposit_item',
    'action_deposit_item',
    'Deposit an exact bounded quantity into one named storage target.',
    { item: stringSchema(128), quantity: integerSchema(1, 2304), storage: identifierSchema() },
    ['item', 'quantity', 'storage']
  ),
  routedActionTool(
    'withdraw_item',
    'action_withdraw_item',
    'Withdraw an exact bounded quantity from one named storage target.',
    { item: stringSchema(128), quantity: integerSchema(1, 2304), storage: identifierSchema() },
    ['item', 'quantity', 'storage']
  )
])

const ROUTED_COMPLETE_TOOL = functionTool(
  'decision_complete',
  'Report that the current task is already complete and requires no further gameplay action.',
  {},
  []
)

const ROUTED_BLOCKED_TOOL = functionTool(
  'decision_blocked',
  'Report that no safe registered action can currently continue the task.',
  {
    reason: {
      type: 'string',
      enum: ['no_safe_action', 'missing_information', 'capability_unavailable']
    }
  },
  ['reason']
)

const ROUTED_TOOL_TO_INTENT = new Map(
  ROUTED_ACTION_TOOL_DEFINITIONS.map(definition => [definition.tool.name, definition.intent] as const)
)

export class GeminiDecisionProvider implements DecisionProvider<DecisionContext> {
  readonly capabilities = SAFE_GAMEPLAY_PROVIDER_CAPABILITIES
  private readonly timeoutMs: number
  private readonly thinkingLevel: GeminiThinkingLevel
  private readonly model: string

  constructor(private readonly options: GeminiDecisionProviderOptions) {
    this.model = normalizeModel(options.model)
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    validateTimeout(this.timeoutMs)
    this.thinkingLevel = options.thinkingLevel ?? 'high'
  }

  async decide(request: DecisionRequest<DecisionContext>): Promise<ProviderResult> {
    const interactionRequest = buildInteractionRequest(this.model, this.thinkingLevel, request.context)
    let response: GeminiInteractionResponse
    try {
      response = await this.options.interactions.create(interactionRequest, { timeout: this.timeoutMs })
    } catch (error) {
      if (isTimeoutError(error)) return { kind: 'timeout', provider: PROVIDER_NAME }
      return { kind: 'invalid', provider: PROVIDER_NAME, code: 'provider_request_failed' }
    }
    return extractDecisionFunctionCall(response)
  }
}

export function createGeminiDecisionProvider(options: CreateGeminiDecisionProviderOptions): GeminiDecisionProvider {
  const apiKey = options.apiKey.trim()
  if (!apiKey) throw new TypeError('Gemini apiKey must be a non-empty string')
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

export function createGeminiAttemptClient(
  apiKey: string,
  createSdk: GeminiSdkFactory = key => new GoogleGenAI({ apiKey: key }) as unknown as GeminiSdkClientLike
): GeminiAttemptClient {
  const normalizedKey = apiKey.trim()
  if (!normalizedKey) throw new TypeError('Gemini apiKey must be a non-empty string')
  const sdk = createSdk(normalizedKey)
  return {
    async create(request, options) {
      const interaction = await sdk.interactions.create(toSdkInteractionRequest(request), {
        timeout: options.timeout,
        maxRetries: options.retryAttempts - 1,
        signal: options.signal
      })
      return normalizeSdkInteraction(interaction)
    }
  }
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
  if (response.status !== 'requires_action') return invalid('interaction_status_invalid')
  if (!Array.isArray(response.steps)) return invalid('response_steps_missing')

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
  if (call.arguments === undefined || call.arguments === null) return invalid('function_arguments_missing')
  if (!isRecord(call.arguments)) return invalid('function_arguments_invalid')

  let value: unknown
  try {
    value = structuredClone(call.arguments)
  } catch {
    return invalid('function_arguments_invalid')
  }
  return { kind: 'structured', provider: PROVIDER_NAME, mode: 'function_call', value }
}

function extractRoutedDecisionFunctionCall(
  response: GeminiInteractionResponse,
  advertisedTools: readonly GeminiFunctionTool[]
): ProviderResult {
  if (response.status !== 'requires_action') return invalid('interaction_status_invalid')
  if (!Array.isArray(response.steps)) return invalid('response_steps_missing')

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
  if (!call || typeof call.name !== 'string') return invalid('unexpected_function_call')
  const advertised = new Set(advertisedTools.map(tool => tool.name))
  if (!advertised.has(call.name)) return invalid('unexpected_function_call')
  if (call.arguments === undefined || call.arguments === null) return invalid('function_arguments_missing')
  if (!isRecord(call.arguments)) return invalid('function_arguments_invalid')

  let args: Record<string, unknown>
  try {
    args = structuredClone(call.arguments)
  } catch {
    return invalid('function_arguments_invalid')
  }

  let candidate: unknown
  if (call.name === ROUTED_COMPLETE_TOOL.name) {
    candidate = { ...args, version: 2, outcome: 'complete' }
  } else if (call.name === ROUTED_BLOCKED_TOOL.name) {
    candidate = { ...args, version: 2, outcome: 'blocked' }
  } else {
    const intent = ROUTED_TOOL_TO_INTENT.get(call.name)
    if (!intent) return invalid('unexpected_function_call')
    candidate = {
      version: 2,
      outcome: 'action',
      action: { intent, args }
    }
  }

  const parsed = DecisionOutcomeV2Schema.safeParse(candidate)
  if (!parsed.success) return invalid('decision_schema_invalid')
  return {
    kind: 'structured',
    provider: PROVIDER_NAME,
    mode: 'function_call',
    value: parsed.data
  }
}

function routedToolsForContext(context: DecisionContext): readonly GeminiFunctionTool[] {
  const registered = new Set(context.skills.map(skill => skill.name))
  return Object.freeze([
    ...ROUTED_ACTION_TOOL_DEFINITIONS
      .filter(definition => registered.has(definition.skillName))
      .map(definition => definition.tool),
    ROUTED_COMPLETE_TOOL,
    ROUTED_BLOCKED_TOOL
  ])
}

function routedActionTool(
  skillName: RoutedActionToolDefinition['skillName'],
  toolName: string,
  description: string,
  properties: Record<string, unknown>,
  required: readonly string[]
): RoutedActionToolDefinition {
  return Object.freeze({
    skillName,
    intent: skillName as RoutedActionToolDefinition['intent'],
    tool: functionTool(toolName, description, properties, required)
  })
}

function functionTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: readonly string[]
): GeminiFunctionTool {
  const parameters = Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: Object.freeze({ ...properties }),
    ...(required.length > 0 ? { required: Object.freeze([...required]) } : {})
  })
  return Object.freeze({
    type: 'function',
    name,
    description,
    parameters
  })
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
    status: typeof candidate.status === 'string'
      ? candidate.status
      : 'invalid_sdk_response',
    ...(Array.isArray(candidate.steps)
      ? { steps: candidate.steps.map(normalizeSdkStep) }
      : {}),
    ...(isRecord(candidate.usage)
      ? { usage: normalizeSdkUsage(candidate.usage) }
      : {})
  }
}

function normalizeSdkUsage(usage: Record<string, unknown>): GeminiInteractionUsage {
  const input = nonNegativeInteger(usage.total_input_tokens)
  const output = nonNegativeInteger(usage.total_output_tokens)
  const thought = nonNegativeInteger(usage.total_thought_tokens)
  const tool = nonNegativeInteger(usage.total_tool_use_tokens)
  const total = nonNegativeInteger(usage.total_tokens)
  return {
    ...(input === undefined ? {} : { total_input_tokens: input }),
    ...(output === undefined ? {} : { total_output_tokens: output }),
    ...(thought === undefined ? {} : { total_thought_tokens: thought }),
    ...(tool === undefined ? {} : { total_tool_use_tokens: tool }),
    ...(total === undefined ? {} : { total_tokens: total })
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
    inputTokens === undefined ||
    outputTokens === undefined ||
    thoughtTokens === undefined ||
    toolTokens === undefined ||
    totalTokens === undefined
  ) {
    return undefined
  }
  return { inputTokens, outputTokens, thoughtTokens, toolTokens, totalTokens }
}

function normalizeTransportError(error: unknown, signal: AbortSignal): GeminiAttemptResult {
  if (signal.aborted || isCancellationError(error)) return { kind: 'cancelled' }
  if (isTransportTimeout(error)) return { kind: 'timeout' }

  const httpStatus = extractHttpStatus(error)
  const providerCode = extractSafeProviderCode(error)
  if (providerCode === 'content_blocked') {
    return { kind: 'content_blocked', code: 'content_blocked' }
  }
  if (httpStatus !== null) {
    const retryAfterMs = extractRetryAfterMs(error)
    return {
      kind: 'api_error',
      httpStatus,
      providerCode,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs })
    }
  }
  return { kind: 'network_error' }
}

function extractHttpStatus(error: unknown): number | null {
  if (!isRecord(error)) return null
  const status = integerInRange(error.status, 100, 599)
    ?? integerInRange(error.statusCode, 100, 599)
  return status ?? null
}

function extractSafeProviderCode(error: unknown): string | null {
  if (!isRecord(error)) return null
  const nested = isRecord(error.error) ? error.error : null
  const nestedNested = nested && isRecord(nested.error) ? nested.error : null
  for (const value of [error.providerCode, error.code, nested?.code, nestedNested?.code]) {
    if (typeof value !== 'string') continue
    const normalized = value.trim().toLowerCase()
    if (SAFE_PROVIDER_CODES.has(normalized)) return normalized
  }
  return null
}

function extractRetryAfterMs(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined
  const headers = error.headers
  if (!headers || typeof (headers as { get?: unknown }).get !== 'function') {
    return undefined
  }
  const raw = (headers as { get(name: string): string | null })
    .get('retry-after')
    ?.trim()
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
  const deadline = Date.parse(raw)
  return Number.isFinite(deadline)
    ? Math.max(0, deadline - Date.now())
    : undefined
}

function invalid(code: string): ProviderResult {
  return { kind: 'invalid', provider: PROVIDER_NAME, code }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'RequestTimeoutError')
}

function isTransportTimeout(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'TimeoutError' ||
    error.name === 'RequestTimeoutError' ||
    error.name === 'APIConnectionTimeoutError'
  )
}

function isCancellationError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'AbortError' ||
    error.name === 'APIUserAbortError' ||
    error.name === 'RequestAbortedError'
  )
}

function validateTimeout(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 300_000) {
    throw new RangeError('timeoutMs must be an integer between 1 and 300000')
  }
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
    type: 'object',
    additionalProperties: false,
    properties: {
      version: { const: 1, type: 'integer' },
      intent: { const: intent, type: 'string' },
      args: argsSchema(argsProperties, requiredArgs)
    },
    required: ['version', 'intent', 'args']
  }
}

function argsSchema(
  properties: Record<string, unknown>,
  required: readonly string[]
): Readonly<Record<string, unknown>> {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required: [...required]
  }
}

function identifierSchema(): Readonly<Record<string, unknown>> {
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

function integerInRange(
  value: unknown,
  minimum: number,
  maximum: number
): number | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined
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
  private readonly clients = new Map<string, GeminiAttemptClient>()

  constructor(private readonly options: GeminiTransportOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    validateTimeout(this.timeoutMs)
  }

  prepare(context: DecisionContext): PreparedGeminiPayload {
    const input = JSON.stringify({
      task: 'Choose exactly one safe high-level Minecraft outcome from the available skills.',
      context
    })
    const tools = routedToolsForContext(context)
    return Object.freeze({
      input,
      systemInstruction: ROUTED_SYSTEM_INSTRUCTION,
      tools,
      utf8Bytes: Buffer.byteLength(input, 'utf8')
    })
  }

  async execute(
    prepared: PreparedGeminiPayload,
    lease: AttemptLease,
    signal: AbortSignal
  ): Promise<GeminiAttemptResult> {
    const client = this.clientFor(lease.credentialHandle)
    let response: GeminiInteractionResponse
    try {
      response = await client.create({
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
    } catch (error) {
      return normalizeTransportError(error, signal)
    }

    const providerResult = extractRoutedDecisionFunctionCall(response, prepared.tools)
    const usage = normalizeUsage(response.usage)
    if (providerResult.kind !== 'structured') {
      const code = providerResult.kind === 'invalid'
        ? providerResult.code
        : 'unexpected_provider_result'
      return {
        kind: 'generation_error',
        code,
        ...(usage === undefined ? {} : { usage })
      }
    }
    return {
      kind: 'success',
      providerResult,
      ...(usage === undefined ? {} : { usage })
    }
  }

  private clientFor(credentialHandle: string): GeminiAttemptClient {
    const cached = this.clients.get(credentialHandle)
    if (cached) return cached
    const resolveCredential = this.options.resolveCredential
    if (!resolveCredential) {
      throw new Error('GeminiTransport credential resolver is not configured')
    }
    const createClient = this.options.createClient ?? createGeminiAttemptClient
    const client = createClient(resolveCredential(credentialHandle))
    this.clients.set(credentialHandle, client)
    return client
  }
}
