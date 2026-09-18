import type { RuntimeEvent } from '../contracts/events.js'

interface VecLike {
  x: number
  y: number
  z: number
}

interface InventoryItemLike {
  name: string
  count: number
  slot?: number
}

export interface ObservationBotView {
  game: { dimension: string }
  entity: { position: VecLike }
  health: number
  food: number
  inventory: { items(): InventoryItemLike[] }
}

export interface ObservationPlayerView {
  username: string
  uuid?: string
  entity?: { position: VecLike } | null | undefined
}

export interface ObservationHostileView {
  id: number
  name: string
  position: VecLike
}

export class ObservationBridge {
  constructor(private readonly now: () => number = Date.now) {}

  connected(): RuntimeEvent {
    return { type: 'connected', at: this.now() }
  }

  spawned(bot: ObservationBotView): RuntimeEvent {
    return {
      type: 'spawned',
      at: this.now(),
      dimension: bot.game.dimension,
      position: position(bot.entity.position),
      health: bot.health,
      food: bot.food
    }
  }

  playerSeen(player: ObservationPlayerView): RuntimeEvent | null {
    if (!player.entity) {
      return null
    }
    const id = player.uuid?.trim()
    return {
      type: 'player_seen',
      at: this.now(),
      player: {
        name: player.username,
        ...(id ? { id } : {}),
        position: position(player.entity.position)
      }
    }
  }

  hostileSeen(hostile: ObservationHostileView): RuntimeEvent {
    return {
      type: 'hostile_seen',
      at: this.now(),
      hostile: {
        entityId: hostile.id,
        kind: hostile.name.slice(0, 128),
        position: position(hostile.position)
      }
    }
  }

  hostileLeft(entityId: number): RuntimeEvent {
    return {
      type: 'hostile_left',
      at: this.now(),
      entityId
    }
  }

  playerLeft(username: string, playerId?: string): RuntimeEvent {
    const id = boundedPlayerId(playerId)
    return {
      type: 'player_left',
      at: this.now(),
      player: username.slice(0, 64),
      ...(id ? { playerId: id } : {})
    }
  }

  chat(username: string, message: string, playerId?: string): RuntimeEvent {
    const id = boundedPlayerId(playerId)
    return {
      type: 'player_chat',
      at: this.now(),
      player: username.slice(0, 64),
      ...(id ? { playerId: id } : {}),
      message: message.slice(0, 1000)
    }
  }

  health(bot: Pick<ObservationBotView, 'health' | 'food'>): RuntimeEvent {
    return {
      type: 'health_changed',
      at: this.now(),
      health: bot.health,
      food: bot.food
    }
  }

  inventory(bot: Pick<ObservationBotView, 'inventory'>): RuntimeEvent {
    return {
      type: 'inventory_changed',
      at: this.now(),
      items: bot.inventory.items().slice(0, 256).map(item => ({
        name: item.name.slice(0, 128),
        count: item.count,
        ...(Number.isInteger(item.slot) && (item.slot ?? -1) >= 0 ? { slot: item.slot } : {})
      }))
    }
  }

  kicked(reason: string): RuntimeEvent {
    return {
      type: 'adapter_error',
      at: this.now(),
      code: 'kicked',
      message: reason.slice(0, 500)
    }
  }

  error(error: Error): RuntimeEvent {
    return {
      type: 'adapter_error',
      at: this.now(),
      code: 'error',
      message: error.message.slice(0, 500)
    }
  }

  reconnectExhausted(): RuntimeEvent {
    return {
      type: 'adapter_error',
      at: this.now(),
      code: 'reconnect_exhausted',
      message: 'automatic reconnect attempts exhausted'
    }
  }

  ended(reason: string): RuntimeEvent {
    return {
      type: 'disconnected',
      at: this.now(),
      reason: reason.slice(0, 500)
    }
  }
}

function position(value: VecLike): { x: number; y: number; z: number } {
  return { x: value.x, y: value.y, z: value.z }
}

function boundedPlayerId(value: string | undefined): string | null {
  const normalized = value?.trim().slice(0, 128) ?? ''
  return normalized || null
}
