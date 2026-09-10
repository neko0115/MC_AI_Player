import type { GoalRequest } from '../contracts/goals.js'
import type { SkillDefinition } from '../contracts/skills.js'
import type { MinecraftAdapter } from '../minecraft/adapter.js'

type ArgsFor<K extends GoalRequest['kind']> = Extract<GoalRequest, { kind: K }>['args']
type StopArgs = Record<string, never>

export interface NavigationSkillSet {
  readonly goTo: SkillDefinition<ArgsFor<'go_to'>>
  readonly followPlayer: SkillDefinition<ArgsFor<'follow_player'>>
  readonly stay: SkillDefinition<ArgsFor<'stay'>>
  readonly stop: SkillDefinition<StopArgs>
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
