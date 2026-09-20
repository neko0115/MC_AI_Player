import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes
} from 'node:crypto'
import { z } from 'zod'
import type {
  LearnedWorkspaceIntentCache,
  LearnedWorkspaceIntentImportResult,
  LearnedWorkspaceIntentSnapshot
} from './learned-intent-cache.js'
import {
  parseLearnedWorkspaceIntentSnapshot
} from './learned-intent-cache.js'

const ENVELOPE_FORMAT =
  'mc-ai-player.workspace-intent-cache.encrypted'
const ENVELOPE_VERSION = 1
const ALGORITHM = 'AES-256-GCM'
const MAX_CIPHERTEXT_BYTES =
  16 * 1024 * 1024

const EnvelopeSchema = z
  .object({
    format: z.literal(ENVELOPE_FORMAT),
    version: z.literal(ENVELOPE_VERSION),
    algorithm: z.literal(ALGORITHM),
    nonce: z.string().min(1).max(64),
    ciphertext: z
      .string()
      .min(1)
      .max(
        Math.ceil(
          MAX_CIPHERTEXT_BYTES *
            4 / 3
        ) + 16
      ),
    tag: z.string().min(1).max(64)
  })
  .strict()

export interface WorkspaceSemanticKeyMaterial {
  readonly hmacKey: Buffer
  readonly exportKey: Buffer
}

export interface EncryptWorkspaceIntentSnapshotOptions {
  readonly randomBytesFn?:
    (size: number) => Buffer
}

const KDF_SALT = Buffer.from(
  'mc-ai-player/workspace-semantic-cache/master-v1',
  'utf8'
)
const HMAC_INFO = Buffer.from(
  'workspace-intent-hmac-key-v1',
  'utf8'
)
const EXPORT_INFO = Buffer.from(
  'workspace-intent-export-key-v1',
  'utf8'
)
const AAD = Buffer.from(
  [
    ENVELOPE_FORMAT,
    String(ENVELOPE_VERSION),
    ALGORITHM
  ].join('\0'),
  'utf8'
)

export function deriveWorkspaceSemanticKeys(
  masterSecret: string | Buffer
): WorkspaceSemanticKeyMaterial {
  const secret =
    normalizeMasterSecret(
      masterSecret
    )

  const hmacKey = Buffer.from(
    hkdfSync(
      'sha256',
      secret,
      KDF_SALT,
      HMAC_INFO,
      32
    )
  )
  const exportKey = Buffer.from(
    hkdfSync(
      'sha256',
      secret,
      KDF_SALT,
      EXPORT_INFO,
      32
    )
  )

  return {
    hmacKey,
    exportKey
  }
}

export function encryptWorkspaceIntentSnapshot(
  snapshot: LearnedWorkspaceIntentSnapshot,
  exportKey: string | Buffer,
  options:
    EncryptWorkspaceIntentSnapshotOptions = {}
): string {
  const key =
    normalizeExportKey(exportKey)
  const nonce =
    (options.randomBytesFn ??
      randomBytes)(12)

  if (
    !Buffer.isBuffer(nonce) ||
    nonce.byteLength !== 12
  ) {
    throw new Error(
      'workspace semantic export nonce must be 12 bytes'
    )
  }

  const plaintext = Buffer.from(
    JSON.stringify(snapshot),
    'utf8'
  )
  if (
    plaintext.byteLength >
    MAX_CIPHERTEXT_BYTES
  ) {
    throw new RangeError(
      'workspace semantic export exceeds maximum size'
    )
  }

  const cipher =
    createCipheriv(
      'aes-256-gcm',
      key,
      nonce
    )
  cipher.setAAD(AAD)

  const ciphertext =
    Buffer.concat([
      cipher.update(plaintext),
      cipher.final()
    ])
  const tag =
    cipher.getAuthTag()

  return JSON.stringify({
    format: ENVELOPE_FORMAT,
    version: ENVELOPE_VERSION,
    algorithm: ALGORITHM,
    nonce:
      nonce.toString('base64'),
    ciphertext:
      ciphertext.toString('base64'),
    tag:
      tag.toString('base64')
  })
}

export function decryptWorkspaceIntentSnapshot(
  envelopeText: string,
  exportKey: string | Buffer
): LearnedWorkspaceIntentSnapshot {
  const key =
    normalizeExportKey(exportKey)

  let raw: unknown
  try {
    raw = JSON.parse(
      envelopeText
    )
  } catch {
    throw new Error(
      'invalid workspace semantic encrypted export JSON'
    )
  }

  const envelope =
    EnvelopeSchema.parse(raw)
  const nonce =
    decodeBase64(
      envelope.nonce,
      12,
      'nonce'
    )
  const tag =
    decodeBase64(
      envelope.tag,
      16,
      'auth tag'
    )
  const ciphertext =
    decodeBase64Variable(
      envelope.ciphertext,
      MAX_CIPHERTEXT_BYTES,
      'ciphertext'
    )

  const decipher =
    createDecipheriv(
      'aes-256-gcm',
      key,
      nonce
    )
  decipher.setAAD(AAD)
  decipher.setAuthTag(tag)

  let plaintext: Buffer
  try {
    plaintext =
      Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
      ])
  } catch {
    throw new Error(
      'workspace semantic encrypted export authentication failed'
    )
  }

  let snapshot: unknown
  try {
    snapshot =
      JSON.parse(
        plaintext.toString('utf8')
      )
  } catch {
    throw new Error(
      'invalid workspace semantic decrypted payload'
    )
  }

  return parseLearnedWorkspaceIntentSnapshot(
    snapshot
  )
}

export function exportEncryptedWorkspaceIntentCache(
  cache: LearnedWorkspaceIntentCache,
  exportKey: string | Buffer,
  options:
    EncryptWorkspaceIntentSnapshotOptions = {}
): string {
  return encryptWorkspaceIntentSnapshot(
    cache.exportSnapshot(),
    exportKey,
    options
  )
}

export function importEncryptedWorkspaceIntentCache(
  cache: LearnedWorkspaceIntentCache,
  envelopeText: string,
  exportKey: string | Buffer
): LearnedWorkspaceIntentImportResult {
  const snapshot =
    decryptWorkspaceIntentSnapshot(
      envelopeText,
      exportKey
    )
  return cache.importSnapshot(
    snapshot
  )
}

function normalizeMasterSecret(
  value: string | Buffer
): Buffer {
  const secret =
    Buffer.isBuffer(value)
      ? Buffer.from(value)
      : Buffer.from(value, 'utf8')

  if (secret.byteLength < 32) {
    throw new RangeError(
      'workspace semantic master secret must be at least 32 bytes'
    )
  }

  return secret
}

function normalizeExportKey(
  value: string | Buffer
): Buffer {
  const key =
    Buffer.isBuffer(value)
      ? Buffer.from(value)
      : Buffer.from(value, 'utf8')

  if (key.byteLength !== 32) {
    throw new RangeError(
      'workspace semantic export key must be exactly 32 bytes'
    )
  }

  return key
}

function decodeBase64(
  value: string,
  expectedBytes: number,
  field: string
): Buffer {
  const decoded =
    Buffer.from(
      value,
      'base64'
    )
  if (
    decoded.byteLength !==
      expectedBytes ||
    decoded.toString('base64') !==
      value
  ) {
    throw new Error(
      `invalid workspace semantic export ${field}`
    )
  }
  return decoded
}

function decodeBase64Variable(
  value: string,
  maxBytes: number,
  field: string
): Buffer {
  const decoded =
    Buffer.from(
      value,
      'base64'
    )
  if (
    decoded.byteLength < 1 ||
    decoded.byteLength > maxBytes ||
    decoded.toString('base64') !==
      value
  ) {
    throw new Error(
      `invalid workspace semantic export ${field}`
    )
  }
  return decoded
}
