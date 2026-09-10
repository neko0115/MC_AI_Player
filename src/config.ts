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

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim()
  if (!normalized) {
    throw new Error(`${name} is required`)
  }
  return normalized
}

function isLogLevel(value: string): value is LogLevel {
  return value === 'error' || value === 'warn' || value === 'info' || value === 'debug'
}
