const PROVIDER_TIME_ZONE = 'America/Los_Angeles'
const MAX_DAY_SEARCH_MS = 36 * 60 * 60 * 1000

const DAY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: PROVIDER_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
})

export function providerDayKey(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new RangeError('timestamp must be a non-negative finite number')
  }
  const parts = DAY_FORMATTER.formatToParts(new Date(timestamp))
  const year = part(parts, 'year')
  const month = part(parts, 'month')
  const day = part(parts, 'day')
  return `${year}-${month}-${day}`
}

export function nextProviderDayStart(timestamp: number): number {
  const current = providerDayKey(timestamp)
  let low = Math.floor(timestamp)
  let high = low + MAX_DAY_SEARCH_MS
  if (providerDayKey(high) === current) {
    throw new Error('failed to locate next provider day boundary')
  }

  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (providerDayKey(middle) === current) {
      low = middle
    } else {
      high = middle
    }
  }
  return high
}

function part(
  parts: readonly Intl.DateTimeFormatPart[],
  type: 'year' | 'month' | 'day'
): string {
  const value = parts.find(candidate => candidate.type === type)?.value
  if (!value) throw new Error(`provider day formatter did not produce ${type}`)
  return value
}
