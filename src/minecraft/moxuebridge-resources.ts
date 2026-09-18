import { z } from 'zod'
import type {
  LeafCleanupPolicy,
  ResourceProfile,
  ResourceProfileSource
} from './resource-profiles.js'

const NamespacedIdSchema = z.string().trim().min(1).max(128)
const SimpleNameSchema = z.string().trim().min(1).max(128)

const ResourceDescriptorSchema = z.object({
  id: NamespacedIdSchema,
  kind: SimpleNameSchema,
  aliases: z.array(NamespacedIdSchema).max(64),
  block_ids: z.array(NamespacedIdSchema).min(1).max(64),
  collected_item_ids: z.array(NamespacedIdSchema).min(1).max(64),
  minimum_drop_count: z.number().int().min(1).max(2304),
  tool_kind: SimpleNameSchema.nullish(),
  forbidden_enchantments: z.array(SimpleNameSchema).max(64),
  capability_id: SimpleNameSchema.nullish(),
  related_blocks: z.record(
    SimpleNameSchema,
    z.array(NamespacedIdSchema).max(64)
  ),
  cleanup_policy: z.enum([
    'natural_decay',
    'remove_after_felling',
    'preserve'
  ]).nullish(),
  confidence: z.enum(['authoritative', 'inferred'])
})

const ResourceDescriptorListSchema =
  z.array(ResourceDescriptorSchema).max(512)

type ResourceDescriptor =
  z.infer<typeof ResourceDescriptorSchema>

export interface ServerResourceSummary {
  readonly id: string
  readonly kind: string
  readonly aliases: readonly string[]
  readonly blockIds: readonly string[]
  readonly collectedItemIds: readonly string[]
  readonly minimumDropCount: number
  readonly toolKind: string | null
  readonly capabilityId: string | null
  readonly relatedLeaves: readonly string[]
  readonly cleanupPolicy: LeafCleanupPolicy | null
  readonly confidence: 'authoritative' | 'inferred'
}

export interface ServerResourceCatalogSource extends ResourceProfileSource {
  snapshot(): readonly ServerResourceSummary[]
}

type FetchLike = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>

export interface MoxueBridgeResourceCatalogOptions {
  readonly baseUrl: string
  readonly bearerToken: string
  readonly timeoutMs?: number
  readonly refreshIntervalMs?: number
  readonly maxResponseBytes?: number
  readonly fetchImpl?: FetchLike
}

const DEFAULT_TIMEOUT_MS = 800
const DEFAULT_REFRESH_INTERVAL_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024

export class MoxueBridgeResourceCatalog
implements ServerResourceCatalogSource {
  private readonly baseUrl: string
  private readonly bearerToken: string
  private readonly timeoutMs: number
  private readonly refreshIntervalMs: number
  private readonly maxResponseBytes: number
  private readonly fetchImpl: FetchLike
  private profiles = new Map<string, ResourceProfile>()
  private descriptors: ResourceDescriptor[] = []
  private timer: NodeJS.Timeout | null = null

  constructor(options: MoxueBridgeResourceCatalogOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.bearerToken = normalizeToken(options.bearerToken)
    this.timeoutMs = normalizePositiveInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'timeoutMs',
      1,
      60_000
    )
    this.refreshIntervalMs = normalizePositiveInteger(
      options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
      'refreshIntervalMs',
      250,
      24 * 60 * 60 * 1000
    )
    this.maxResponseBytes = normalizePositiveInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      'maxResponseBytes',
      1,
      1024 * 1024
    )
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async start(): Promise<void> {
    if (this.timer) return
    await this.refresh()
    this.timer = setInterval(() => {
      void this.refresh()
    }, this.refreshIntervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  async refresh(): Promise<boolean> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/api/v1/resources`,
        {
          method: 'GET',
          headers: {
            authorization: `Bearer ${this.bearerToken}`,
            accept: 'application/json'
          },
          signal: controller.signal
        }
      )

      // Older Bridge builds do not have the endpoint yet. Static vanilla
      // profiles remain available, so absence of the optional catalog is safe.
      if (response.status === 404) {
        this.profiles = new Map()
        this.descriptors = []
        return true
      }
      if (response.status !== 200) {
        throw new Error(`http_${response.status}`)
      }

      const body = await response.text()
      if (Buffer.byteLength(body, 'utf8') > this.maxResponseBytes) {
        throw new Error('response_too_large')
      }

      const descriptors =
        ResourceDescriptorListSchema.parse(JSON.parse(body))

      const next = new Map<string, ResourceProfile>()
      for (const descriptor of descriptors) {
        if (descriptor.confidence !== 'authoritative') continue
        const profile = profileFromDescriptor(descriptor)
        for (const key of descriptorLookupKeys(descriptor)) {
          if (next.has(key)) {
            throw new Error('invalid_response')
          }
          next.set(key, profile)
        }
      }

      this.profiles = next
      this.descriptors = descriptors.map(cloneDescriptor)
      return true
    } catch {
      this.profiles = new Map()
      this.descriptors = []
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  resolve(resource: string): ResourceProfile | undefined {
    const key = normalizeLookupKey(resource)
    const profile = this.profiles.get(key)
    return profile ? cloneProfile(profile, key) : undefined
  }

  snapshot(): readonly ServerResourceSummary[] {
    return this.descriptors
      .map(descriptor => ({
        id: descriptor.id,
        kind: descriptor.kind,
        aliases: [...descriptor.aliases],
        blockIds: [...descriptor.block_ids],
        collectedItemIds: [...descriptor.collected_item_ids],
        minimumDropCount: descriptor.minimum_drop_count,
        toolKind: descriptor.tool_kind ?? null,
        capabilityId: descriptor.capability_id ?? null,
        relatedLeaves: [...(descriptor.related_blocks.leaves ?? [])],
        cleanupPolicy:
          (descriptor.cleanup_policy as LeafCleanupPolicy | null | undefined)
          ?? null,
        confidence: descriptor.confidence
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }
}

function cloneDescriptor(
  descriptor: ResourceDescriptor
): ResourceDescriptor {
  return {
    ...descriptor,
    aliases: [...descriptor.aliases],
    block_ids: [...descriptor.block_ids],
    collected_item_ids: [...descriptor.collected_item_ids],
    forbidden_enchantments: [...descriptor.forbidden_enchantments],
    related_blocks: Object.fromEntries(
      Object.entries(descriptor.related_blocks)
        .map(([key, values]) => [key, [...values]])
    )
  }
}

function profileFromDescriptor(
  descriptor: ResourceDescriptor
): ResourceProfile {
  const blockNames =
    descriptor.block_ids.map(toRuntimeName)
  const collectedItemNames =
    descriptor.collected_item_ids.map(toRuntimeName)
  const relatedLeafNames =
    (descriptor.related_blocks.leaves ?? []).map(toRuntimeName)
  const toolKind =
    descriptor.tool_kind === 'axe' ||
    descriptor.tool_kind === 'pickaxe'
      ? descriptor.tool_kind
      : null

  return {
    requestedResource: normalizeLookupKey(descriptor.id),
    blockNames,
    collectedItemNames,
    capabilityId: descriptor.capability_id ?? null,
    minimumOnePerBlock: descriptor.minimum_drop_count >= 1,
    toolKind,
    forbiddenToolEnchantments: [
      ...descriptor.forbidden_enchantments
    ],
    acceleratorForbiddenToolEnchantments: [
      ...descriptor.forbidden_enchantments
    ],
    relatedLeafNames,
    leafCleanupPolicy:
      (descriptor.cleanup_policy as LeafCleanupPolicy | null | undefined)
      ?? null
  }
}

function descriptorLookupKeys(
  descriptor: ResourceDescriptor
): string[] {
  return [...new Set([
    descriptor.id,
    ...descriptor.aliases,
    ...descriptor.block_ids,
    ...descriptor.collected_item_ids
  ].map(normalizeLookupKey))]
}

function toRuntimeName(value: string): string {
  const normalized = normalizeLookupKey(value)
  const separator = normalized.indexOf(':')
  if (separator < 0) return normalized
  return normalized.slice(0, separator) === 'minecraft'
    ? normalized.slice(separator + 1)
    : normalized
}

function normalizeLookupKey(value: string): string {
  return value.trim().toLowerCase()
}

function cloneProfile(
  profile: ResourceProfile,
  requestedResource: string
): ResourceProfile {
  return {
    ...profile,
    requestedResource,
    blockNames: [...profile.blockNames],
    collectedItemNames: [...profile.collectedItemNames],
    forbiddenToolEnchantments: [...profile.forbiddenToolEnchantments],
    acceleratorForbiddenToolEnchantments: [
      ...profile.acceleratorForbiddenToolEnchantments
    ],
    relatedLeafNames: [...profile.relatedLeafNames]
  }
}

function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value.trim())
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('MoxueBridge baseUrl must use http or https')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('MoxueBridge baseUrl must not contain credentials, query, or fragment')
  }
  return parsed.toString().replace(/\/+$/, '')
}

function normalizeToken(value: string): string {
  const token = value.trim()
  if (!token || token.length > 4096) {
    throw new Error('MoxueBridge bearer token is invalid')
  }
  return token
}

function normalizePositiveInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}
