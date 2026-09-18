export type ResourceCapabilityId = 'vein_mining' | 'tree_felling'

export interface ResourceProfile {
  readonly requestedResource: string
  readonly blockNames: readonly string[]
  readonly collectedItemNames: readonly string[]
  readonly capabilityId: ResourceCapabilityId | null
  readonly exactOnePerBlock: boolean
  readonly forbiddenToolEnchantments: readonly string[]
}

interface StaticProfileDefinition {
  readonly aliases: readonly string[]
  readonly blockNames: readonly string[]
  readonly collectedItemNames: readonly string[]
  readonly capabilityId: ResourceCapabilityId
  readonly exactOnePerBlock: boolean
  readonly forbiddenToolEnchantments?: readonly string[]
}

const EXACT_ORE_TOOL_FORBIDDEN = Object.freeze(['silk_touch', 'fortune'] as const)

const STATIC_PROFILES: readonly StaticProfileDefinition[] = Object.freeze([
  {
    aliases: ['iron_ore', 'deepslate_iron_ore', 'raw_iron'],
    blockNames: ['iron_ore', 'deepslate_iron_ore'],
    collectedItemNames: ['raw_iron'],
    capabilityId: 'vein_mining',
    exactOnePerBlock: true,
    forbiddenToolEnchantments: EXACT_ORE_TOOL_FORBIDDEN
  },
  {
    aliases: ['gold_ore', 'deepslate_gold_ore', 'raw_gold'],
    blockNames: ['gold_ore', 'deepslate_gold_ore'],
    collectedItemNames: ['raw_gold'],
    capabilityId: 'vein_mining',
    exactOnePerBlock: true,
    forbiddenToolEnchantments: EXACT_ORE_TOOL_FORBIDDEN
  },
  {
    aliases: ['coal_ore', 'deepslate_coal_ore', 'coal'],
    blockNames: ['coal_ore', 'deepslate_coal_ore'],
    collectedItemNames: ['coal'],
    capabilityId: 'vein_mining',
    exactOnePerBlock: true,
    forbiddenToolEnchantments: EXACT_ORE_TOOL_FORBIDDEN
  },
  {
    aliases: ['diamond_ore', 'deepslate_diamond_ore', 'diamond'],
    blockNames: ['diamond_ore', 'deepslate_diamond_ore'],
    collectedItemNames: ['diamond'],
    capabilityId: 'vein_mining',
    exactOnePerBlock: true,
    forbiddenToolEnchantments: EXACT_ORE_TOOL_FORBIDDEN
  },
  {
    aliases: ['emerald_ore', 'deepslate_emerald_ore', 'emerald'],
    blockNames: ['emerald_ore', 'deepslate_emerald_ore'],
    collectedItemNames: ['emerald'],
    capabilityId: 'vein_mining',
    exactOnePerBlock: true,
    forbiddenToolEnchantments: EXACT_ORE_TOOL_FORBIDDEN
  },
  {
    aliases: ['nether_quartz_ore', 'quartz'],
    blockNames: ['nether_quartz_ore'],
    collectedItemNames: ['quartz'],
    capabilityId: 'vein_mining',
    exactOnePerBlock: true,
    forbiddenToolEnchantments: EXACT_ORE_TOOL_FORBIDDEN
  },
  {
    aliases: ['ancient_debris'],
    blockNames: ['ancient_debris'],
    collectedItemNames: ['ancient_debris'],
    capabilityId: 'vein_mining',
    exactOnePerBlock: true,
    forbiddenToolEnchantments: []
  }
])

export function resolveResourceProfile(resource: string): ResourceProfile {
  const normalized = normalizeResource(resource)
  const path = resourcePath(normalized)
  const staticProfile = STATIC_PROFILES.find(profile =>
    profile.aliases.includes(path)
  )

  if (staticProfile) {
    return {
      requestedResource: normalized,
      blockNames: namespaceLikeInput(staticProfile.blockNames, normalized),
      collectedItemNames: namespaceLikeInput(staticProfile.collectedItemNames, normalized),
      capabilityId: staticProfile.capabilityId,
      exactOnePerBlock: staticProfile.exactOnePerBlock,
      forbiddenToolEnchantments: [...(staticProfile.forbiddenToolEnchantments ?? [])]
    }
  }

  const capabilityId = fallbackCapabilityId(path)
  return {
    requestedResource: normalized,
    blockNames: [normalized],
    collectedItemNames: [normalized],
    capabilityId,
    exactOnePerBlock: capabilityId === 'tree_felling',
    forbiddenToolEnchantments: []
  }
}

function fallbackCapabilityId(path: string): ResourceCapabilityId | null {
  if (
    path.endsWith('_log') ||
    path.endsWith('_stem') ||
    path.endsWith('_hyphae')
  ) {
    return 'tree_felling'
  }
  return null
}

function namespaceLikeInput(values: readonly string[], input: string): string[] {
  const separator = input.indexOf(':')
  if (separator < 0) return [...values]
  const namespace = input.slice(0, separator)
  if (namespace !== 'minecraft') return [...values]
  return values.map(value => `minecraft:${value}`)
}

function resourcePath(resource: string): string {
  const separator = resource.indexOf(':')
  return separator < 0 ? resource : resource.slice(separator + 1)
}

function normalizeResource(resource: string): string {
  return resource.trim().toLowerCase()
}
