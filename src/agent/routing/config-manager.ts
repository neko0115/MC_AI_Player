import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  parseRoutingConfig,
  type ValidatedRoutingConfig,
  type ValidatedRoutingProject
} from './config.js'

export interface ConfigGenerationAllocator {
  allocateConfigGeneration(): number
}

export interface RoutingProjectSnapshot {
  readonly projectKey: string
  readonly credentialHandle: string
  readonly providerLimits: ValidatedRoutingProject['providerLimits']
  readonly flashBudget: ValidatedRoutingProject['flashBudget']
}

export interface RoutingConfigSnapshot {
  readonly generation: number
  readonly models: ValidatedRoutingConfig['models']
  readonly projects: readonly RoutingProjectSnapshot[]
  readonly manualAccess: ValidatedRoutingConfig['manualAccess']
}

export type RoutingReloadResult =
  | {
      readonly kind: 'reloaded'
      readonly generation: number
      readonly authorizationChanged: boolean
    }
  | {
      readonly kind: 'rejected'
      readonly code: 'invalid_config' | 'missing_credential'
    }

interface RoutingConfigManagerOptions {
  readonly ledger: ConfigGenerationAllocator
  readonly env: Readonly<Record<string, string | undefined>>
  readonly routingConfigPath?: string
  readonly readConfig?: () => unknown
  readonly nextCredentialHandle?: () => string
}

interface PreparedProject {
  readonly project: ValidatedRoutingProject
  readonly credentialHandle: string
  readonly secret: string
}

interface PreparedConfig {
  readonly config: ValidatedRoutingConfig
  readonly projects: readonly PreparedProject[]
}

const DEFAULT_ROUTING_CONFIG_PATH = 'data/ai-routing.json'

export class RoutingConfigManager {
  private readonly readConfig: () => unknown
  private readonly nextCredentialHandle: () => string
  private readonly credentials = new Map<string, string>()
  private active: RoutingConfigSnapshot | null = null

  constructor(private readonly options: RoutingConfigManagerOptions) {
    const path = options.routingConfigPath ?? DEFAULT_ROUTING_CONFIG_PATH
    this.readConfig = options.readConfig ?? (() => {
      const text = readFileSync(path, 'utf8')
      return JSON.parse(text) as unknown
    })
    this.nextCredentialHandle = options.nextCredentialHandle ?? randomUUID
  }

  activateInitial(): RoutingConfigSnapshot {
    if (this.active !== null) {
      throw new Error('routing config is already active')
    }

    const raw = this.readConfig()
    let config: ValidatedRoutingConfig
    try {
      config = parseRoutingConfig(raw)
    } catch {
      throw new Error('invalid routing config')
    }

    const prepared = this.prepare(config)
    const generation = this.options.ledger.allocateConfigGeneration()
    const snapshot = this.commitPrepared(prepared, generation)
    this.active = snapshot
    return snapshot
  }

  reload(): RoutingReloadResult {
    if (this.active === null) {
      throw new Error('routing config is not active')
    }

    let config: ValidatedRoutingConfig
    try {
      config = parseRoutingConfig(this.readConfig())
    } catch {
      return { kind: 'rejected', code: 'invalid_config' }
    }

    let prepared: PreparedConfig
    try {
      prepared = this.prepare(config)
    } catch (error) {
      if (error instanceof MissingCredentialError) {
        return { kind: 'rejected', code: 'missing_credential' }
      }
      throw error
    }

    const authorizationChanged = !sameManualAccess(
      this.active.manualAccess,
      config.manualAccess
    )
    const generation = this.options.ledger.allocateConfigGeneration()
    const snapshot = this.commitPrepared(prepared, generation)
    this.active = snapshot
    return {
      kind: 'reloaded',
      generation,
      authorizationChanged
    }
  }

  snapshot(): RoutingConfigSnapshot {
    if (this.active === null) throw new Error('routing config is not active')
    return this.active
  }

  resolveCredential(handle: string): string {
    const secret = this.credentials.get(handle)
    if (!secret) throw new Error('unknown credential handle')
    return secret
  }

  private prepare(config: ValidatedRoutingConfig): PreparedConfig {
    const projects: PreparedProject[] = []
    for (const project of config.projects) {
      const secret = this.options.env[project.apiKeyEnv]?.trim()
      if (!secret) {
        throw new MissingCredentialError(project.apiKeyEnv)
      }
      projects.push({
        project,
        credentialHandle: this.nextCredentialHandle(),
        secret
      })
    }
    return { config, projects }
  }

  private commitPrepared(
    prepared: PreparedConfig,
    generation: number
  ): RoutingConfigSnapshot {
    for (const project of prepared.projects) {
      this.credentials.set(project.credentialHandle, project.secret)
    }

    const snapshot: RoutingConfigSnapshot = {
      generation,
      models: structuredClone(prepared.config.models),
      projects: prepared.projects.map(entry => ({
        projectKey: entry.project.projectKey,
        credentialHandle: entry.credentialHandle,
        providerLimits: structuredClone(entry.project.providerLimits),
        flashBudget: structuredClone(entry.project.flashBudget)
      })),
      manualAccess: structuredClone(prepared.config.manualAccess)
    }
    return deepFreeze(snapshot)
  }
}

class MissingCredentialError extends Error {
  constructor(envName: string) {
    super(`missing credential for ${envName}`)
  }
}

function sameManualAccess(
  left: ValidatedRoutingConfig['manualAccess'],
  right: ValidatedRoutingConfig['manualAccess']
): boolean {
  if (left.ownerUuid !== right.ownerUuid) return false
  const leftOperators = [...left.operatorAllowlistUuids].sort()
  const rightOperators = [...right.operatorAllowlistUuids].sort()
  return leftOperators.length === rightOperators.length &&
    leftOperators.every((value, index) => value === rightOperators[index])
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child)
  }
  return Object.freeze(value)
}
