import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseGameKnowledgePack,
  type GameKnowledgePack
} from './contracts.js'

interface PackMetadata {
  readonly schemaVersion: 1
  readonly edition: 'java'
  readonly minecraftVersion: string
}

const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

export class GameKnowledgeLoader {
  constructor(
    private readonly rootDirectory: string
  ) {}

  loadJavaVersion(version: string): GameKnowledgePack {
    if (!VERSION_PATTERN.test(version)) {
      throw new Error('knowledge_pack_invalid_version')
    }

    const directory = join(
      this.rootDirectory,
      'java',
      version
    )

    try {
      const metadata = readJson<PackMetadata>(
        join(directory, 'metadata.json')
      )

      if (
        metadata.schemaVersion !== 1 ||
        metadata.edition !== 'java' ||
        metadata.minecraftVersion !== version
      ) {
        throw new Error('knowledge_pack_version_mismatch')
      }

      return parseGameKnowledgePack({
        ...metadata,
        items: readJson(join(directory, 'items.json')),
        worldAcquisition: readJson(
          join(directory, 'world-acquisition.json')
        ),
        recipes: readJson(join(directory, 'recipes.json')),
        processing: readJson(join(directory, 'processing.json')),
        fuels: readJson(join(directory, 'fuels.json')),
        tools: readJson(join(directory, 'tools.json')),
        workstations: readJson(
          join(directory, 'workstations.json')
        )
      })
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'knowledge_pack_version_mismatch'
      ) {
        throw error
      }

      if (isMissingFileError(error)) {
        throw new Error(`knowledge_pack_missing:${version}`)
      }
      throw error
    }
  }
}

function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function isMissingFileError(
  error: unknown
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}
