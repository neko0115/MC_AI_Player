import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  deriveWorkspaceSemanticKeys
} from '../src/workspace/learned-intent-export.js'
import {
  SqliteLearnedWorkspaceIntentCache
} from '../src/workspace/learned-intent-cache.js'
import {
  GitCliWorkspaceSemanticTransport,
  WorkspaceSemanticGitSync,
  WorkspaceSemanticGitSyncError
} from '../src/workspace/learned-intent-git-sync.js'

const DEFAULT_CACHE =
  'data/workspace-semantic-cache.sqlite3'

type SyncCommand =
  | 'pull'
  | 'push'

function run(
  argv: readonly string[],
  env: Readonly<
    Record<string, string | undefined>
  >
): void {
  const command =
    parseCommand(argv)
  const secret =
    env
      .MC_WORKSPACE_SEMANTIC_MASTER_SECRET
      ?.trim()
  if (!secret) {
    fail(
      'semantic_master_secret_missing'
    )
    return
  }

  let keys:
    ReturnType<
      typeof deriveWorkspaceSemanticKeys
    >
  try {
    keys =
      deriveWorkspaceSemanticKeys(
        secret
      )
  } catch {
    fail(
      'semantic_master_secret_invalid'
    )
    return
  }

  const cwd = process.cwd()
  const cacheFilename =
    resolve(
      cwd,
      DEFAULT_CACHE
    )
  mkdirSync(
    dirname(cacheFilename),
    { recursive: true }
  )

  const cache =
    new SqliteLearnedWorkspaceIntentCache(
      cacheFilename,
      {
        hmacKey:
          keys.hmacKey
      }
    )

  try {
    const transport =
      new GitCliWorkspaceSemanticTransport({
        cwd
      })
    const sync =
      new WorkspaceSemanticGitSync({
        cache,
        exportKey:
          keys.exportKey,
        transport
      })

    const result =
      command === 'pull'
        ? sync.pull()
        : sync.push()

    console.log(
      JSON.stringify(
        {
          command,
          ...result
        },
        null,
        2
      )
    )
  } catch (error) {
    if (
      error instanceof
        WorkspaceSemanticGitSyncError
    ) {
      fail(error.code)
      return
    }
    fail('workspace_semantic_sync_failed')
  } finally {
    cache.close()
    keys.hmacKey.fill(0)
    keys.exportKey.fill(0)
  }
}

function parseCommand(
  argv: readonly string[]
): SyncCommand {
  const command =
    argv[0]?.trim()
  if (
    command !== 'pull' &&
    command !== 'push'
  ) {
    throw new Error(
      'usage: sync-workspace-semantic <pull|push>'
    )
  }
  if (argv.length !== 1) {
    throw new Error(
      'usage: sync-workspace-semantic <pull|push>'
    )
  }
  return command
}

function fail(
  code: string
): void {
  console.error(
    JSON.stringify({
      kind: 'failed',
      code
    })
  )
  process.exitCode = 1
}

function isEntrypoint(): boolean {
  const script =
    process.argv[1]
  if (!script) return false
  return (
    import.meta.url ===
    pathToFileURL(
      resolve(script)
    ).href
  )
}

if (isEntrypoint()) {
  try {
    run(
      process.argv.slice(2),
      process.env
    )
  } catch {
    fail(
      'workspace_semantic_sync_invalid_arguments'
    )
  }
}
