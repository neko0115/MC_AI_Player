import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { RuntimeEventSchema } from '../contracts/events.js'

export type RecordResult =
  | { ok: true }
  | { ok: false; code: 'invalid_event' | 'io_error' }

export interface RecorderOptions {
  maxFileBytes: number
  logger?: Pick<Console, 'error'>
}

export class JsonlEventRecorder {
  private readonly logger: Pick<Console, 'error'>

  constructor(
    private readonly filePath: string,
    private readonly options: RecorderOptions
  ) {
    if (!Number.isFinite(options.maxFileBytes) || options.maxFileBytes <= 0) {
      throw new RangeError('maxFileBytes must be a positive finite number')
    }
    this.logger = options.logger ?? console
  }

  async record(event: unknown): Promise<RecordResult> {
    const parsed = RuntimeEventSchema.safeParse(event)
    if (!parsed.success) {
      return { ok: false, code: 'invalid_event' }
    }

    const line = `${JSON.stringify(parsed.data)}\n`
    const incomingBytes = Buffer.byteLength(line, 'utf8')

    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await this.rotateIfNeeded(incomingBytes)
      await appendFile(this.filePath, line, 'utf8')
      return { ok: true }
    } catch (error) {
      this.logger.error('Failed to record runtime event', error)
      return { ok: false, code: 'io_error' }
    }
  }

  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    let currentBytes = 0
    try {
      currentBytes = (await stat(this.filePath)).size
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error
      }
    }

    if (currentBytes === 0 || currentBytes + incomingBytes <= this.options.maxFileBytes) {
      return
    }

    const rotatedPath = `${this.filePath}.1`
    try {
      await unlink(rotatedPath)
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error
      }
    }
    await rename(this.filePath, rotatedPath)
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
