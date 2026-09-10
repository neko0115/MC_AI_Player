import type { Position } from '../contracts/events.js'
import type { GoalRequest } from '../contracts/goals.js'
import type { SkillDefinition, SkillResult } from '../contracts/skills.js'
import type { MinecraftAdapter } from '../minecraft/adapter.js'
import type { ResourceNavigationAdapter } from '../minecraft/gathering.js'

type ArgsFor<K extends GoalRequest['kind']> = Extract<GoalRequest, { kind: K }>['args']
type StopArgs = Record<string, never>

export interface NavigationSkillSet {
  readonly goTo: SkillDefinition<ArgsFor<'go_to'>>
  readonly followPlayer: SkillDefinition<ArgsFor<'follow_player'>>
  readonly stay: SkillDefinition<ArgsFor<'stay'>>
  readonly stop: SkillDefinition<StopArgs>
}

export interface HomeResolver {
  resolveHome(): Position | null | Promise<Position | null>
}

export class ReturnHomeSkill implements SkillDefinition<ArgsFor<'return_home'>> {
  readonly name = 'return_home' as const

  constructor(
    private readonly navigation: ResourceNavigationAdapter,
    private readonly homes: HomeResolver
  ) {}

  async execute(
    { signal }: { signal: AbortSignal },
    _args: ArgsFor<'return_home'>
  ): Promise<SkillResult> {
    if (signal.aborted) return cancelled(signal)

    let home: Position | null
    try {
      home = await this.homes.resolveHome()
    } catch {
      return { status: 'failed', code: 'home_resolution_failed' }
    }
    if (signal.aborted) return cancelled(signal)
    if (!home) return { status: 'failed', code: 'home_not_found' }

    return this.navigation.goTo(
      { ...home },
      { range: 1, canDig: false },
      signal
    )
  }
}

export function createNavigationSkills(adapter: MinecraftAdapter): NavigationSkillSet {
  return {
    goTo: {
      name: 'go_to',
      execute({ signal }, args) {
        return adapter.goTo(
          { x: args.x, y: args.y, z: args.z },
          {
            range: args.radius ?? 1,
            canDig: false
          },
          signal
        )
      }
    },
    followPlayer: {
      name: 'follow_player',
      execute({ signal }, args) {
        return adapter.followPlayer(args.player, args.range ?? 3, signal)
      }
    },
    stay: {
      name: 'stay',
      execute({ signal }) {
        return adapter.holdPosition(signal)
      }
    },
    stop: {
      name: 'stop',
      async execute() {
        await adapter.stopMotion()
        return { status: 'succeeded', code: 'stopped' }
      }
    }
  }
}

function cancelled(signal: AbortSignal): SkillResult {
  const reason = typeof signal.reason === 'string' ? signal.reason.trim() : ''
  return {
    status: 'cancelled',
    code: reason ? reason.replace(/\s+/g, '_').slice(0, 128) : 'cancelled'
  }
}
