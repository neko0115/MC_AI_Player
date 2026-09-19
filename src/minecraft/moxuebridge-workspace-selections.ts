import { z } from 'zod'
import type { MoxueBridgeConfig } from '../config.js'
import {
  WorkspaceSelectionTracker,
  type WorkspaceSelectionSource,
  type WorkspaceSelectionSourceStatus
} from '../workspace/selection-source.js'
import type {
  WorkspaceSelection,
  WorkspaceSelectionQuery
} from '../workspace/contracts.js'

const WirePointSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int()
})

const WireSelectionSchema = z.object({
  id: z.string().trim().min(1).max(128),
  generation: z.number().int().nonnegative(),
  dimension: z.string().trim().min(1).max(128),
  player_id: z.string().trim().min(1).max(128),
  player_name: z.string().trim().min(1).max(64),
  point_a: WirePointSchema,
  point_b: WirePointSchema,
  selected_at: z.number().int().nonnegative()
})

const WireSnapshotSchema = z.object({
  version: z.literal(1),
  generated_at: z.number().int().nonnegative(),
  selections: z.array(WireSelectionSchema).max(256)
})

type FetchLike = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>

export interface MoxueBridgeWorkspaceSelectionsOptions {
  readonly baseUrl: string
  readonly bearerToken: string
  readonly worldKey: string
  readonly timeoutMs?: number
  readonly refreshIntervalMs?: number
  readonly maxResponseBytes?: number
  readonly maxSelectionAgeMs?: number
  readonly fetchImpl?: FetchLike
  readonly now?: () => number
}

const DEFAULT_TIMEOUT_MS = 800
const DEFAULT_REFRESH_INTERVAL_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024
const MAX_TOKEN_LENGTH = 4096

export class MoxueBridgeWorkspaceSelections
implements WorkspaceSelectionSource {
  private readonly baseUrl: string
  private readonly bearerToken: string
  private readonly worldKey: string
  private readonly timeoutMs: number
  private readonly refreshIntervalMs: number
  private readonly maxResponseBytes: number
  private readonly fetchImpl: FetchLike
  private readonly tracker: WorkspaceSelectionTracker
  private timer: NodeJS.Timeout | null = null

  constructor(
    options: MoxueBridgeWorkspaceSelectionsOptions
  ) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.bearerToken =
      normalizeToken(options.bearerToken)
    this.worldKey =
      normalizeWorldKey(options.worldKey)
    this.timeoutMs = normalizePositiveInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'timeoutMs',
      1,
      60_000
    )
    this.refreshIntervalMs =
      normalizePositiveInteger(
        options.refreshIntervalMs ??
          DEFAULT_REFRESH_INTERVAL_MS,
        'refreshIntervalMs',
        250,
        24 * 60 * 60 * 1000
      )
    this.maxResponseBytes =
      normalizePositiveInteger(
        options.maxResponseBytes ??
          DEFAULT_MAX_RESPONSE_BYTES,
        'maxResponseBytes',
        1,
        1024 * 1024
      )
    this.fetchImpl = options.fetchImpl ?? fetch
    this.tracker = new WorkspaceSelectionTracker({
      ...(options.now ? { now: options.now } : {}),
      ...(options.maxSelectionAgeMs
        ? {
            maxSelectionAgeMs:
              options.maxSelectionAgeMs
          }
        : {})
    })
  }

  async start(): Promise<void> {
    if (this.timer) return
    await this.refresh()
    this.timer = setInterval(() => {
      void this.refresh()
    }, this.refreshIntervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  async refresh(): Promise<boolean> {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      this.timeoutMs
    )

    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/api/v1/workspace-selections`,
        {
          method: 'GET',
          headers: {
            authorization:
              `Bearer ${this.bearerToken}`,
            accept: 'application/json'
          },
          signal: controller.signal
        }
      )

      if (response.status !== 200) {
        throw new Error(
          `http_${response.status}`
        )
      }

      const body = await response.text()
      if (
        Buffer.byteLength(body, 'utf8') >
        this.maxResponseBytes
      ) {
        throw new Error('response_too_large')
      }

      const parsed =
        WireSnapshotSchema.parse(
          JSON.parse(body)
        )

      return this.tracker.refresh({
        version: 1,
        generatedAt: parsed.generated_at,
        selections: parsed.selections.map(
          selection => ({
            id: selection.id,
            generation:
              selection.generation,
            worldKey: this.worldKey,
            dimension:
              selection.dimension,
            playerId:
              selection.player_id,
            playerName:
              selection.player_name,
            pointA: {
              ...selection.point_a
            },
            pointB: {
              ...selection.point_b
            },
            selectedAt:
              selection.selected_at
          })
        )
      })
    } catch (error) {
      this.tracker.noteFailure(
        classifyRefreshError(
          error,
          controller.signal
        )
      )
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  latest(
    query: WorkspaceSelectionQuery
  ): WorkspaceSelection | null {
    return this.tracker.latest(query)
  }

  status(): WorkspaceSelectionSourceStatus {
    return this.tracker.status()
  }
}

export function createWorkspaceSelectionsFromConfig(
  config: Extract<
    MoxueBridgeConfig,
    { enabled: true }
  >,
  worldKey: string
): MoxueBridgeWorkspaceSelections {
  return new MoxueBridgeWorkspaceSelections({
    baseUrl: config.baseUrl,
    bearerToken: config.bearerToken,
    worldKey,
    timeoutMs: config.timeoutMs,
    refreshIntervalMs:
      config.refreshIntervalMs
  })
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new Error(
      'MoxueBridge baseUrl is required'
    )
  }

  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw new Error(
      'MoxueBridge baseUrl must be a valid URL'
    )
  }

  if (
    parsed.protocol !== 'http:' &&
    parsed.protocol !== 'https:'
  ) {
    throw new Error(
      'MoxueBridge baseUrl must use http or https'
    )
  }

  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      'MoxueBridge baseUrl must not contain credentials, query, or fragment'
    )
  }

  return parsed
    .toString()
    .replace(/\/+$/, '')
}

function normalizeToken(value: string): string {
  const token = value.trim()
  if (
    !token ||
    token.length > MAX_TOKEN_LENGTH
  ) {
    throw new Error(
      'MoxueBridge bearer token is invalid'
    )
  }
  return token
}

function normalizeWorldKey(value: string): string {
  const normalized = value.trim()
  if (
    normalized.length < 1 ||
    normalized.length > 256
  ) {
    throw new Error(
      'workspace worldKey is invalid'
    )
  }
  return normalized
}

function normalizePositiveInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number
): number {
  if (
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(
      `${name} must be an integer between ${minimum} and ${maximum}`
    )
  }
  return value
}

function classifyRefreshError(
  error: unknown,
  signal: AbortSignal
): string {
  if (signal.aborted) return 'timeout'
  if (
    error instanceof z.ZodError ||
    error instanceof SyntaxError
  ) {
    return 'invalid_response'
  }
  if (error instanceof Error) {
    if (/^http_[0-9]{3}$/.test(error.message)) {
      return error.message
    }
    if (
      error.message ===
      'response_too_large'
    ) {
      return error.message
    }
  }
  return 'request_failed'
}
