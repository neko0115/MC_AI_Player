import { z } from 'zod'

const CapabilitySourceSchema = z.object({
  plugin: z.string().trim().min(1).max(128),
  version: z.string().trim().min(1).max(128),
  provenance: z.string().trim().min(1).max(64)
})

const CapabilityUsageSchema = z.object({
  trigger: z.string().trim().min(1).max(128),
  human: z.string().trim().min(1).max(500)
})

export const ServerCapabilitySchema = z.object({
  id: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().min(1).max(500),
  available: z.boolean(),
  source: CapabilitySourceSchema,
  usage: CapabilityUsageSchema,
  constraints: z.record(
    z.string().trim().min(1).max(128),
    z.unknown()
  )
})

const ServerCapabilityListSchema = z.array(ServerCapabilitySchema).max(128)

export type ServerCapability = z.infer<typeof ServerCapabilitySchema>
export type CapabilitySyncState = 'current' | 'stale' | 'unavailable'

export interface ServerCapabilitySource {
  snapshot(): readonly ServerCapability[]
  has(id: string): boolean
  get(id: string): ServerCapability | undefined
}

export interface CapabilitySyncStatus {
  readonly state: CapabilitySyncState
  readonly lastSuccessAt: number | null
  readonly lastErrorCode: string | null
}

export interface ServerCapabilityStatusSource extends ServerCapabilitySource {
  status(): CapabilitySyncStatus
}

type FetchLike = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>

export interface MoxueBridgeCapabilitiesOptions {
  readonly baseUrl: string
  readonly bearerToken: string
  readonly timeoutMs?: number
  readonly refreshIntervalMs?: number
  readonly maxResponseBytes?: number
  readonly fetchImpl?: FetchLike
  readonly now?: () => number
}

const DEFAULT_TIMEOUT_MS = 800
const DEFAULT_REFRESH_INTERVAL_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024
const MAX_TOKEN_LENGTH = 4096

export class MoxueBridgeCapabilities implements ServerCapabilityStatusSource {
  private readonly baseUrl: string
  private readonly bearerToken: string
  private readonly timeoutMs: number
  private readonly refreshIntervalMs: number
  private readonly maxResponseBytes: number
  private readonly fetchImpl: FetchLike
  private readonly now: () => number

  private capabilities = new Map<string, ServerCapability>()
  private lastSuccessAt: number | null = null
  private lastErrorCode: string | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(options: MoxueBridgeCapabilitiesOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.bearerToken = normalizeToken(options.bearerToken)
    this.timeoutMs = normalizePositiveInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'timeoutMs',
      1,
      60_000
    )
    this.refreshIntervalMs = normalizePositiveInteger(
      options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
      'refreshIntervalMs',
      250,
      24 * 60 * 60 * 1000
    )
    this.maxResponseBytes = normalizePositiveInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      'maxResponseBytes',
      1,
      1024 * 1024
    )
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
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
    const timer = setTimeout(() => {
      controller.abort()
    }, this.timeoutMs)

    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/api/v1/capabilities`,
        {
          method: 'GET',
          headers: {
            authorization: `Bearer ${this.bearerToken}`,
            accept: 'application/json'
          },
          signal: controller.signal
        }
      )

      if (response.status !== 200) {
        throw new Error(`http_${response.status}`)
      }

      const body = await response.text()
      if (Buffer.byteLength(body, 'utf8') > this.maxResponseBytes) {
        throw new Error('response_too_large')
      }

      const parsed = ServerCapabilityListSchema.parse(JSON.parse(body))
      const next = new Map<string, ServerCapability>()
      for (const capability of parsed) {
        if (!capability.available) continue
        if (next.has(capability.id)) {
          throw new Error('invalid_response')
        }
        next.set(capability.id, cloneCapability(capability))
      }

      this.capabilities = next
      this.lastSuccessAt = this.now()
      this.lastErrorCode = null
      return true
    } catch (error) {
      this.lastErrorCode = classifyRefreshError(error, controller.signal)
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  snapshot(): readonly ServerCapability[] {
    return [...this.capabilities.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(cloneCapability)
  }

  has(id: string): boolean {
    return this.capabilities.has(id)
  }

  get(id: string): ServerCapability | undefined {
    const capability = this.capabilities.get(id)
    return capability ? cloneCapability(capability) : undefined
  }

  status(): CapabilitySyncStatus {
    return {
      state: this.lastSuccessAt === null
        ? 'unavailable'
        : this.lastErrorCode === null
          ? 'current'
          : 'stale',
      lastSuccessAt: this.lastSuccessAt,
      lastErrorCode: this.lastErrorCode
    }
  }
}

function cloneCapability(capability: ServerCapability): ServerCapability {
  return {
    ...capability,
    source: { ...capability.source },
    usage: { ...capability.usage },
    constraints: structuredClone(capability.constraints)
  }
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error('MoxueBridge baseUrl is required')
  if (normalized.length > 2048) {
    throw new Error('MoxueBridge baseUrl must be at most 2048 characters')
  }

  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw new Error('MoxueBridge baseUrl must be a valid URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('MoxueBridge baseUrl must use http or https')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('MoxueBridge baseUrl must not contain credentials, query, or fragment')
  }

  return parsed.toString().replace(/\/+$/, '')
}

function normalizeToken(value: string): string {
  const token = value.trim()
  if (!token) throw new Error('MoxueBridge bearer token is required')
  if (token.length > MAX_TOKEN_LENGTH) {
    throw new Error(`MoxueBridge bearer token must be at most ${MAX_TOKEN_LENGTH} characters`)
  }
  return token
}

function normalizePositiveInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function classifyRefreshError(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) return 'timeout'
  if (error instanceof z.ZodError || error instanceof SyntaxError) return 'invalid_response'
  if (error instanceof Error) {
    if (/^http_[0-9]{3}$/.test(error.message)) return error.message
    if (error.message === 'response_too_large') return error.message
    if (error.message === 'invalid_response') return error.message
  }
  return 'request_failed'
}
