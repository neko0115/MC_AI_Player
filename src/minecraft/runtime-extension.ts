import type { Bot } from 'mineflayer'
import type { RuntimePortRegistry } from './runtime-ports.js'

const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

export interface MineflayerRuntimeExtensionContext {
  readonly readyBot: () => Bot | null
  readonly ports: RuntimePortRegistry
}

export interface MineflayerRuntimeExtension {
  readonly id: string
  install(context: MineflayerRuntimeExtensionContext): void
}

export function installMineflayerRuntimeExtensions(
  context: MineflayerRuntimeExtensionContext,
  extensions: readonly MineflayerRuntimeExtension[]
): void {
  const ids = new Set<string>()

  for (const extension of extensions) {
    if (!EXTENSION_ID_PATTERN.test(extension.id)) {
      throw new Error(
        `invalid Mineflayer runtime extension id: ${extension.id}`
      )
    }
    if (ids.has(extension.id)) {
      throw new Error(
        `duplicate Mineflayer runtime extension id: ${extension.id}`
      )
    }
    ids.add(extension.id)
  }

  for (const extension of extensions) {
    extension.install(context)
  }
}
