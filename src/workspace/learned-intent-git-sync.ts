import {
  spawnSync
} from 'node:child_process'
import type {
  LearnedWorkspaceIntentCache,
  LearnedWorkspaceIntentSnapshot
} from './learned-intent-cache.js'
import {
  decryptWorkspaceIntentSnapshot,
  encryptWorkspaceIntentSnapshot
} from './learned-intent-export.js'

const DEFAULT_REMOTE = 'origin'
const DEFAULT_BRANCH =
  'workspace-semantic-cache'
const DEFAULT_ARTIFACT =
  'workspace-semantic-cache.enc'
const DEFAULT_COMMIT_MESSAGE =
  'sync: workspace semantic cache'
const DEFAULT_MAX_PUSH_ATTEMPTS = 3

export class WorkspaceSemanticGitSyncError
extends Error {
  constructor(
    readonly code:
      | 'git_remote_unavailable'
      | 'git_read_failed'
      | 'git_publish_failed'
      | 'remote_decrypt_failed'
      | 'remote_import_failed'
      | 'concurrent_update'
  ) {
    super(code)
    this.name =
      'WorkspaceSemanticGitSyncError'
  }
}

export interface WorkspaceSemanticRemoteArtifact {
  readonly commitSha: string
  readonly envelope: string
}

export interface WorkspaceSemanticPublishInput {
  readonly parentCommitSha: string | null
  readonly envelope: string
}

export type WorkspaceSemanticPublishResult =
  | {
      readonly kind: 'pushed'
      readonly commitSha: string
    }
  | {
      readonly kind: 'conflict'
    }

export interface WorkspaceSemanticGitTransport {
  fetch():
    WorkspaceSemanticRemoteArtifact | null
  publish(
    input: WorkspaceSemanticPublishInput
  ): WorkspaceSemanticPublishResult
}

export interface GitCliWorkspaceSemanticTransportOptions {
  readonly cwd: string
  readonly remote?: string
  readonly branch?: string
  readonly artifactPath?: string
  readonly commitMessage?: string
}

export interface WorkspaceSemanticGitSyncOptions {
  readonly cache:
    LearnedWorkspaceIntentCache
  readonly exportKey: string | Buffer
  readonly transport:
    WorkspaceSemanticGitTransport
  readonly maxPushAttempts?: number
}

export type WorkspaceSemanticPullResult =
  | {
      readonly kind: 'remote_missing'
    }
  | {
      readonly kind: 'pulled'
      readonly remoteCommitSha: string
      readonly merged: number
      readonly skipped: number
      readonly localRecordCount: number
    }

export type WorkspaceSemanticPushResult =
  | {
      readonly kind: 'no_change'
      readonly remoteCommitSha:
        string | null
      readonly merged: number
      readonly skipped: number
      readonly localRecordCount: number
    }
  | {
      readonly kind: 'pushed'
      readonly commitSha: string
      readonly merged: number
      readonly skipped: number
      readonly localRecordCount: number
    }

export class WorkspaceSemanticGitSync {
  private readonly exportKey: Buffer
  private readonly maxPushAttempts:
    number

  constructor(
    private readonly options:
      WorkspaceSemanticGitSyncOptions
  ) {
    this.exportKey =
      normalizeExportKey(
        options.exportKey
      )
    this.maxPushAttempts =
      options.maxPushAttempts ??
      DEFAULT_MAX_PUSH_ATTEMPTS

    if (
      !Number.isInteger(
        this.maxPushAttempts
      ) ||
      this.maxPushAttempts < 1 ||
      this.maxPushAttempts > 10
    ) {
      throw new RangeError(
        'maxPushAttempts must be an integer between 1 and 10'
      )
    }
  }

  pull(): WorkspaceSemanticPullResult {
    const remote =
      this.options.transport.fetch()
    if (!remote) {
      return {
        kind: 'remote_missing'
      }
    }

    const imported =
      this.importRemote(remote)
    const snapshot =
      this.options.cache
        .exportSnapshot()

    return {
      kind: 'pulled',
      remoteCommitSha:
        remote.commitSha,
      merged: imported.merged,
      skipped: imported.skipped,
      localRecordCount:
        snapshot.records.length
    }
  }

  push(): WorkspaceSemanticPushResult {
    let merged = 0
    let skipped = 0

    for (
      let attempt = 0;
      attempt <
        this.maxPushAttempts;
      attempt += 1
    ) {
      const remote =
        this.options.transport.fetch()
      let remoteSnapshot:
        LearnedWorkspaceIntentSnapshot |
        null = null

      if (remote) {
        const imported =
          this.importRemote(
            remote
          )
        merged += imported.merged
        skipped += imported.skipped
        remoteSnapshot =
          imported.snapshot
      }

      const localSnapshot =
        this.options.cache
          .exportSnapshot()

      if (
        remoteSnapshot !== null &&
        snapshotContentEquals(
          localSnapshot,
          remoteSnapshot
        )
      ) {
        return {
          kind: 'no_change',
          remoteCommitSha:
            remote?.commitSha ??
            null,
          merged,
          skipped,
          localRecordCount:
            localSnapshot.records.length
        }
      }

      if (
        remoteSnapshot === null &&
        localSnapshot.records.length ===
          0
      ) {
        return {
          kind: 'no_change',
          remoteCommitSha: null,
          merged,
          skipped,
          localRecordCount: 0
        }
      }

      const envelope =
        encryptWorkspaceIntentSnapshot(
          localSnapshot,
          this.exportKey
        )
      const published =
        this.options.transport
          .publish({
            parentCommitSha:
              remote?.commitSha ??
              null,
            envelope
          })

      if (
        published.kind ===
        'pushed'
      ) {
        return {
          kind: 'pushed',
          commitSha:
            published.commitSha,
          merged,
          skipped,
          localRecordCount:
            localSnapshot.records.length
        }
      }
    }

    throw new WorkspaceSemanticGitSyncError(
      'concurrent_update'
    )
  }

  private importRemote(
    remote:
      WorkspaceSemanticRemoteArtifact
  ): {
    readonly snapshot:
      LearnedWorkspaceIntentSnapshot
    readonly merged: number
    readonly skipped: number
  } {
    let snapshot:
      LearnedWorkspaceIntentSnapshot
    try {
      snapshot =
        decryptWorkspaceIntentSnapshot(
          remote.envelope,
          this.exportKey
        )
    } catch {
      throw new WorkspaceSemanticGitSyncError(
        'remote_decrypt_failed'
      )
    }

    try {
      const result =
        this.options.cache
          .importSnapshot(snapshot)
      return {
        snapshot,
        merged: result.merged,
        skipped: result.skipped
      }
    } catch {
      throw new WorkspaceSemanticGitSyncError(
        'remote_import_failed'
      )
    }
  }
}

export class GitCliWorkspaceSemanticTransport
implements WorkspaceSemanticGitTransport {
  private readonly cwd: string
  private readonly remote: string
  private readonly branch: string
  private readonly artifactPath:
    string
  private readonly commitMessage:
    string

  constructor(
    options:
      GitCliWorkspaceSemanticTransportOptions
  ) {
    this.cwd =
      requireText(
        options.cwd,
        'cwd',
        4096
      )
    this.remote =
      validateRemoteName(
        options.remote ??
        DEFAULT_REMOTE
      )
    this.branch =
      validateBranchName(
        options.branch ??
        DEFAULT_BRANCH
      )
    this.artifactPath =
      validateArtifactPath(
        options.artifactPath ??
        DEFAULT_ARTIFACT
      )
    this.commitMessage =
      requireText(
        options.commitMessage ??
        DEFAULT_COMMIT_MESSAGE,
        'commitMessage',
        256
      )
  }

  fetch():
    WorkspaceSemanticRemoteArtifact |
    null {
    const remoteSha =
      this.remoteHead()
    if (remoteSha === null) {
      return null
    }

    const remoteTrackingRef =
      this.remoteTrackingRef()
    const remoteHeadRef =
      this.remoteHeadRef()

    const fetch =
      this.runGit([
        'fetch',
        '--quiet',
        this.remote,
        `${remoteHeadRef}:${remoteTrackingRef}`
      ])
    if (!fetch.ok) {
      throw new WorkspaceSemanticGitSyncError(
        'git_remote_unavailable'
      )
    }

    const fetchedHead =
      this.runGit([
        'rev-parse',
        '--verify',
        remoteTrackingRef
      ])
    if (!fetchedHead.ok) {
      throw new WorkspaceSemanticGitSyncError(
        'git_read_failed'
      )
    }
    const fetchedSha =
      requireGitSha(
        fetchedHead.stdout
      )

    const envelope =
      this.runGit([
        'show',
        `${fetchedSha}:${this.artifactPath}`
      ])
    if (!envelope.ok) {
      throw new WorkspaceSemanticGitSyncError(
        'git_read_failed'
      )
    }

    return {
      commitSha: fetchedSha,
      envelope: envelope.stdout
    }
  }

  publish(
    input: WorkspaceSemanticPublishInput
  ): WorkspaceSemanticPublishResult {
    const blob =
      this.runGit(
        [
          'hash-object',
          '-w',
          '--stdin'
        ],
        input.envelope
      )
    if (!blob.ok) {
      throw new WorkspaceSemanticGitSyncError(
        'git_publish_failed'
      )
    }
    const blobSha =
      requireGitSha(
        blob.stdout
      )

    const tree =
      this.runGit(
        ['mktree'],
        `100644 blob ${blobSha}\t${this.artifactPath}\n`
      )
    if (!tree.ok) {
      throw new WorkspaceSemanticGitSyncError(
        'git_publish_failed'
      )
    }
    const treeSha =
      requireGitSha(
        tree.stdout
      )

    const commitArgs = [
      'commit-tree',
      treeSha,
      ...(input.parentCommitSha ===
        null
        ? []
        : [
            '-p',
            requireGitSha(
              input.parentCommitSha
            )
          ]),
      '-m',
      this.commitMessage
    ]

    const commit =
      this.runGit(commitArgs)
    if (!commit.ok) {
      throw new WorkspaceSemanticGitSyncError(
        'git_publish_failed'
      )
    }
    const commitSha =
      requireGitSha(
        commit.stdout
      )

    const push =
      this.runGit([
        'push',
        '--quiet',
        this.remote,
        `${commitSha}:${this.remoteHeadRef()}`
      ])
    if (push.ok) {
      return {
        kind: 'pushed',
        commitSha
      }
    }

    const currentRemote =
      this.remoteHead()
    if (
      currentRemote !==
      input.parentCommitSha
    ) {
      return {
        kind: 'conflict'
      }
    }

    throw new WorkspaceSemanticGitSyncError(
      'git_publish_failed'
    )
  }

  private remoteHead():
    string | null {
    const result =
      this.runGit([
        'ls-remote',
        '--heads',
        this.remote,
        this.remoteHeadRef()
      ])
    if (!result.ok) {
      throw new WorkspaceSemanticGitSyncError(
        'git_remote_unavailable'
      )
    }

    const line =
      result.stdout.trim()
    if (!line) return null

    const sha =
      line.split(/\s+/u)[0]
    if (!sha) {
      throw new WorkspaceSemanticGitSyncError(
        'git_remote_unavailable'
      )
    }
    return requireGitSha(sha)
  }

  private remoteHeadRef(): string {
    return (
      'refs/heads/' +
      this.branch
    )
  }

  private remoteTrackingRef():
    string {
    return (
      'refs/remotes/' +
      this.remote +
      '/' +
      this.branch
    )
  }

  private runGit(
    args: readonly string[],
    input?: string
  ): {
    readonly ok: boolean
    readonly stdout: string
  } {
    const result =
      spawnSync(
        'git',
        [...args],
        {
          cwd: this.cwd,
          encoding: 'utf8',
          input,
          windowsHide: true,
          maxBuffer:
            20 * 1024 * 1024
        }
      )

    return {
      ok:
        result.status === 0 &&
        result.error === undefined,
      stdout:
        typeof result.stdout ===
          'string'
          ? result.stdout
          : ''
    }
  }
}

export function snapshotContentEquals(
  left:
    LearnedWorkspaceIntentSnapshot,
  right:
    LearnedWorkspaceIntentSnapshot
): boolean {
  return (
    stableStringify(
      snapshotContent(left)
    ) ===
    stableStringify(
      snapshotContent(right)
    )
  )
}

function snapshotContent(
  snapshot:
    LearnedWorkspaceIntentSnapshot
) {
  return {
    format: snapshot.format,
    version: snapshot.version,
    semanticContractVersion:
      snapshot.semanticContractVersion,
    records:
      [...snapshot.records]
        .map(record =>
          structuredClone(record)
        )
        .sort((left, right) =>
          recordKey(left)
            .localeCompare(
              recordKey(right)
            )
        )
  }
}

function recordKey(
  record:
    LearnedWorkspaceIntentSnapshot[
      'records'
    ][number]
): string {
  return [
    record.fingerprint,
    record.applicability,
    record.intentHash
  ].join('\u0000')
}

function stableStringify(
  value: unknown
): string {
  if (
    value === null ||
    typeof value !== 'object'
  ) {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return (
      '[' +
      value
        .map(stableStringify)
        .join(',') +
      ']'
    )
  }

  const record =
    value as Record<
      string,
      unknown
    >
  return (
    '{' +
    Object.keys(record)
      .sort()
      .map(key =>
        JSON.stringify(key) +
        ':' +
        stableStringify(
          record[key]
        )
      )
      .join(',') +
    '}'
  )
}

function normalizeExportKey(
  value: string | Buffer
): Buffer {
  const key =
    Buffer.isBuffer(value)
      ? Buffer.from(value)
      : Buffer.from(
          value,
          'utf8'
        )

  if (key.byteLength !== 32) {
    throw new RangeError(
      'workspace semantic export key must be exactly 32 bytes'
    )
  }

  return key
}

function requireGitSha(
  value: string
): string {
  const normalized =
    value.trim()
  if (
    !/^[0-9a-f]{40,64}$/u.test(
      normalized
    )
  ) {
    throw new WorkspaceSemanticGitSyncError(
      'git_publish_failed'
    )
  }
  return normalized
}

function validateRemoteName(
  value: string
): string {
  const normalized =
    requireText(
      value,
      'remote',
      128
    )
  if (
    !/^[A-Za-z0-9._-]+$/u.test(
      normalized
    )
  ) {
    throw new TypeError(
      'remote contains invalid characters'
    )
  }
  return normalized
}

function validateBranchName(
  value: string
): string {
  const normalized =
    requireText(
      value,
      'branch',
      256
    )
  if (
    normalized.startsWith('-') ||
    normalized.startsWith('/') ||
    normalized.endsWith('/') ||
    normalized.includes('..') ||
    normalized.includes('//') ||
    !/^[A-Za-z0-9._/-]+$/u.test(
      normalized
    )
  ) {
    throw new TypeError(
      'branch contains invalid characters'
    )
  }
  return normalized
}

function validateArtifactPath(
  value: string
): string {
  const normalized =
    requireText(
      value,
      'artifactPath',
      256
    )
  if (
    normalized.startsWith('/') ||
    normalized.includes('..') ||
    normalized.includes('\\') ||
    !/^[A-Za-z0-9._/-]+$/u.test(
      normalized
    )
  ) {
    throw new TypeError(
      'artifactPath contains invalid characters'
    )
  }
  return normalized
}

function requireText(
  value: string,
  field: string,
  maxLength: number
): string {
  const normalized =
    value.trim()
  if (
    normalized.length < 1 ||
    normalized.length >
      maxLength
  ) {
    throw new TypeError(
      `${field} must be non-empty and <= ${maxLength} characters`
    )
  }
  return normalized
}
