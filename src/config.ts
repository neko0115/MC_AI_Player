import { isIP } from 'node:net'

export type MinecraftAuth = 'offline' | 'microsoft'
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'
export type AiProviderName = 'fake' | 'gemini'
export type MinecraftServerIdentityMode = 'online' | 'offline'
export type TreeLeafCleanupSetting =
  | 'catalog'
  | 'natural_decay'
  | 'remove_after_felling'
  | 'preserve'

export interface MinecraftConfig {
  host: string
  port: number
  username: string
  auth: MinecraftAuth
  version?: string
  logLevel: LogLevel
}

export type AiConfig =
  | { readonly provider: 'fake' }
  | {
      readonly provider: 'gemini'
      readonly routingConfigPath: string
    }

export interface ControlApiConfig {
  readonly host: string
  readonly port: number
  readonly bearerToken?: string
  readonly maxBodyBytes: number
}

export type MoxueBridgeConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true
      readonly baseUrl: string
      readonly bearerToken: string
      readonly timeoutMs: number
      readonly refreshIntervalMs: number
    }

export type AdminApiConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true
      readonly host: '127.0.0.1'
      readonly port: number
      readonly bearerToken: string
    }

const DEFAULT_CONTROL_HOST = '127.0.0.1'
const DEFAULT_CONTROL_PORT = 8766
const DEFAULT_CONTROL_MAX_BODY_BYTES = 16 * 1024
const MAX_CONTROL_BODY_BYTES = 1024 * 1024
const DEFAULT_AI_ROUTING_PATH = 'data/ai-routing.json'
const MAX_AI_ROUTING_PATH_LENGTH = 4096
const DEFAULT_ADMIN_PORT = 8767
const DEFAULT_MOXUEBRIDGE_TIMEOUT_MS = 800
const DEFAULT_MOXUEBRIDGE_REFRESH_INTERVAL_MS = 30_000
const MAX_MOXUEBRIDGE_URL_LENGTH = 2048
const MAX_TOKEN_LENGTH = 4096

export function loadMinecraftConfig(env: NodeJS.ProcessEnv): MinecraftConfig {
  const host = required(env.MC_HOST, 'MC_HOST')
  const username = required(env.MC_USERNAME, 'MC_USERNAME')
  const portText = required(env.MC_PORT, 'MC_PORT')
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('MC_PORT must be an integer between 1 and 65535')
  }

  const authText = required(env.MC_AUTH, 'MC_AUTH')
  if (authText !== 'offline' && authText !== 'microsoft') {
    throw new Error('MC_AUTH must be offline or microsoft')
  }

  const logLevelText = env.MC_LOG_LEVEL?.trim() || 'info'
  if (!isLogLevel(logLevelText)) {
    throw new Error('MC_LOG_LEVEL must be error, warn, info, or debug')
  }

  const version = env.MC_VERSION?.trim()
  return {
    host,
    port,
    username,
    auth: authText,
    ...(version ? { version } : {}),
    logLevel: logLevelText
  }
}

export function loadAiConfig(
  env: Readonly<Record<string, string | undefined>>
): AiConfig {
  const provider = env.MC_AI_PROVIDER?.trim() || 'fake'
  if (provider === 'fake') {
    return { provider: 'fake' }
  }
  if (provider !== 'gemini') {
    throw new Error('MC_AI_PROVIDER must be fake or gemini')
  }

  const routingConfigPath = env.MC_AI_ROUTING_CONFIG?.trim() || DEFAULT_AI_ROUTING_PATH
  if (routingConfigPath.length > MAX_AI_ROUTING_PATH_LENGTH) {
    throw new Error(`MC_AI_ROUTING_CONFIG must be at most ${MAX_AI_ROUTING_PATH_LENGTH} characters`)
  }
  return {
    provider: 'gemini',
    routingConfigPath
  }
}

export function loadMinecraftServerIdentityMode(
  env: Readonly<Record<string, string | undefined>>
): MinecraftServerIdentityMode {
  return env.MC_SERVER_IDENTITY_MODE?.trim().toLowerCase() === 'online'
    ? 'online'
    : 'offline'
}

export function loadTreeLeafCleanupSetting(
  env: Readonly<Record<string, string | undefined>>
): TreeLeafCleanupSetting {
  const value = env.MC_TREE_LEAF_CLEANUP_POLICY?.trim().toLowerCase() || 'catalog'
  if (
    value !== 'catalog' &&
    value !== 'natural_decay' &&
    value !== 'remove_after_felling' &&
    value !== 'preserve'
  ) {
    throw new Error(
      'MC_TREE_LEAF_CLEANUP_POLICY must be catalog, natural_decay, remove_after_felling, or preserve'
    )
  }
  return value
}

export function loadMoxueBridgeConfig(
  env: Readonly<Record<string, string | undefined>>
): MoxueBridgeConfig {
  const rawBaseUrl = env.MC_MOXUEBRIDGE_BASE_URL?.trim()
  if (!rawBaseUrl) {
    return { enabled: false }
  }
  if (rawBaseUrl.length > MAX_MOXUEBRIDGE_URL_LENGTH) {
    throw new Error(`MC_MOXUEBRIDGE_BASE_URL must be at most ${MAX_MOXUEBRIDGE_URL_LENGTH} characters`)
  }

  let parsed: URL
  try {
    parsed = new URL(rawBaseUrl)
  } catch {
    throw new Error('MC_MOXUEBRIDGE_BASE_URL must be a valid URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('MC_MOXUEBRIDGE_BASE_URL must use http or https')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('MC_MOXUEBRIDGE_BASE_URL must not contain credentials, query, or fragment')
  }

  const bearerToken = env.MC_MOXUEBRIDGE_TOKEN?.trim()
  if (!bearerToken) {
    throw new Error('MC_MOXUEBRIDGE_TOKEN is required when MC_MOXUEBRIDGE_BASE_URL is set')
  }
  if (bearerToken.length > MAX_TOKEN_LENGTH) {
    throw new Error(`MC_MOXUEBRIDGE_TOKEN must be at most ${MAX_TOKEN_LENGTH} characters`)
  }

  return {
    enabled: true,
    baseUrl: parsed.toString().replace(/\/+$/, ''),
    bearerToken,
    timeoutMs: parseIntegerSetting(
      env.MC_MOXUEBRIDGE_TIMEOUT_MS,
      DEFAULT_MOXUEBRIDGE_TIMEOUT_MS,
      'MC_MOXUEBRIDGE_TIMEOUT_MS',
      1,
      60_000
    ),
    refreshIntervalMs: parseIntegerSetting(
      env.MC_MOXUEBRIDGE_REFRESH_INTERVAL_MS,
      DEFAULT_MOXUEBRIDGE_REFRESH_INTERVAL_MS,
      'MC_MOXUEBRIDGE_REFRESH_INTERVAL_MS',
      250,
      24 * 60 * 60 * 1000
    )
  }
}

export function loadAdminApiConfig(
  env: Readonly<Record<string, string | undefined>>
): AdminApiConfig {
  const bearerToken = env.MC_ADMIN_TOKEN?.trim()
  if (!bearerToken) {
    return { enabled: false }
  }
  if (bearerToken.length > MAX_TOKEN_LENGTH) {
    throw new Error(`MC_ADMIN_TOKEN must be at most ${MAX_TOKEN_LENGTH} characters`)
  }

  const port = parseIntegerSetting(
    env.MC_ADMIN_PORT,
    DEFAULT_ADMIN_PORT,
    'MC_ADMIN_PORT',
    1,
    65535
  )

  return {
    enabled: true,
    host: '127.0.0.1',
    port,
    bearerToken
  }
}

export function loadControlApiConfig(
  env: Readonly<Record<string, string | undefined>>
): ControlApiConfig {
  const host = (env.MC_CONTROL_HOST ?? DEFAULT_CONTROL_HOST).trim().toLowerCase()
  if (!host || host.length > 255) {
    throw new Error('MC_CONTROL_HOST must be a non-empty value up to 255 characters')
  }

  const port = parseIntegerSetting(
    env.MC_CONTROL_PORT,
    DEFAULT_CONTROL_PORT,
    'MC_CONTROL_PORT',
    1,
    65535
  )
  const maxBodyBytes = parseIntegerSetting(
    env.MC_CONTROL_MAX_BODY_BYTES,
    DEFAULT_CONTROL_MAX_BODY_BYTES,
    'MC_CONTROL_MAX_BODY_BYTES',
    1,
    MAX_CONTROL_BODY_BYTES
  )
  const bearerToken = env.MC_CONTROL_TOKEN?.trim()
  if (bearerToken && bearerToken.length > MAX_TOKEN_LENGTH) {
    throw new Error(`MC_CONTROL_TOKEN must be at most ${MAX_TOKEN_LENGTH} characters`)
  }
  if (!isLoopbackHost(host) && !bearerToken) {
    throw new Error('MC_CONTROL_TOKEN is required for non-loopback MC_CONTROL_HOST')
  }

  return {
    host,
    port,
    ...(bearerToken ? { bearerToken } : {}),
    maxBodyBytes
  }
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim()
  if (!normalized) {
    throw new Error(`${name} is required`)
  }
  return normalized
}

function parseIntegerSetting(
  raw: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number
): number {
  const value = raw === undefined || raw.trim() === '' ? fallback : Number(raw)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host === '::1') return true
  if (isIP(host) !== 4) return false
  return Number(host.split('.')[0]) === 127
}

function isLogLevel(value: string): value is LogLevel {
  return value === 'error' || value === 'warn' || value === 'info' || value === 'debug'
}
