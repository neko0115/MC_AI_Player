import type {
  HostileSnapshot,
  ItemStackSnapshot,
  PlayerSnapshot,
  Position,
  RuntimeEvent
} from '../contracts/events.js'

export interface WorldStateSnapshot {
  connected: boolean
  spawned: boolean
  health: number
  food: number
  dimension: string | null
  position: Position | null
  nearbyPlayers: ReadonlyArray<PlayerSnapshot>
  nearbyHostiles?: ReadonlyArray<HostileSnapshot>
  inventory: ReadonlyArray<ItemStackSnapshot>
  recentEvents: ReadonlyArray<RuntimeEvent>
}
