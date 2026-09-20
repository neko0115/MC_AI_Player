import { randomUUID } from 'node:crypto'
import type {
  AttemptLease,
  RoutePlan
} from '../agent/routing/contracts.js'
import {
  classifyAttemptResult,
  type AttemptPolicy
} from '../agent/routing/error-policy.js'
import type {
  ProjectPoolLeaseResult
} from '../agent/routing/project-pool.js'
import type {
  AttemptSettlement
} from '../agent/routing/quota-ledger.js'
import type {
  RoutedExecutorLedgerPort,
  RoutedExecutorTelemetryPort
} from '../agent/routing/routed-executor.js'
import {
  createGeminiAttemptClient,
  normalizeModel,
  normalizeTransportError,
  normalizeUsage,
  type GeminiAttemptClient,
  type GeminiAttemptResult,
  type GeminiFunctionTool,
  type GeminiInteractionResponse,
  type GeminiTransportOptions,
  type PreparedGeminiPayload
} from '../agent/providers/gemini.js'
import {
  WorkspaceChatIntentSchema,
  normalizeWorkspaceSemanticContext,
  type WorkspaceChatIntent,
  type WorkspaceIntentInterpreter,
  type WorkspaceSemanticContext
} from './chat-intent.js'

const FUNCTION_NAME =
  'submit_workspace_intent'
const PROVIDER_NAME = 'gemini'
const DEFAULT_TIMEOUT_MS = 30_000

const SYSTEM_INSTRUCTION = [
  'You interpret natural-language Minecraft Workspace management intent for a deterministic runtime.',
  'Interpret semantic meaning rather than matching a fixed phrase list; users may use slang, shorthand, paraphrases, multiple languages, or imperfect grammar.',
  'A Workspace is persistent region metadata such as a farm, storage area, production area, protected area, or a named region.',
  'Do not treat general gameplay actions inside a region, such as mining, building, following, fighting, or lighting execution, as Workspace metadata unless the user is explicitly defining or managing the persistent region itself.',
  'Use owner_only when the user semantically reserves the region for themselves or tells Moxue not to use its resources.',
  'Use shared for ordinary regions Moxue may use subject to deterministic authorization and SafetyPolicy.',
  'Use moxue_preferred when the user semantically gives or prioritizes the region for Moxue. This does not mean other humans are forbidden.',
  'Use create only for defining the current trusted selection as a Workspace. If a Workspace definition clearly refers to the current area but no trusted selection is available, return clarify with missing_selection.',
  'Use clarify instead of guessing when Workspace semantics or the referenced Workspace are genuinely ambiguous.',
  'Use not_workspace when the addressed utterance is not Workspace metadata/management.',
  'Never invent coordinates, world mutation, permissions, storage access, or physical purge authority.',
  `You MUST call ${FUNCTION_NAME} exactly once.`,
  'Do not emit model text. Keep reasoning private and never include reasoning or explanations in function arguments.'
].join(' ')

const TARGET_REFERENCE_SCHEMA =
  Object.freeze({
    oneOf: [
      strictObject(
        {
          kind: constString('explicit'),
          value: stringSchema(128)
        },
        ['kind', 'value']
      ),
      strictObject(
        { kind: constString('current_selection') },
        ['kind']
      ),
      strictObject(
        { kind: constString('conversation') },
        ['kind']
      ),
      strictObject(
        { kind: constString('nearby') },
        ['kind']
      ),
      strictObject(
        { kind: constString('recent') },
        ['kind']
      )
    ]
  })

const CONSTRAINTS_SCHEMA =
  strictObject(
    {
      preserveExistingStructures:
        { type: 'boolean' },
      temporaryInfrastructureAllowed:
        { type: 'boolean' },
      protected:
        { type: 'boolean' },
      requestedSpacing:
        integerSchema(1, 64),
      lighting:
        strictObject(
          {
            blockLightMin:
              integerSchema(0, 15),
            spawnSafeRequired:
              { type: 'boolean' }
          },
          [
            'blockLightMin',
            'spawnSafeRequired'
          ]
        )
    },
    []
  )

const PURPOSE_SCHEMA = {
  type: 'string',
  enum: [
    'production',
    'farm',
    'storage',
    'construction',
    'lighting',
    'protected',
    'transit',
    'custom'
  ]
}

const USE_POLICY_SCHEMA = {
  type: 'string',
  enum: [
    'owner_only',
    'shared',
    'moxue_preferred'
  ]
}

const TAGS_SCHEMA = {
  type: 'array',
  maxItems: 32,
  items: stringSchema(64)
}

const TOOL: GeminiFunctionTool =
  Object.freeze({
    type: 'function',
    name: FUNCTION_NAME,
    description:
      'Submit exactly one validated Workspace semantic intent. Never include reasoning.',
    parameters: Object.freeze({
      oneOf: [
        intentBranch(
          'not_workspace',
          {},
          []
        ),
        intentBranch(
          'clarify',
          {
            reason: {
              type: 'string',
              enum: [
                'ambiguous_intent',
                'ambiguous_reference',
                'missing_reference',
                'missing_selection',
                'missing_semantics'
              ]
            }
          },
          ['reason']
        ),
        intentBranch(
          'create',
          {
            label: stringSchema(128),
            purpose: PURPOSE_SCHEMA,
            moxueUsePolicy:
              USE_POLICY_SCHEMA,
            tags: TAGS_SCHEMA,
            constraints:
              CONSTRAINTS_SCHEMA
          },
          [
            'label',
            'purpose',
            'moxueUsePolicy'
          ]
        ),
        intentBranch(
          'rename',
          {
            target:
              TARGET_REFERENCE_SCHEMA,
            label: stringSchema(128)
          },
          ['target', 'label']
        ),
        intentBranch(
          'resize',
          {
            target:
              TARGET_REFERENCE_SCHEMA
          },
          ['target']
        ),
        intentBranch(
          'change_purpose',
          {
            target:
              TARGET_REFERENCE_SCHEMA,
            purpose:
              PURPOSE_SCHEMA
          },
          ['target', 'purpose']
        ),
        intentBranch(
          'change_use_policy',
          {
            target:
              TARGET_REFERENCE_SCHEMA,
            moxueUsePolicy:
              USE_POLICY_SCHEMA
          },
          [
            'target',
            'moxueUsePolicy'
          ]
        ),
        intentBranch(
          'replace_tags',
          {
            target:
              TARGET_REFERENCE_SCHEMA,
            tags: TAGS_SCHEMA
          },
          ['target', 'tags']
        ),
        intentBranch(
          'change_constraints',
          {
            target:
              TARGET_REFERENCE_SCHEMA,
            constraints:
              CONSTRAINTS_SCHEMA
          },
          ['target', 'constraints']
        ),
        intentBranch(
          'archive',
          {
            target:
              TARGET_REFERENCE_SCHEMA
          },
          ['target']
        ),
        intentBranch(
          'restore',
          {
            target:
              TARGET_REFERENCE_SCHEMA
          },
          ['target']
        ),
        intentBranch(
          'list',
          {
            includeArchived:
              { type: 'boolean' }
          },
          []
        ),
        intentBranch(
          'show',
          {
            target:
              TARGET_REFERENCE_SCHEMA
          },
          ['target']
        )
      ]
    })
  })

export interface WorkspaceIntentPoolPort {
  configuredProjectCount(): number
  nextLease(
    plan: RoutePlan,
    prepared: {
      readonly utf8Bytes: number
    }
  ): ProjectPoolLeaseResult
}

export interface WorkspaceIntentTransportPort {
  prepare(
    context: WorkspaceSemanticContext
  ): PreparedGeminiPayload
  execute(
    prepared: PreparedGeminiPayload,
    lease: AttemptLease,
    signal: AbortSignal
  ): Promise<GeminiAttemptResult>
}

export interface RoutedGeminiWorkspaceIntentInterpreterOptions {
  readonly pool: WorkspaceIntentPoolPort
  readonly ledger: RoutedExecutorLedgerPort
  readonly transport:
    WorkspaceIntentTransportPort
  readonly processInstanceId: string
  readonly events?:
    RoutedExecutorTelemetryPort
  readonly now?: () => number
  readonly nextDecisionId?: () => string
}

export class WorkspaceSemanticProviderError
extends Error {
  constructor(
    readonly code: string
  ) {
    super(code)
  }
}

export class RoutedGeminiWorkspaceIntentInterpreter
implements WorkspaceIntentInterpreter {
  private readonly now: () => number
  private readonly nextDecisionId:
    () => string

  constructor(
    private readonly options:
      RoutedGeminiWorkspaceIntentInterpreterOptions
  ) {
    if (
      !options.processInstanceId.trim()
    ) {
      throw new TypeError(
        'processInstanceId must be non-empty'
      )
    }
    this.now = options.now ?? Date.now
    this.nextDecisionId =
      options.nextDecisionId ??
      randomUUID
  }

  async interpret(
    context: WorkspaceSemanticContext,
    signal: AbortSignal
  ): Promise<WorkspaceChatIntent> {
    const normalized =
      normalizeWorkspaceSemanticContext(
        context
      )
    const prepared =
      this.options.transport.prepare(
        normalized
      )
    const routePlan =
      semanticRoutePlan(
        this.nextDecisionId()
      )
    const maxAttempts =
      this.options.pool
        .configuredProjectCount() + 4
    let generationRepairUsed = false

    for (
      let attempts = 0;
      attempts < maxAttempts;
      attempts += 1
    ) {
      if (signal.aborted) {
        throw new WorkspaceSemanticProviderError(
          'workspace_semantic_cancelled'
        )
      }

      const leaseResult =
        this.options.pool.nextLease(
          routePlan,
          prepared
        )
      if (
        leaseResult.kind ===
        'unavailable'
      ) {
        throw new WorkspaceSemanticProviderError(
          'workspace_semantic_unavailable'
        )
      }

      const lease =
        leaseResult.lease
      const dispatchedAt =
        this.now()
      this.options.ledger
        .markDispatched(
          lease.reservationId,
          dispatchedAt
        )

      await this.publishTelemetry({
        type: 'model_route',
        at: dispatchedAt,
        decisionId:
          routePlan.decisionId,
        model: lease.model,
        thinking:
          lease.thinking,
        project:
          lease.projectLabel,
        reasons:
          [...routePlan.reasons],
        reserveAuthorized:
          routePlan.reserveAuthorized,
        reserveUsed:
          lease.budgetClass ===
            'reserve'
      })

      const attempt =
        await this.options.transport
          .execute(
            prepared,
            lease,
            signal
          )
      const policyAt =
        this.now()
      const policy =
        classifyAttemptResult(
          attempt,
          policyAt
        )

      this.options.ledger
        .settleAttempt(
          lease.reservationId,
          settlementFor(
            attempt,
            policy,
            policyAt
          )
        )

      await this.publishTelemetry({
        type: 'attempt_result',
        at: policyAt,
        decisionId:
          routePlan.decisionId,
        model: lease.model,
        project:
          lease.projectLabel,
        result: policy.kind,
        ...('safeCode' in policy
          ? {
              safeCode:
                policy.safeCode
            }
          : {})
      })

      switch (policy.kind) {
        case 'success': {
          this.options.ledger
            .recordDomainSuccess(
              lease.projectKey,
              lease.model
            )
          if (
            attempt.kind !==
            'success' ||
            attempt.providerResult.kind !==
            'structured'
          ) {
            throw new Error(
              'workspace semantic success requires structured provider result'
            )
          }

          const parsed =
            WorkspaceChatIntentSchema
              .safeParse(
                attempt.providerResult
                  .value
              )
          if (!parsed.success) {
            throw new WorkspaceSemanticProviderError(
              'workspace_intent_schema_invalid'
            )
          }
          return parsed.data
        }

        case 'credential_fatal':
          this.options.ledger
            .disableCredentialForProcess(
              lease.projectKey,
              this.options.processInstanceId,
              policy.safeCode,
              this.now()
            )
          break

        case 'quota_unavailable':
          this.options.ledger
            .markQuotaUnavailable(
              lease.projectKey,
              lease.model,
              policy.retryAt,
              policy.safeCode
            )
          break

        case 'transient':
          this.options.ledger
            .recordTransientFailure(
              lease.projectKey,
              lease.model,
              this.now(),
              policy.retryAfterMs
            )
          break

        case 'generation_retry':
          if (generationRepairUsed) {
            throw new WorkspaceSemanticProviderError(
              policy.safeCode
            )
          }
          generationRepairUsed = true
          break

        case 'safety_terminal':
        case 'configuration_error':
          throw new WorkspaceSemanticProviderError(
            policy.safeCode
          )

        case 'cancelled':
          throw new WorkspaceSemanticProviderError(
            'workspace_semantic_cancelled'
          )
      }
    }

    throw new WorkspaceSemanticProviderError(
      'workspace_semantic_unavailable'
    )
  }

  private async publishTelemetry(
    event:
      Parameters<
        NonNullable<
          RoutedExecutorTelemetryPort[
            'publish'
          ]
        >
      >[0]
  ): Promise<void> {
    try {
      await this.options.events
        ?.publish(event)
    } catch {
      // Telemetry must not change semantic
      // routing/failover behavior.
    }
  }
}

export class GeminiWorkspaceIntentTransport
implements WorkspaceIntentTransportPort {
  private readonly timeoutMs: number
  private readonly clients =
    new Map<
      string,
      GeminiAttemptClient
    >()

  constructor(
    private readonly options:
      GeminiTransportOptions = {}
  ) {
    this.timeoutMs =
      options.timeoutMs ??
      DEFAULT_TIMEOUT_MS
    if (
      !Number.isInteger(
        this.timeoutMs
      ) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 300_000
    ) {
      throw new RangeError(
        'timeoutMs must be an integer between 1 and 300000'
      )
    }
  }

  prepare(
    context: WorkspaceSemanticContext
  ): PreparedGeminiPayload {
    const normalized =
      normalizeWorkspaceSemanticContext(
        context
      )
    const input =
      JSON.stringify({
        task:
          'Interpret the addressed Minecraft utterance as exactly one bounded Workspace semantic intent.',
        context: normalized
      })

    return Object.freeze({
      input,
      systemInstruction:
        SYSTEM_INSTRUCTION,
      tools:
        Object.freeze([TOOL]),
      utf8Bytes:
        Buffer.byteLength(
          input,
          'utf8'
        )
    })
  }

  async execute(
    prepared: PreparedGeminiPayload,
    lease: AttemptLease,
    signal: AbortSignal
  ): Promise<GeminiAttemptResult> {
    const client =
      this.clientFor(
        lease.credentialHandle
      )

    let response:
      GeminiInteractionResponse
    try {
      response =
        await client.create(
          {
            model:
              normalizeModel(
                lease.model
              ),
            input:
              prepared.input,
            store: false,
            stream: false,
            system_instruction:
              prepared.systemInstruction,
            tools:
              prepared.tools,
            generation_config: {
              thinking_level:
                lease.thinking,
              thinking_summaries:
                'none',
              tool_choice: 'any'
            }
          },
          {
            timeout:
              this.timeoutMs,
            retryAttempts: 1,
            signal
          }
        )
    } catch (error) {
      return normalizeTransportError(
        error,
        signal
      )
    }

    const usage =
      normalizeUsage(
        response.usage
      )
    const extracted =
      extractIntentCall(response)

    if (
      extracted.kind !==
      'success'
    ) {
      return {
        kind: 'generation_error',
        code: extracted.code,
        ...(usage === undefined
          ? {}
          : { usage })
      }
    }

    return {
      kind: 'success',
      providerResult: {
        kind: 'structured',
        provider: PROVIDER_NAME,
        mode: 'function_call',
        value: extracted.intent
      },
      ...(usage === undefined
        ? {}
        : { usage })
    }
  }

  private clientFor(
    credentialHandle: string
  ): GeminiAttemptClient {
    const cached =
      this.clients.get(
        credentialHandle
      )
    if (cached) return cached

    const resolveCredential =
      this.options
        .resolveCredential
    if (!resolveCredential) {
      throw new Error(
        'GeminiWorkspaceIntentTransport credential resolver is not configured'
      )
    }

    const createClient =
      this.options.createClient ??
      createGeminiAttemptClient
    const client =
      createClient(
        resolveCredential(
          credentialHandle
        )
      )
    this.clients.set(
      credentialHandle,
      client
    )
    return client
  }
}

function semanticRoutePlan(
  decisionId: string
): RoutePlan {
  const normalized =
    decisionId.trim()
  if (
    normalized.length < 1 ||
    normalized.length > 128
  ) {
    throw new RangeError(
      'workspace semantic decision id must be 1..128 characters'
    )
  }

  return Object.freeze({
    decisionId: normalized,
    policy: 'balanced-v1',
    routeClass: 'routine',
    thinking: 'low',
    reserveAuthorized: false,
    reasons:
      Object.freeze([
        'workspace_semantic_interpretation'
      ]),
    highReason: null
  })
}

function extractIntentCall(
  response: GeminiInteractionResponse
):
  | {
      readonly kind: 'success'
      readonly intent:
        WorkspaceChatIntent
    }
  | {
      readonly kind: 'invalid'
      readonly code: string
    } {
  if (
    response.status !==
    'requires_action'
  ) {
    return invalid(
      'interaction_status_invalid'
    )
  }
  if (
    !Array.isArray(
      response.steps
    )
  ) {
    return invalid(
      'response_steps_missing'
    )
  }

  const calls = []
  for (const step of response.steps) {
    if (
      !step ||
      typeof step !== 'object' ||
      typeof step.type !== 'string'
    ) {
      return invalid(
        'unexpected_provider_step'
      )
    }
    if (step.type === 'thought') {
      continue
    }
    if (
      step.type !==
      'function_call'
    ) {
      return invalid(
        'unexpected_provider_step'
      )
    }
    calls.push(step)
  }

  if (calls.length === 0) {
    return invalid(
      'function_call_missing'
    )
  }
  if (calls.length !== 1) {
    return invalid(
      'function_call_count_invalid'
    )
  }

  const call = calls[0]
  if (
    !call ||
    call.name !== FUNCTION_NAME
  ) {
    return invalid(
      'unexpected_function_call'
    )
  }

  if (
    !isRecord(
      call.arguments
    )
  ) {
    return invalid(
      'function_arguments_invalid'
    )
  }

  const parsed =
    WorkspaceChatIntentSchema
      .safeParse(
        call.arguments
      )
  if (!parsed.success) {
    return invalid(
      'workspace_intent_schema_invalid'
    )
  }

  return {
    kind: 'success',
    intent: parsed.data
  }
}

function settlementFor(
  attempt: GeminiAttemptResult,
  policy: AttemptPolicy,
  now: number
): AttemptSettlement {
  const usage =
    'usage' in attempt
      ? attempt.usage
      : undefined
  const safeErrorCode =
    'safeCode' in policy
      ? policy.safeCode
      : undefined

  return {
    now,
    resultClass:
      policy.kind,
    ...(safeErrorCode === undefined
      ? {}
      : {
          safeErrorCode
        }),
    ...(usage === undefined
      ? {
          missingUsagePolicy:
            missingUsagePolicy(
              attempt
            )
        }
      : { usage })
  }
}

function missingUsagePolicy(
  attempt: GeminiAttemptResult
): 'rejected' | 'unknown' {
  if (
    attempt.kind === 'api_error' &&
    attempt.httpStatus >= 400 &&
    attempt.httpStatus < 500 &&
    attempt.httpStatus !== 408 &&
    !(
      attempt.httpStatus === 409 &&
      attempt.providerCode ===
        'aborted'
    )
  ) {
    return 'rejected'
  }
  return 'unknown'
}

function intentBranch(
  kind: WorkspaceChatIntent['kind'],
  properties:
    Record<string, unknown>,
  required:
    readonly string[]
): Readonly<Record<string, unknown>> {
  return strictObject(
    {
      kind: constString(kind),
      ...properties
    },
    ['kind', ...required]
  )
}

function strictObject(
  properties:
    Record<string, unknown>,
  required:
    readonly string[]
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties:
      Object.freeze({
        ...properties
      }),
    ...(required.length > 0
      ? {
          required:
            Object.freeze(
              [...required]
            )
        }
      : {})
  })
}

function constString(
  value: string
): Readonly<Record<string, unknown>> {
  return {
    type: 'string',
    const: value
  }
}

function stringSchema(
  maxLength: number
): Readonly<Record<string, unknown>> {
  return {
    type: 'string',
    minLength: 1,
    maxLength
  }
}

function integerSchema(
  minimum: number,
  maximum: number
): Readonly<Record<string, unknown>> {
  return {
    type: 'integer',
    minimum,
    maximum
  }
}

function invalid(
  code: string
): {
  readonly kind: 'invalid'
  readonly code: string
} {
  return {
    kind: 'invalid',
    code
  }
}

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}
