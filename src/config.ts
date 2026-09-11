import { isIP } from 'node:net'

export type MinecraftAuth = 'offline' | 'microsoft'
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'
export type AiProviderName = 'fake' | 'gemini'

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
      readonly model: string
      readonly apiKey: string
    }

export interface ControlApiConfig {
  readonly host: string
  readonly port: number
  readonly bearerToken?: string
  readonly maxBodyBytes: number
}

const DEFAULT_CONTROL_HOST = '127.0.0.1'
const DEFAULT_CONTROL_PORT = 8766
const DEFAULT_CONTROL_MAX_BODY_BYTES = 16 * 1024
const MAX_CONTROL_BODY_BYTES = 1024 * 1024

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

  const model = required(env.MC_AI_MODEL, 'MC_AI_MODEL')
  if (model.length > 256) {
    throw new Error('MC_AI_MODEL must be at most 256 characters')
  }
  const apiKey = required(env.MC_AI_API_KEY, 'MC_AI_API_KEY')
  return {
    provider: 'gemini',
    model,
    apiKey
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
  if (bearerToken && bearerToken.length > 4096) {
    throw new Error('MC_CONTROL_TOKEN must be at most 4096 characters')
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
