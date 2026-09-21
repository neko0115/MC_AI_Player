import {
  existsSync,
  readFileSync
} from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  loadAiConfig,
  loadMinecraftConfig,
  loadMinecraftServerIdentityMode,
  loadMoxueBridgeConfig
} from '../src/config.js'
import {
  parseRoutingConfig
} from '../src/agent/routing/config.js'
import {
  deriveWorkspaceSemanticKeys
} from '../src/workspace/learned-intent-export.js'

export type WorkspaceLivePreflightCode =
  | 'provider_not_gemini'
  | 'identity_mode_not_online'
  | 'minecraft_config_invalid'
  | 'minecraft_auth_not_microsoft'
  | 'moxuebridge_not_enabled'
  | 'moxuebridge_config_invalid'
  | 'routing_config_missing'
  | 'routing_config_invalid'
  | 'routing_credential_missing'
  | 'semantic_master_secret_invalid'

export interface WorkspaceLiveCredentialStatus {
  readonly name: string
  readonly set: boolean
}

export interface WorkspaceLivePreflightReport {
  readonly kind: 'ready'
  readonly checks: {
    readonly aiProvider: 'gemini'
    readonly serverIdentityMode: 'online'
    readonly minecraftAuth: 'microsoft'
    readonly moxueBridgeEnabled: true
    readonly routingConfigPresent: true
    readonly routingConfigValid: true
  }
  readonly credentialEnvs:
    readonly WorkspaceLiveCredentialStatus[]
  readonly semanticCacheEnabled: boolean
  readonly warnings:
    readonly 'semantic_cache_disabled'[]
}

export interface WorkspaceLivePreflightFailure {
  readonly kind: 'failed'
  readonly code:
    | WorkspaceLivePreflightCode
    | 'workspace_live_preflight_failed'
  readonly credentialEnvs?:
    readonly WorkspaceLiveCredentialStatus[]
}

export interface WorkspaceLivePreflightOptions {
  readonly cwd?: string
}

export interface RunWorkspaceLiveOptions
extends WorkspaceLivePreflightOptions {
  readonly writeLine: (
    line: string
  ) => void
  readonly startApplication: (
    env: Readonly<
      Record<
        string,
        string | undefined
      >
    >
  ) => Promise<unknown>
}

export class WorkspaceLivePreflightError
extends Error {
  constructor(
    readonly code:
      WorkspaceLivePreflightCode,
    readonly credentialEnvs?:
      readonly WorkspaceLiveCredentialStatus[]
  ) {
    super(code)
    this.name =
      'WorkspaceLivePreflightError'
  }
}

export function validateWorkspaceLivePreflight(
  env: Readonly<
    Record<string, string | undefined>
  >,
  options:
    WorkspaceLivePreflightOptions = {}
): WorkspaceLivePreflightReport {
  if (
    env.MC_AI_PROVIDER?.trim() !==
      'gemini'
  ) {
    throw new WorkspaceLivePreflightError(
      'provider_not_gemini'
    )
  }

  const aiConfig =
    loadAiConfigSafely(env)
  if (aiConfig.provider !== 'gemini') {
    throw new WorkspaceLivePreflightError(
      'provider_not_gemini'
    )
  }

  if (
    loadMinecraftServerIdentityMode(
      env
    ) !== 'online'
  ) {
    throw new WorkspaceLivePreflightError(
      'identity_mode_not_online'
    )
  }

  const minecraftConfig =
    loadMinecraftConfigSafely(env)
  if (
    minecraftConfig.auth !==
      'microsoft'
  ) {
    throw new WorkspaceLivePreflightError(
      'minecraft_auth_not_microsoft'
    )
  }

  const moxueBridgeConfig =
    loadMoxueBridgeConfigSafely(
      env
    )
  if (!moxueBridgeConfig.enabled) {
    throw new WorkspaceLivePreflightError(
      'moxuebridge_not_enabled'
    )
  }

  const routingFilename =
    resolve(
      options.cwd ?? process.cwd(),
      aiConfig.routingConfigPath
    )
  if (!existsSync(routingFilename)) {
    throw new WorkspaceLivePreflightError(
      'routing_config_missing'
    )
  }

  const routingConfig =
    readRoutingConfig(
      routingFilename
    )
  const credentialEnvs =
    credentialStatuses(
      routingConfig.projects.map(
        project =>
          project.apiKeyEnv
      ),
      env
    )
  if (
    credentialEnvs.some(
      credential =>
        !credential.set
    )
  ) {
    throw new WorkspaceLivePreflightError(
      'routing_credential_missing',
      credentialEnvs
    )
  }

  const semanticSecret =
    env
      .MC_WORKSPACE_SEMANTIC_MASTER_SECRET
  const semanticCacheEnabled =
    semanticSecret !== undefined &&
    semanticSecret.trim().length > 0

  if (semanticCacheEnabled) {
    try {
      const keys =
        deriveWorkspaceSemanticKeys(
          semanticSecret
        )
      keys.hmacKey.fill(0)
      keys.exportKey.fill(0)
    } catch {
      throw new WorkspaceLivePreflightError(
        'semantic_master_secret_invalid'
      )
    }
  }

  return {
    kind: 'ready',
    checks: {
      aiProvider: 'gemini',
      serverIdentityMode:
        'online',
      minecraftAuth:
        'microsoft',
      moxueBridgeEnabled: true,
      routingConfigPresent:
        true,
      routingConfigValid: true
    },
    credentialEnvs,
    semanticCacheEnabled,
    warnings:
      semanticCacheEnabled
        ? []
        : [
            'semantic_cache_disabled'
          ]
  }
}

export function formatWorkspaceLivePreflightFailure(
  error: unknown
): WorkspaceLivePreflightFailure {
  if (
    error instanceof
      WorkspaceLivePreflightError
  ) {
    return {
      kind: 'failed',
      code: error.code,
      ...(error.credentialEnvs ===
        undefined
        ? {}
        : {
            credentialEnvs:
              error.credentialEnvs
          })
    }
  }

  return {
    kind: 'failed',
    code:
      'workspace_live_preflight_failed'
  }
}

export async function runWorkspaceLive(
  env: Readonly<
    Record<string, string | undefined>
  >,
  options: RunWorkspaceLiveOptions
): Promise<void> {
  const report =
    validateWorkspaceLivePreflight(
      env,
      {
        ...(options.cwd === undefined
          ? {}
          : { cwd: options.cwd })
      }
    )

  options.writeLine(
    JSON.stringify(
      report,
      null,
      2
    )
  )
  await options.startApplication(env)
}

function loadAiConfigSafely(
  env: Readonly<
    Record<string, string | undefined>
  >
): ReturnType<typeof loadAiConfig> {
  try {
    return loadAiConfig(env)
  } catch {
    throw new WorkspaceLivePreflightError(
      'routing_config_invalid'
    )
  }
}

function loadMinecraftConfigSafely(
  env: Readonly<
    Record<string, string | undefined>
  >
): ReturnType<
  typeof loadMinecraftConfig
> {
  try {
    return loadMinecraftConfig(
      env as NodeJS.ProcessEnv
    )
  } catch {
    throw new WorkspaceLivePreflightError(
      'minecraft_config_invalid'
    )
  }
}

function loadMoxueBridgeConfigSafely(
  env: Readonly<
    Record<string, string | undefined>
  >
): ReturnType<
  typeof loadMoxueBridgeConfig
> {
  try {
    return loadMoxueBridgeConfig(
      env
    )
  } catch {
    throw new WorkspaceLivePreflightError(
      'moxuebridge_config_invalid'
    )
  }
}

function readRoutingConfig(
  filename: string
): ReturnType<
  typeof parseRoutingConfig
> {
  try {
    return parseRoutingConfig(
      JSON.parse(
        readFileSync(
          filename,
          'utf8'
        )
      )
    )
  } catch {
    throw new WorkspaceLivePreflightError(
      'routing_config_invalid'
    )
  }
}

function credentialStatuses(
  names: readonly string[],
  env: Readonly<
    Record<string, string | undefined>
  >
): WorkspaceLiveCredentialStatus[] {
  return [
    ...new Set(names)
  ].map(name => ({
    name,
    set:
      (env[name]?.trim()
        .length ?? 0) > 0
  }))
}

function isEntrypoint(): boolean {
  const script = process.argv[1]
  if (!script) return false
  return (
    import.meta.url ===
    pathToFileURL(
      resolve(script)
    ).href
  )
}

if (isEntrypoint()) {
  void runWorkspaceLive(
    process.env,
    {
      writeLine:
        line =>
          console.log(line),
      async startApplication(env) {
        const { runMain } =
          await import(
            '../src/main.js'
          )
        await runMain(env)
      }
    }
  ).catch(error => {
    console.error(
      JSON.stringify(
        formatWorkspaceLivePreflightFailure(
          error
        )
      )
    )
    process.exitCode = 1
  })
}
