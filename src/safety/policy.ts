import type { GoalRequest } from '../contracts/goals.js'
import { SkillNameSchema } from '../contracts/skills.js'
import type { WorldStateSnapshot } from '../state/world-state.js'

export type SafetyCapability = 'break_blocks' | 'place_blocks' | 'pvp'

export interface SkillSafetyMetadata {
  readonly capabilities?: readonly SafetyCapability[]
}

export interface SafetyThresholds {
  readonly minHealthForNonCritical: number
  readonly minFoodForNonCritical: number
}

export type SafetyDecision =
  | { kind: 'allow'; code: 'allowed' }
  | {
      kind: 'deny'
      code: 'unknown_skill' | 'minecraft_not_ready' | 'capability_not_declared' | 'pvp_disabled'
    }
  | {
      kind: 'preempt'
      code: 'minecraft_not_ready' | 'low_health' | 'low_food' | 'emergency_stop'
    }

export interface NavigationSafetyPolicy {
  readonly canDig: false
  readonly canPlaceBlocks: false
  readonly allowPvp: false
}

const DEFAULT_THRESHOLDS: SafetyThresholds = {
  minHealthForNonCritical: 6,
  minFoodForNonCritical: 6
}

const HARDENED_NAVIGATION_POLICY: NavigationSafetyPolicy = {
  canDig: false,
  canPlaceBlocks: false,
  allowPvp: false
}

export class SafetyPolicy {
  private readonly thresholds: SafetyThresholds

  constructor(thresholds: Partial<SafetyThresholds> = {}) {
    this.thresholds = {
      ...DEFAULT_THRESHOLDS,
      ...thresholds
    }
    validateThresholds(this.thresholds)
  }

  authorizeSkill(skillName: string, state: WorldStateSnapshot): SafetyDecision {
    if (!SkillNameSchema.safeParse(skillName).success) {
      return { kind: 'deny', code: 'unknown_skill' }
    }
    if (!state.connected || !state.spawned) {
      return { kind: 'deny', code: 'minecraft_not_ready' }
    }
    return { kind: 'allow', code: 'allowed' }
  }

  authorizeCapability(
    skillName: string,
    capability: SafetyCapability,
    metadata: SkillSafetyMetadata,
    state: WorldStateSnapshot
  ): SafetyDecision {
    const skillDecision = this.authorizeSkill(skillName, state)
    if (skillDecision.kind !== 'allow') {
      return skillDecision
    }

    if (capability === 'pvp') {
      return { kind: 'deny', code: 'pvp_disabled' }
    }

    if (!metadata.capabilities?.includes(capability)) {
      return { kind: 'deny', code: 'capability_not_declared' }
    }

    return { kind: 'allow', code: 'allowed' }
  }

  navigationPolicy(): NavigationSafetyPolicy {
    return HARDENED_NAVIGATION_POLICY
  }

  runtimeAction(state: WorldStateSnapshot, goal: GoalRequest): SafetyDecision {
    if (!state.connected || !state.spawned) {
      return { kind: 'preempt', code: 'minecraft_not_ready' }
    }

    if (!isSafetyGoal(goal) && state.health < this.thresholds.minHealthForNonCritical) {
      return { kind: 'preempt', code: 'low_health' }
    }

    if (!isSafetyGoal(goal) && state.food < this.thresholds.minFoodForNonCritical) {
      return { kind: 'preempt', code: 'low_food' }
    }

    return { kind: 'allow', code: 'allowed' }
  }

  emergencyStop(_state: WorldStateSnapshot): SafetyDecision {
    return { kind: 'preempt', code: 'emergency_stop' }
  }
}

function isSafetyGoal(goal: GoalRequest): boolean {
  return goal.kind === 'stay' || goal.kind === 'eat'
}

function validateThresholds(thresholds: SafetyThresholds): void {
  if (
    !Number.isFinite(thresholds.minHealthForNonCritical) ||
    thresholds.minHealthForNonCritical < 0 ||
    thresholds.minHealthForNonCritical > 40
  ) {
    throw new RangeError('minHealthForNonCritical must be between 0 and 40')
  }

  if (
    !Number.isFinite(thresholds.minFoodForNonCritical) ||
    thresholds.minFoodForNonCritical < 0 ||
    thresholds.minFoodForNonCritical > 20
  ) {
    throw new RangeError('minFoodForNonCritical must be between 0 and 20')
  }
}
