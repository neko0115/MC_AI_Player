import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isIP, type AddressInfo } from 'node:net'
import { z } from 'zod'
import { RuntimeEventSchema, type RuntimeEvent } from '../contracts/events.js'
import { GoalRequestSchema, type GoalRecord, type GoalRequest, type GoalSource } from '../contracts/goals.js'
import {
  MemorySearchQuerySchema,
  type MemorySearchQuery,
  type MinecraftMemory,
  type MinecraftMemoryRepository,
  type MinecraftMemoryType
} from '../memory/repository.js'
import type { WorldStateSnapshot } from '../state/world-state.js'

export interface ControlGoalPort {
  submit(request: GoalRequest, source: GoalSource): Promise<GoalRecord>
  activeGoal(): GoalRecord | null
  queuedGoals(): readonly GoalRecord[]
  emergencyStop(reason: string): Promise<void>
}

export interface ControlStatePort {
  snapshot(): WorldStateSnapshot
}

export interface ControlMemoryPort extends Pick<MinecraftMemoryRepository, 'search'> {}

export interface RuntimeEventSource {
  subscribe(listener: (event: RuntimeEvent) => void | Promise<void>): () => void
}

export interface ControlAiStatusSnapshot {
  readonly routineModel: string
  readonly complexModel: string
  readonly available: boolean
  readonly activeProject: string | null
  readonly flashAutoUsedPct: number
  readonly manualDeepThinkAvailable: boolean
  readonly coordinatorState: 'running' | 'stopped'
  readonly activeTaskId: string | null
  readonly activeGoalKind: GoalRequest['kind'] | null
  readonly pendingTaskCount: number
  readonly decisionInFlight: boolean
}

export interface ControlAiStatusPort {
  snapshot(): ControlAiStatusSnapshot
}

export interface ControlCapabilityStatusDetail {
  readonly id: string
  readonly trigger: string
  readonly constraints: Readonly<Record<string, unknown>>
}

export interface ControlCapabilityStatusSnapshot {
  readonly state: 'current' | 'stale' | 'unavailable'
  readonly ids: readonly string[]
  readonly details?: readonly ControlCapabilityStatusDetail[]
}

export interface ControlCapabilityStatusPort {
  snapshot(): ControlCapabilityStatusSnapshot
}

export interface ControlWorkspaceSelectionQuery {
  readonly dimension: string
  readonly playerId: string
}

export interface ControlWorkspaceSelectionSnapshot {
  readonly id: string
  readonly generation: number
  readonly worldKey: string
  readonly dimension: string
  readonly playerId: string
  readonly playerName: string
  readonly pointA: {
    readonly x: number
    readonly y: number
    readonly z: number
  }
  readonly pointB: {
    readonly x: number
    readonly y: number
    readonly z: number
  }
  readonly selectedAt: number
}

export interface ControlWorkspaceSelectionStatusSnapshot {
  readonly state: 'current' | 'stale' | 'unavailable'
  readonly lastSuccessAt: number | null
  readonly lastErrorCode: string | null
  readonly selection: ControlWorkspaceSelectionSnapshot | null
}

export interface ControlWorkspaceSelectionStatusPort {
  snapshot(
    query: ControlWorkspaceSelectionQuery
  ): ControlWorkspaceSelectionStatusSnapshot
}

export interface ControlServerOptions {
  readonly host: string
  readonly port: number
  readonly bearerToken?: string
  readonly maxBodyBytes?: number
  readonly goals: ControlGoalPort
  readonly state: ControlStatePort
  readonly memory: ControlMemoryPort
  readonly events: RuntimeEventSource
  readonly aiStatus?: ControlAiStatusPort
  readonly capabilityStatus?: ControlCapabilityStatusPort
  readonly workspaceSelectionStatus?: ControlWorkspaceSelectionStatusPort
}

export interface ControlServerAddress {
  readonly host: string
  readonly port: number
  readonly baseUrl: string
}

const DEFAULT_MAX_BODY_BYTES = 16 * 1024
const MAX_STATUS_QUEUE = 64
const MAX_STATUS_PLAYERS = 32
const MAX_STATUS_INVENTORY = 128
const MAX_STATUS_CAPABILITIES = 64
const CAPABILITY_CONSTRAINT_ALLOWLIST = new Set([
  'max_chain',
  'correct_tool_required',
  'must_sneak',
  'same_block_only',
  'exact_block',
  'tool_kind',
  'merge_item_drops'
])

const StopRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(500).optional()
  })
  .strict()

const WorkspaceSelectionStatusQuerySchema = z
  .object({
    dimension: z.string().trim().min(1).max(128),
    playerId: z.string().trim().min(1).max(128)
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

export class ControlServer {
  private readonly host: string
  private readonly port: number
  private readonly bearerToken: string | undefined
  private readonly maxBodyBytes: number
  private server: Server | null = null
  private readonly sseResponses = new Set<ServerResponse>()

  constructor(private readonly options: ControlServerOptions) {
    this.host = normalizeHost(options.host)
    this.port = normalizePort(options.port)
    this.bearerToken = normalizeOptionalToken(options.bearerToken)
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
    if (!Number.isInteger(this.maxBodyBytes) || this.maxBodyBytes < 1 || this.maxBodyBytes > 1024 * 1024) {
      throw new RangeError('maxBodyBytes must be an integer between 1 and 1048576')
    }
  }

  async start(): Promise<ControlServerAddress> {
    if (this.server) {
      throw new Error('control server is already started')
    }
    if (!isLoopbackHost(this.host) && !this.bearerToken) {
      throw new Error('non-loopback control bind requires a bearer token')
    }

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
        server.listen(this.port, this.host)
      })
    } catch (error) {
      this.server = null
      throw error
    }

    const address = server.address()
    if (!address || typeof address === 'string') {
      await this.close()
      throw new Error('control server did not expose a TCP address')
    }
    return toControlAddress(this.host, address)
  }

  async close(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null

    for (const response of [...this.sseResponses]) {
      if (!response.writableEnded) response.end()
    }
    this.sseResponses.clear()

    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!this.authorize(request, response)) return

      const url = new URL(request.url ?? '/', 'http://control.local')
      const method = request.method ?? 'GET'

      if (url.pathname === '/health') {
        requireMethod(method, 'GET')
        writeJson(response, 200, { ok: true })
        return
      }

      if (url.pathname === '/v1/status') {
        requireMethod(method, 'GET')
        writeJson(response, 200, this.statusPayload())
        return
      }

      if (url.pathname === '/v1/workspace-selection') {
        requireMethod(method, 'GET')
        if (!this.options.workspaceSelectionStatus) {
          throw new HttpRequestError(
            503,
            'workspace_selection_unavailable'
          )
        }
        const query = parseWorkspaceSelectionStatusQuery(
          url.searchParams
        )
        writeJson(
          response,
          200,
          publicWorkspaceSelectionStatus(
            this.options.workspaceSelectionStatus.snapshot(
              query
            )
          )
        )
        return
      }

      if (url.pathname === '/v1/goals') {
        requireMethod(method, 'POST')
        const body = await readJsonBody(request, this.maxBodyBytes)
        const parsed = GoalRequestSchema.safeParse(body)
        if (!parsed.success) throw new HttpRequestError(400, 'invalid_goal')
        const record = await this.options.goals.submit(parsed.data, 'player')
        writeJson(response, 202, { accepted: true, goal_id: record.goalId })
        return
      }

      if (url.pathname === '/v1/stop') {
        requireMethod(method, 'POST')
        const body = await readJsonBody(request, this.maxBodyBytes)
        const parsed = StopRequestSchema.safeParse(body)
        if (!parsed.success) throw new HttpRequestError(400, 'invalid_stop_request')
        await this.options.goals.emergencyStop(parsed.data.reason ?? 'api_stop')
        writeJson(response, 200, { stopped: true })
        return
      }

      if (url.pathname === '/v1/memory/search') {
        requireMethod(method, 'GET')
        const query = parseMemoryQuery(url.searchParams)
        const memories = this.options.memory.search(query)
        writeJson(response, 200, { memories })
        return
      }

      if (url.pathname === '/v1/events') {
        requireMethod(method, 'GET')
        this.openEventStream(request, response)
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
    if (isLoopbackHost(this.host)) return true
    const expected = this.bearerToken
    if (!expected) {
      writeUnauthorized(response)
      return false
    }

    const header = request.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      writeUnauthorized(response)
      return false
    }
    const supplied = header.slice('Bearer '.length)
    if (!constantTimeEqual(supplied, expected)) {
      writeUnauthorized(response)
      return false
    }
    return true
  }

  private statusPayload(): unknown {
    const state = this.options.state.snapshot()
    const active = this.options.goals.activeGoal()
    const queued = this.options.goals.queuedGoals().slice(0, MAX_STATUS_QUEUE)
    return {
      minecraft: {
        connected: state.connected,
        spawned: state.spawned,
        health: state.health,
        food: state.food,
        dimension: state.dimension,
        position: state.position ? structuredClone(state.position) : null,
        nearby_players: state.nearbyPlayers
          .slice(0, MAX_STATUS_PLAYERS)
          .map(player => structuredClone(player)),
        inventory: state.inventory
          .slice(0, MAX_STATUS_INVENTORY)
          .map(item => structuredClone(item))
      },
      active_goal: active ? cloneGoal(active) : null,
      queued_goals: queued.map(cloneGoal),
      ...(this.options.aiStatus
        ? { ai: publicAiStatus(this.options.aiStatus.snapshot()) }
        : {}),
      ...(this.options.capabilityStatus
        ? { server_capabilities: publicCapabilityStatus(this.options.capabilityStatus.snapshot()) }
        : {})
    }
  }

  private openEventStream(request: IncomingMessage, response: ServerResponse): void {
    response.statusCode = 200
    response.setHeader('content-type', 'text/event-stream; charset=utf-8')
    response.setHeader('cache-control', 'no-cache, no-transform')
    response.setHeader('connection', 'keep-alive')
    response.setHeader('x-accel-buffering', 'no')
    response.flushHeaders()
    response.write(': connected\n\n')
    this.sseResponses.add(response)

    let closed = false
    const unsubscribe = this.options.events.subscribe(event => {
      if (closed || response.writableEnded || response.destroyed) return
      const parsed = RuntimeEventSchema.safeParse(event)
      if (!parsed.success) return
      response.write(`data: ${JSON.stringify(parsed.data)}\n\n`)
    })

    const cleanup = () => {
      if (closed) return
      closed = true
      this.sseResponses.delete(response)
      unsubscribe()
    }
    request.once('close', cleanup)
    response.once('close', cleanup)
  }
}


function publicCapabilityStatus(snapshot: ControlCapabilityStatusSnapshot): unknown {
  const state =
    snapshot.state === 'current' || snapshot.state === 'stale'
      ? snapshot.state
      : 'unavailable'
  const ids = [...new Set(
    snapshot.ids
      .map(id => boundedText(id, 128))
      .filter(Boolean)
  )]
    .sort()
    .slice(0, MAX_STATUS_CAPABILITIES)

  const details = (snapshot.details ?? [])
    .slice(0, MAX_STATUS_CAPABILITIES)
    .map(detail => ({
      id: boundedText(detail.id, 128),
      trigger: boundedText(detail.trigger, 128),
      constraints: publicCapabilityConstraints(detail.constraints)
    }))
    .filter(detail => detail.id.length > 0)
    .sort((left, right) => left.id.localeCompare(right.id))

  return {
    sync_state: state,
    ids,
    ...(details.length > 0 ? { details } : {})
  }
}

function publicCapabilityConstraints(
  constraints: Readonly<Record<string, unknown>>
): Readonly<Record<string, string | number | boolean | null>> {
  const safe: Record<string, string | number | boolean | null> = {}
  for (const key of [...CAPABILITY_CONSTRAINT_ALLOWLIST].sort()) {
    const value = constraints[key]
    if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      typeof value === 'string'
    ) {
      safe[key] = typeof value === 'string'
        ? boundedText(value, 128)
        : value
    }
  }
  return safe
}

function publicAiStatus(snapshot: ControlAiStatusSnapshot): unknown {
  return {
    routine_model: boundedText(snapshot.routineModel, 256),
    complex_model: boundedText(snapshot.complexModel, 256),
    available: snapshot.available === true,
    active_project: snapshot.activeProject === null
      ? null
      : boundedText(snapshot.activeProject, 64),
    flash_auto_used_pct: boundedPercent(snapshot.flashAutoUsedPct),
    manual_deep_think_available: snapshot.manualDeepThinkAvailable === true,
    coordinator_state: snapshot.coordinatorState === 'running' ? 'running' : 'stopped',
    active_task_id: snapshot.activeTaskId === null
      ? null
      : boundedText(snapshot.activeTaskId, 128),
    active_goal_kind: snapshot.activeGoalKind,
    pending_task_count: boundedCount(snapshot.pendingTaskCount),
    decision_in_flight: snapshot.decisionInFlight === true
  }
}

function parseMemoryQuery(params: URLSearchParams): MemorySearchQuery {
  const candidate: Record<string, unknown> = {
    worldKey: params.get('world_key') ?? undefined
  }

  copyOptionalText(params, 'text', candidate, 'text')
  copyOptionalText(params, 'dimension', candidate, 'dimension')

  const types = parseCsv(params.get('types'))
  if (types) candidate.types = types as MinecraftMemoryType[]
  const tags = parseCsv(params.get('tags'))
  if (tags) candidate.tags = tags

  const limit = parseOptionalNumber(params, 'limit')
  if (limit !== undefined) candidate.limit = limit

  const coordinateNames = ['x', 'y', 'z', 'radius'] as const
  const present = coordinateNames.map(name => params.has(name))
  if (present.some(Boolean)) {
    if (!present.every(Boolean)) {
      throw new HttpRequestError(400, 'invalid_memory_query')
    }
    candidate.near = {
      position: {
        x: Number(params.get('x')),
        y: Number(params.get('y')),
        z: Number(params.get('z'))
      },
      radius: Number(params.get('radius'))
    }
  }

  const parsed = MemorySearchQuerySchema.safeParse(candidate)
  if (!parsed.success) throw new HttpRequestError(400, 'invalid_memory_query')
  return parsed.data
}

function copyOptionalText(
  params: URLSearchParams,
  sourceName: string,
  target: Record<string, unknown>,
  targetName: string
): void {
  if (params.has(sourceName)) target[targetName] = params.get(sourceName) ?? ''
}

function parseCsv(value: string | null): string[] | undefined {
  if (value === null) return undefined
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function parseOptionalNumber(params: URLSearchParams, name: string): number | undefined {
  if (!params.has(name)) return undefined
  return Number(params.get(name))
}

async function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const contentType = request.headers['content-type']
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpRequestError(415, 'content_type_required')
  }

  const contentLength = request.headers['content-length']
  if (typeof contentLength === 'string') {
    const declared = Number(contentLength)
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      request.resume()
      throw new HttpRequestError(413, 'body_too_large')
    }
  }

  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maxBodyBytes) {
      throw new HttpRequestError(413, 'body_too_large')
    }
    chunks.push(buffer)
  }

  if (total === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown
  } catch {
    throw new HttpRequestError(400, 'invalid_json')
  }
}

function requireMethod(actual: string, expected: string): void {
  if (actual !== expected) throw new HttpRequestError(405, 'method_not_allowed')
}

function parseWorkspaceSelectionStatusQuery(
  params: URLSearchParams
): ControlWorkspaceSelectionQuery {
  const parsed = WorkspaceSelectionStatusQuerySchema.safeParse({
    dimension: params.get('dimension'),
    playerId: params.get('player_id')
  })
  if (!parsed.success) {
    throw new HttpRequestError(
      400,
      'invalid_workspace_selection_query'
    )
  }
  return parsed.data
}

function publicWorkspaceSelectionStatus(
  snapshot: ControlWorkspaceSelectionStatusSnapshot
): unknown {
  return {
    sync_state: snapshot.state,
    last_success_at: snapshot.lastSuccessAt,
    last_error_code: snapshot.lastErrorCode,
    selection: snapshot.selection
      ? {
          id: snapshot.selection.id,
          generation: snapshot.selection.generation,
          world_key: snapshot.selection.worldKey,
          dimension: snapshot.selection.dimension,
          player_id: snapshot.selection.playerId,
          player_name: snapshot.selection.playerName,
          point_a: {
            ...snapshot.selection.pointA
          },
          point_b: {
            ...snapshot.selection.pointB
          },
          selected_at: snapshot.selection.selectedAt
        }
      : null
  }
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  if (response.writableEnded) return
  const payload = JSON.stringify(body)
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('content-length', Buffer.byteLength(payload))
  response.setHeader('cache-control', 'no-store')
  response.end(payload)
}

function writeUnauthorized(response: ServerResponse): void {
  response.setHeader('www-authenticate', 'Bearer')
  writeJson(response, 401, { error: 'unauthorized' })
}

function cloneGoal(record: GoalRecord): GoalRecord {
  return {
    ...record,
    request: structuredClone(record.request)
  }
}

function boundedText(value: string, maximum: number): string {
  const normalized = value.trim()
  return normalized.length <= maximum ? normalized : normalized.slice(0, maximum)
}

function boundedPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

function boundedCount(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1_000_000, Math.max(0, Math.floor(value)))
}

function normalizeHost(value: string): string {
  const host = value.trim().toLowerCase()
  if (!host || host.length > 255) throw new RangeError('host must be a non-empty value up to 255 characters')
  return host
}

function normalizePort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new RangeError('port must be an integer between 0 and 65535')
  }
  return value
}

function normalizeOptionalToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const token = value.trim()
  if (!token) return undefined
  if (token.length > 4096) throw new RangeError('bearerToken must be at most 4096 characters')
  return token
}

function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host === '::1') return true
  if (isIP(host) !== 4) return false
  return Number(host.split('.')[0]) === 127
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}

function toControlAddress(configuredHost: string, address: AddressInfo): ControlServerAddress {
  const connectHost = configuredHost === '0.0.0.0'
    ? '127.0.0.1'
    : configuredHost === '::'
      ? '::1'
      : configuredHost
  const urlHost = connectHost.includes(':') ? `[${connectHost}]` : connectHost
  return {
    host: configuredHost,
    port: address.port,
    baseUrl: `http://${urlHost}:${address.port}`
  }
}
