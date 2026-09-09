import type { ItemStackSnapshot, PlayerSnapshot, RuntimeEvent } from '../contracts/events.js'
import type { WorldStateSnapshot } from './world-state.js'

export interface WorldStateCacheOptions {
  maxRecentEvents: number
}

export class WorldStateCache {
  private connected = false
  private spawned = false
  private health = 0
  private food = 0
  private dimension: string | null = null
  private position: { x: number; y: number; z: number } | null = null
  private readonly nearbyPlayers = new Map<string, PlayerSnapshot>()
  private inventory: ItemStackSnapshot[] = []
  private readonly recentEvents: RuntimeEvent[] = []

  constructor(private readonly options: WorldStateCacheOptions) {
    if (!Number.isInteger(options.maxRecentEvents) || options.maxRecentEvents < 1) {
      throw new RangeError('maxRecentEvents must be a positive integer')
    }
  }

  apply(event: RuntimeEvent): void {
    this.recentEvents.push(structuredClone(event))
    while (this.recentEvents.length > this.options.maxRecentEvents) {
      this.recentEvents.shift()
    }

    switch (event.type) {
      case 'connected':
        this.connected = true
        break
      case 'spawned':
        this.connected = true
        this.spawned = true
        this.dimension = event.dimension
        this.position = structuredClone(event.position)
        this.health = event.health
        this.food = event.food
        break
      case 'player_seen': {
        const key = event.player.id ? `id:${event.player.id}` : `name:${event.player.name}`
        this.nearbyPlayers.set(key, structuredClone(event.player))
        break
      }
      case 'health_changed':
        this.health = event.health
        this.food = event.food
        break
      case 'inventory_changed':
        this.inventory = structuredClone(event.items)
        break
      case 'disconnected':
        this.connected = false
        this.spawned = false
        this.health = 0
        this.food = 0
        this.dimension = null
        this.position = null
        this.nearbyPlayers.clear()
        this.inventory = []
        break
      default:
        break
    }
  }

  snapshot(): WorldStateSnapshot {
    return {
      connected: this.connected,
      spawned: this.spawned,
      health: this.health,
      food: this.food,
      dimension: this.dimension,
      position: this.position ? structuredClone(this.position) : null,
      nearbyPlayers: [...this.nearbyPlayers.values()].map(player => structuredClone(player)),
      inventory: this.inventory.map(item => structuredClone(item)),
      recentEvents: this.recentEvents.map(event => structuredClone(event))
    }
  }
}
