import type { MinecraftServerIdentityMode } from '../config.js'

export type MinecraftAiCapability =
  | 'manual_deep_think'
  | 'flash_reserve_access'

export type MinecraftPrincipal =
  | {
      readonly kind: 'minecraft_untrusted'
      readonly capabilities: readonly []
    }
  | {
      readonly kind: 'minecraft_operator' | 'minecraft_owner'
      readonly capabilities: readonly [
        'manual_deep_think',
        'flash_reserve_access'
      ]
    }

export interface MinecraftManualAccessPolicy {
  readonly ownerUuid: string
  readonly operatorAllowlistUuids: readonly string[]
}

export interface ResolveMinecraftChatInput {
  readonly mode: MinecraftServerIdentityMode
  readonly player: string
  readonly playerId?: string
  readonly policy: MinecraftManualAccessPolicy
}

const UNTRUSTED: MinecraftPrincipal = Object.freeze({
  kind: 'minecraft_untrusted',
  capabilities: Object.freeze([])
})

const PRIVILEGED_CAPABILITIES = Object.freeze([
  'manual_deep_think',
  'flash_reserve_access'
] as const)

export function normalizeMinecraftUuid(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase().replaceAll('-', '') ?? ''
  return /^[0-9a-f]{32}$/.test(normalized) ? normalized : null
}

export class MinecraftIdentityRegistry {
  private readonly players = new Map<string, string>()
  private active = false
  private generation = 0

  beginSession(): number {
    this.generation += 1
    this.active = true
    this.players.clear()
    return this.generation
  }

  endSession(): void {
    this.active = false
    this.players.clear()
  }

  currentSessionGeneration(): number {
    return this.generation
  }

  observePlayer(player: string, playerId: string | undefined): void {
    if (!this.active) return
    const name = normalizePlayerName(player)
    const id = normalizeMinecraftUuid(playerId)
    if (!name || !id) return
    this.players.set(name, id)
  }

  removePlayer(player: string, playerId?: string): void {
    const name = normalizePlayerName(player)
    if (!name) return

    const current = this.players.get(name)
    if (current === undefined) return

    const supplied = normalizeMinecraftUuid(playerId)
    if (supplied !== null && supplied !== current) {
      this.players.delete(name)
      return
    }
    this.players.delete(name)
  }

  resolveChat(input: ResolveMinecraftChatInput): MinecraftPrincipal {
    if (input.mode !== 'online' || !this.active) return UNTRUSTED

    const player = normalizePlayerName(input.player)
    const currentId = normalizeMinecraftUuid(input.playerId)
    if (!player || !currentId) return UNTRUSTED

    const cachedId = this.players.get(player)
    if (!cachedId || cachedId !== currentId) return UNTRUSTED

    const ownerId = normalizeMinecraftUuid(input.policy.ownerUuid)
    if (ownerId && currentId === ownerId) {
      return privileged('minecraft_owner')
    }

    for (const candidate of input.policy.operatorAllowlistUuids) {
      if (normalizeMinecraftUuid(candidate) === currentId) {
        return privileged('minecraft_operator')
      }
    }

    return UNTRUSTED
  }
}

function privileged(
  kind: 'minecraft_owner' | 'minecraft_operator'
): MinecraftPrincipal {
  return Object.freeze({
    kind,
    capabilities: PRIVILEGED_CAPABILITIES
  })
}

function normalizePlayerName(value: string): string | null {
  const normalized = value.trim()
  if (normalized.length < 1 || normalized.length > 64) return null
  return normalized
}
