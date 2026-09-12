import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'
import type {
  RoutingConfigSnapshot,
  RoutingReloadResult
} from '../agent/routing/config-manager.js'
import type { AdminQuotaProjectSnapshot } from '../agent/routing/quota-ledger.js'
import type {
  AdminDeepThinkRequest,
  CoordinatorCommandResult
} from '../runtime/decision-coordinator.js'

export interface AdminQuotaPort {
  adminSnapshot(now: number): readonly AdminQuotaProjectSnapshot[]
}

export interface AdminRoutingPort {
  reload(): RoutingReloadResult
  snapshot(): RoutingConfigSnapshot
}

export interface AdminCoordinatorPort {
  submitAdminDeepThink(request: AdminDeepThinkRequest): Promise<CoordinatorCommandResult>
  invalidateManualGrants(): void
}

export interface AdminServerOptions {
  readonly port: number
  readonly bearerToken: string
  readonly maxBodyBytes?: number
  readonly quota: AdminQuotaPort
  readonly routing: AdminRoutingPort
  readonly coordinator: AdminCoordinatorPort
  readonly now?: () => number
}

export interface AdminServerAddress {
  readonly host: '127.0.0.1'
  readonly port: number
  readonly baseUrl: string
}

interface CachedResponse {
  readonly fingerprint: string
  readonly statusCode: number
  readonly payload: unknown
}

const ADMIN_HOST = '127.0.0.1' as const
const DEFAULT_MAX_BODY_BYTES = 16 * 1024
const MAX_BODY_BYTES = 1024 * 1024
const MAX_TOKEN_LENGTH = 4096
const MAX_IDEMPOTENCY_KEY_LENGTH = 256
const MAX_IDEMPOTENCY_ENTRIES = 256

const DeepThinkSchema = z
  .object({
    instruction: z.string().trim().min(1).max(1000),
    target_goal_id: z.string().trim().min(1).max(128).optional()
  })
  .strict()

class HttpRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly publicCode: string
  ) {
    super(publicCode)
  }
}

export class AdminServer {
  private readonly port: number
  private readonly bearerToken: string
  private readonly maxBodyBytes: number
  private readonly now: () => number
  private readonly idempotency = new Map<string, CachedResponse>()
  private server: Server | null = null

  constructor(private readonly options: AdminServerOptions) {
    this.port = normalizePort(options.port)
    this.bearerToken = normalizeToken(options.bearerToken)
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
    if (
      !Number.isInteger(this.maxBodyBytes) ||
      this.maxBodyBytes < 1 ||
      this.maxBodyBytes > MAX_BODY_BYTES
    ) {
      throw new RangeError(`maxBodyBytes must be an integer between 1 and ${MAX_BODY_BYTES}`)
    }
    this.now = options.now ?? Date.now
  }

  async start(): Promise<AdminServerAddress> {
    if (this.server) throw new Error('admin server is already started')

    const server = createServer((request, response) => {
      void this.handleRequest(request, response).catch(() => {
        if (!response.headersSent) {
          writeJson(response, 500, { error: 'internal_error' })
        } else if (!response.writableEnded) {
          response.end()
        }
      })
    })
    this.server = server

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(this.port, ADMIN_HOST)
      })
    } catch (error) {
      this.server = null
      throw error
    }

    const address = server.address()
    if (!address || typeof address === 'string') {
      await this.close()
      throw new Error('admin server did not expose a TCP address')
    }
    return toAdminAddress(address)
  }

  async close(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    try {
      if (!this.authorize(request, response)) return

      const url = new URL(request.url ?? '/', 'http://admin.local')
      const method = request.method ?? 'GET'

      if (url.pathname === '/v1/admin/ai-quota') {
        requireMethod(method, 'GET')
        writeJson(response, 200, this.quotaPayload())
        return
      }

      if (url.pathname === '/v1/admin/ai-routing/reload') {
        requireMethod(method, 'POST')
        const result = this.options.routing.reload()
        if (result.kind === 'rejected') {
          writeJson(response, 400, { error: result.code })
          return
        }
        if (result.authorizationChanged) {
          this.options.coordinator.invalidateManualGrants()
        }
        writeJson(response, 200, {
          reloaded: true,
          generation: result.generation
        })
        return
      }

      if (url.pathname === '/v1/admin/ai/deep-think') {
        requireMethod(method, 'POST')
        await this.handleDeepThink(request, response)
        return
      }

      writeJson(response, 404, { error: 'not_found' })
    } catch (error) {
      if (error instanceof HttpRequestError) {
        if (!response.headersSent) {
          writeJson(response, error.statusCode, { error: error.publicCode })
        } else if (!response.writableEnded) {
          response.end()
        }
        return
      }
      throw error
    }
  }

  private authorize(request: IncomingMessage, response: ServerResponse): boolean {
    const header = request.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      writeUnauthorized(response)
      return false
    }
    const supplied = header.slice('Bearer '.length)
    if (!constantTimeEqual(supplied, this.bearerToken)) {
      writeUnauthorized(response)
      return false
    }
    return true
  }

  private quotaPayload(): unknown {
    const routing = this.options.routing.snapshot()
    const labels = new Map<string, string>()
    for (let index = 0; index < routing.projects.length; index += 1) {
      const project = routing.projects[index]
      if (!project) continue
      labels.set(project.projectKey, index === 0 ? 'primary' : `backup-${index}`)
    }

    let retiredIndex = 0
    const projects = this.options.quota.adminSnapshot(this.now()).map(project => ({
      project: labels.get(project.projectKey) ?? `retired-${++retiredIndex}`,
      domains: structuredClone(project.domains)
    }))
    return { projects }
  }

  private async handleDeepThink(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const key = normalizeIdempotencyKey(request.headers['idempotency-key'])
    if (!key) throw new HttpRequestError(400, 'idempotency_key_required')

    const raw = await readJsonBody(request, this.maxBodyBytes)
    const parsed = DeepThinkSchema.safeParse(raw)
    if (!parsed.success) throw new HttpRequestError(400, 'invalid_deep_think_request')

    const command: AdminDeepThinkRequest = {
      instruction: parsed.data.instruction,
      ...(parsed.data.target_goal_id === undefined
        ? {}
        : { targetGoalId: parsed.data.target_goal_id })
    }
    const fingerprint = JSON.stringify(command)
    const cached = this.idempotency.get(key)
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        writeJson(response, 409, { error: 'idempotency_conflict' })
        return
      }
      writeJson(response, cached.statusCode, cached.payload)
      return
    }

    const result = await this.options.coordinator.submitAdminDeepThink(command)
    const responseValue = coordinatorResponse(result)
    this.rememberIdempotentResponse(key, {
      fingerprint,
      statusCode: responseValue.statusCode,
      payload: responseValue.payload
    })
    writeJson(response, responseValue.statusCode, responseValue.payload)
  }

  private rememberIdempotentResponse(key: string, value: CachedResponse): void {
    while (this.idempotency.size >= MAX_IDEMPOTENCY_ENTRIES) {
      const oldest = this.idempotency.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.idempotency.delete(oldest)
    }
    this.idempotency.set(key, Object.freeze({
      fingerprint: value.fingerprint,
      statusCode: value.statusCode,
      payload: structuredClone(value.payload)
    }))
  }
}

function coordinatorResponse(result: CoordinatorCommandResult): {
  statusCode: number
  payload: unknown
} {
  if (result.kind === 'accepted') {
    return {
      statusCode: 202,
      payload: { accepted: true, task_id: result.taskId }
    }
  }
  return {
    statusCode: 409,
    payload: { error: result.code }
  }
}

function normalizePort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new RangeError('port must be an integer between 0 and 65535')
  }
  return value
}

function normalizeToken(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > MAX_TOKEN_LENGTH) {
    throw new RangeError(`bearerToken must be between 1 and ${MAX_TOKEN_LENGTH} characters`)
  }
  return normalized
}

function normalizeIdempotencyKey(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized || normalized.length > MAX_IDEMPOTENCY_KEY_LENGTH) return null
  return normalized
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest()
  const rightDigest = createHash('sha256').update(right).digest()
  return timingSafeEqual(leftDigest, rightDigest)
}

function requireMethod(actual: string, expected: string): void {
  if (actual !== expected) throw new HttpRequestError(405, 'method_not_allowed')
}

async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new HttpRequestError(413, 'request_too_large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new HttpRequestError(400, 'invalid_json')
  }
}

function writeUnauthorized(response: ServerResponse): void {
  response.setHeader('WWW-Authenticate', 'Bearer')
  writeJson(response, 401, { error: 'unauthorized' })
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const payload = JSON.stringify(value)
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('content-length', Buffer.byteLength(payload))
  response.end(payload)
}

function toAdminAddress(address: AddressInfo): AdminServerAddress {
  return {
    host: ADMIN_HOST,
    port: address.port,
    baseUrl: `http://${ADMIN_HOST}:${address.port}`
  }
}
