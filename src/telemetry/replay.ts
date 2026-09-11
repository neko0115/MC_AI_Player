import { readFile } from 'node:fs/promises'
import { RuntimeEventSchema, type RuntimeEvent } from '../contracts/events.js'

export class ReplayValidationError extends Error {
  constructor(
    public readonly lineNumber: number,
    message: string
  ) {
    super(`Replay line ${lineNumber}: ${message}`)
    this.name = 'ReplayValidationError'
  }
}

export class ReplayReader {
  static async readAll(filePath: string): Promise<RuntimeEvent[]> {
    const content = await readFile(filePath, 'utf8')
    const events: RuntimeEvent[] = []
    const lines = content.split(/\r?\n/)

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (!line?.trim()) {
        continue
      }

      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        throw new ReplayValidationError(index + 1, 'invalid JSON')
      }

      const parsed = RuntimeEventSchema.safeParse(value)
      if (!parsed.success) {
        throw new ReplayValidationError(index + 1, 'invalid runtime event')
      }
      events.push(parsed.data)
    }

    return events
  }
}
