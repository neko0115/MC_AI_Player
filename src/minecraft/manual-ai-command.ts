export type ManualAiCommand =
  | { readonly kind: 'deep_new'; readonly instruction: string }
  | { readonly kind: 'deep_current'; readonly directive?: string }

const MAX_INSTRUCTION_CHARS = 1000
const COMMAND_PATTERN = /^!moxue\s+deep(?:\s+(.*))?$/is

export function parseManualAiCommand(message: string): ManualAiCommand | null {
  const normalized = message.trim()
  const match = COMMAND_PATTERN.exec(normalized)
  if (!match) return null

  const remainder = (match[1] ?? '').trim()
  if (!remainder) return null

  const currentMatch = /^current(?:\s+(.*))?$/is.exec(remainder)
  if (currentMatch) {
    const directive = (currentMatch[1] ?? '').trim()
    if (directive.length > MAX_INSTRUCTION_CHARS) return null
    return directive
      ? { kind: 'deep_current', directive }
      : { kind: 'deep_current' }
  }

  if (remainder.length > MAX_INSTRUCTION_CHARS) return null
  return {
    kind: 'deep_new',
    instruction: remainder
  }
}
