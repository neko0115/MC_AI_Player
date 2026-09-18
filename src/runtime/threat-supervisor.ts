import type { RuntimeEvent, HostileSnapshot, Position } from '../contracts/events.js'
import type { GoalRecord } from '../contracts/goals.js'
import type { SkillResult } from '../contracts/skills.js'
import type { WorldStateSnapshot } from '../state/world-state.js'

export interface ThreatEventSource {
  subscribe(
    listener: (event: RuntimeEvent) => void | Promise<void>
  ): () => void
}

export interface ThreatStateSource {
  snapshot(): WorldStateSnapshot
}

export interface ThreatGoalController {
  activeGoal(): GoalRecord | null
  suspendActive(reason?: string): Promise<boolean>
  resumeSuspended(): Promise<boolean>
}

export interface ThreatNavigation {
  goTo(
    position: Position,
    options: { readonly range: number; readonly canDig: false },
    signal: AbortSignal
  ): Promise<SkillResult>
}

export interface ThreatSupervisorOptions {
  readonly events: ThreatEventSource
  readonly state: ThreatStateSource
  readonly goals: ThreatGoalController
  readonly navigation: ThreatNavigation
  readonly now?: () => number
  readonly retryCooldownMs?: number
}

interface ActiveThreat {
  readonly hostile: HostileSnapshot
  readonly distance: number
  readonly triggerDistance: number
  readonly retreatDistance: number
}

const RANGED_HOSTILES = new Set([
  'blaze',
  'bogged',
  'elder_guardian',
  'evoker',
  'ghast',
  'guardian',
  'pillager',
  'shulker',
  'skeleton',
  'stray',
  'witch',
  'wither',
  'wither_skeleton'
])

const DEFAULT_RETRY_COOLDOWN_MS = 1000
const LOW_HEALTH = 10
const LOW_HEALTH_THREAT_DISTANCE = 16
const CLEARANCE_MARGIN = 4

export class ThreatSupervisor {
  private readonly now: () => number
  private readonly retryCooldownMs: number
  private unsubscribe: (() => void) | null = null
  private mailboxTail: Promise<void> = Promise.resolve()
  private responseActive = false
  private responding = false
  private suspendedGoalId: string | null = null
  private lastAttemptAt = Number.NEGATIVE_INFINITY
  private retreatController: AbortController | null = null
  private disposed = false

  constructor(private readonly options: ThreatSupervisorOptions) {
    this.now = options.now ?? Date.now
    this.retryCooldownMs = options.retryCooldownMs ?? DEFAULT_RETRY_COOLDOWN_MS
    if (
      !Number.isFinite(this.retryCooldownMs) ||
      this.retryCooldownMs < 0
    ) {
      throw new RangeError('retryCooldownMs must be a non-negative finite number')
    }
  }

  start(): void {
    if (this.unsubscribe || this.disposed) return
    this.unsubscribe = this.options.events.subscribe(event => {
      if (!isThreatRelevantEvent(event)) return
      this.mailboxTail = this.mailboxTail
        .then(() => this.evaluate(event))
        .catch(() => {
          // Survival supervision must fail closed without poisoning later
          // observations or leaking dependency errors.
        })
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe?.()
    this.unsubscribe = null
    this.retreatController?.abort('supervisor_disposed')
    this.retreatController = null
  }

  private async evaluate(event: RuntimeEvent): Promise<void> {
    if (this.disposed) return

    if (event.type === 'disconnected') {
      this.responseActive = false
      this.responding = false
      this.suspendedGoalId = null
      this.retreatController?.abort('minecraft_disconnected')
      this.retreatController = null
      return
    }

    const state = this.options.state.snapshot()
    if (!state.connected || !state.spawned || !state.position) return

    const threat = selectThreat(state, this.responseActive)
    if (!threat) {
      await this.clearThreatResponse()
      return
    }

    if (!this.responseActive) {
      this.responseActive = true
      const active = this.options.goals.activeGoal()
      if (
        active?.status === 'running' &&
        await this.options.goals.suspendActive('threat_suspended')
      ) {
        this.suspendedGoalId = active.goalId
      }
    }

    if (this.responding) return
    if (this.now() - this.lastAttemptAt < this.retryCooldownMs) return

    await this.retreat(state.position, threat)
  }

  private async clearThreatResponse(): Promise<void> {
    if (!this.responseActive) return

    this.responseActive = false
    this.responding = false
    this.retreatController?.abort('threat_cleared')
    this.retreatController = null

    const suspendedGoalId = this.suspendedGoalId
    this.suspendedGoalId = null
    if (!suspendedGoalId) return

    const active = this.options.goals.activeGoal()
    if (
      active?.goalId === suspendedGoalId &&
      active.status === 'suspended'
    ) {
      await this.options.goals.resumeSuspended()
    }
  }

  private async retreat(
    current: Position,
    threat: ActiveThreat
  ): Promise<void> {
    this.responding = true
    this.lastAttemptAt = this.now()
    const controller = new AbortController()
    this.retreatController = controller

    try {
      for (const target of retreatTargets(
        current,
        threat.hostile.position,
        threat.retreatDistance
      )) {
        if (controller.signal.aborted) return
        const result = await this.options.navigation.goTo(
          target,
          { range: 1, canDig: false },
          controller.signal
        )
        if (result.status === 'cancelled') return
        if (result.status === 'succeeded') return
      }
    } finally {
      if (this.retreatController === controller) {
        this.retreatController = null
      }
      this.responding = false
    }
  }
}

function selectThreat(
  state: WorldStateSnapshot,
  clearing: boolean
): ActiveThreat | null {
  const self = state.position
  if (!self) return null

  let selected: ActiveThreat | null = null
  for (const hostile of state.nearbyHostiles ?? []) {
    const distance = euclideanDistance(self, hostile.position)
    const triggerDistance = threatDistance(
      hostile.kind,
      state.health
    )
    const effectiveDistance =
      clearing
        ? triggerDistance + CLEARANCE_MARGIN
        : triggerDistance

    if (distance > effectiveDistance) continue

    const candidate: ActiveThreat = {
      hostile,
      distance,
      triggerDistance,
      retreatDistance: retreatDistance(hostile.kind)
    }

    if (
      selected === null ||
      threatPriority(candidate) > threatPriority(selected)
    ) {
      selected = candidate
    }
  }
  return selected
}

function threatDistance(kind: string, health: number): number {
  let distance = 8
  if (kind === 'creeper') distance = 10
  else if (kind === 'warden') distance = 24
  else if (kind === 'ghast') distance = 20
  else if (RANGED_HOSTILES.has(kind)) distance = 14

  if (health <= LOW_HEALTH) {
    distance = Math.max(distance, LOW_HEALTH_THREAT_DISTANCE)
  }
  return distance
}

function retreatDistance(kind: string): number {
  if (kind === 'warden') return 18
  if (kind === 'ghast') return 16
  if (kind === 'creeper') return 14
  if (RANGED_HOSTILES.has(kind)) return 12
  return 10
}

function threatPriority(threat: ActiveThreat): number {
  const proximity =
    (threat.triggerDistance - threat.distance) /
    Math.max(1, threat.triggerDistance)

  const typeWeight =
    threat.hostile.kind === 'creeper'
      ? 3
      : threat.hostile.kind === 'warden'
        ? 4
        : RANGED_HOSTILES.has(threat.hostile.kind)
          ? 2
          : 1

  return typeWeight + proximity
}

function retreatTargets(
  self: Position,
  threat: Position,
  distance: number
): Position[] {
  let dx = self.x - threat.x
  let dz = self.z - threat.z
  const length = Math.hypot(dx, dz)
  if (length < 0.001) {
    dx = 1
    dz = 0
  } else {
    dx /= length
    dz /= length
  }

  const px = -dz
  const pz = dx
  const forward = distance
  const diagonalForward = distance * 0.75
  const diagonalSide = distance * 0.65

  return [
    integerTarget(
      self.x + dx * forward,
      self.y,
      self.z + dz * forward
    ),
    integerTarget(
      self.x + dx * diagonalForward + px * diagonalSide,
      self.y,
      self.z + dz * diagonalForward + pz * diagonalSide
    ),
    integerTarget(
      self.x + dx * diagonalForward - px * diagonalSide,
      self.y,
      self.z + dz * diagonalForward - pz * diagonalSide
    )
  ]
}

function integerTarget(
  x: number,
  y: number,
  z: number
): Position {
  return {
    x: Math.round(x),
    y: Math.round(y),
    z: Math.round(z)
  }
}

function euclideanDistance(a: Position, b: Position): number {
  return Math.hypot(
    a.x - b.x,
    a.y - b.y,
    a.z - b.z
  )
}

function isThreatRelevantEvent(event: RuntimeEvent): boolean {
  return (
    event.type === 'hostile_seen' ||
    event.type === 'hostile_left' ||
    event.type === 'position_changed' ||
    event.type === 'health_changed' ||
    event.type === 'spawned' ||
    event.type === 'disconnected'
  )
}
