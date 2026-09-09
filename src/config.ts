export type MinecraftAuth = 'offline' | 'microsoft'
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

export interface MinecraftConfig {
  host: string
  port: number
  username: string
  auth: MinecraftAuth
  version?: string
  logLevel: LogLevel
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
