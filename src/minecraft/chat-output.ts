import type { Bot } from 'mineflayer'

export type MinecraftChatOutputResult =
  | {
      readonly status: 'sent'
    }
  | {
      readonly status: 'failed'
      readonly code:
        | 'minecraft_not_ready'
        | 'invalid_chat_message'
        | 'chat_send_failed'
    }

export interface MinecraftChatOutput {
  sendMessage(
    message: string
  ): MinecraftChatOutputResult
}

const MAX_CHAT_MESSAGE_LENGTH = 256

export class MineflayerChatOutput
implements MinecraftChatOutput {
  constructor(
    private readonly readyBot:
      () => Bot | null
  ) {}

  sendMessage(
    message: string
  ): MinecraftChatOutputResult {
    const normalized =
      normalizeMessage(message)
    if (normalized === null) {
      return {
        status: 'failed',
        code: 'invalid_chat_message'
      }
    }

    const bot = this.readyBot()
    if (!bot) {
      return {
        status: 'failed',
        code: 'minecraft_not_ready'
      }
    }

    try {
      bot.chat(normalized)
      return {
        status: 'sent'
      }
    } catch {
      return {
        status: 'failed',
        code: 'chat_send_failed'
      }
    }
  }
}

function normalizeMessage(
  value: string
): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim()
  if (
    normalized.length < 1 ||
    normalized.length >
      MAX_CHAT_MESSAGE_LENGTH ||
    normalized.startsWith('/') ||
    /[\r\n\u0000-\u001f\u007f]/u
      .test(normalized)
  ) {
    return null
  }

  return normalized
}
