export type ResourceCapabilityId = 'vein_mining' | 'tree_felling'

export interface ResourceProfile {
  readonly requestedResource: string
  readonly blockNames: readonly string[]
  readonly collectedItemNames: readonly string[]
  readonly capabilityId: ResourceCapabilityId | null
  readonly exactOnePerBlock: boolean
  readonly toolKind: 'pickaxe' | null
  readonly forbiddenToolEnchantments: readonly string[]
  readonly acceleratorForbiddenToolEnchantments: readonly string[]
}

interface StaticProfileDefinition {
  readonly aliases: readonly string[]
  readonly blockNames: readonly string[]
  readonly collectedItemNames: readonly string[]
  readonly capabilityId: ResourceCapabilityId
  readonly exactOnePerBlock: boolean
  readonly toolKind: 'pickaxe'
  readonly forbiddenToolEnchantments?: readonly string[]
  readonly acceleratorForbiddenToolEnchantments?: readonly string[]
}

const ORE_DROP_FORBIDDEN = Object.freeze(['silk_touch'] as const)
const EXACT_ORE_ACCELERATOR_FORBIDDEN = Object.freeze(['silk_touch', 'fortune'] as const)

const STATIC_PROFILES: readonly StaticProfileDefinition[] = Object.freeze([
  {
    aliases: ['iron_ore', 'deepslate_iron_ore', 'raw_iron'],
    blockNames: ['iron_ore', 'deepslate_iron_ore'],
    collectedItemNames: ['raw_iron'],
    capabilityId: 'vein_mining',
    exactOnePerBlock: true,
    toolKind: 'pickaxe',
    forbiddenToolEnchantments: ORE_DROP_FORBIDDEN,
    acceleratorForbiddenToolEnchantments: EXACT_ORE_ACCELERATOR_FORBIDDEN
  },
  {
    aliases: ['gold_ore', 'deepslate_gold_ore', 'raw_gold'],
    blockNames: ['gold_ore', 'deepslate_gold_ore'],
    collectedItemNames: ['raw_gold'],
    capabilityId: 'vein_mining',
    exactOnePerBlock: true,
    toolKind: 'pickaxe',
    forbiddenToolEnchantments: ORE_DROP_FORBIDDEN,
    acceleratorForbiddenToolEnchantments: EXACT_ORE_ACCELERATOR_FORBIDDEN
  },
  {
    aliases: ['coal_ore', 'deepslate_coal_ore', 'coal'],
    blockNames: ['coal_ore', 'deepslate_coal_ore'],
    collectedItemNames: ['coal'],
    capabilityId: 'vein_mining',
    exactOnePerBlock: true,
    toolKind: 'pickaxe',
    forbiddenToolEnchantments: ORE_DROP_FORBIDDEN,
    acceleratorForbiddenToolEnchantments: EXACT_ORE_ACCELERATOR_FORBIDDEN
  },
  {
    aliases: ['diamond_ore', 'deepslate_diamond_ore', 'diamond'],
    blockNames: ['diamond_ore', 'deepslate_diamond_ore'],
    collectedItemNames: ['diamond'],
    capabilityId: 'vein_mining',
    exactOnePerBlock: true,
    toolKind: 'pickaxe',
    forbiddenToolEnchantments: ORE_DROP_FORBIDDEN,
    acceleratorForbiddenToolEnchantments: EXACT_ORE_ACCELERATOR_FORBIDDEN
  },
  {
    aliases: ['emerald_ore', 'deepslate_emerald_ore', 'emerald'],
    blockNames: ['emerald_ore', 'deepslate_emerald_ore'],
    collectedItemNames: ['emerald'],
    capabilityId: 'vein_mining',
    exactOnePerBlock: true,
    toolKind: 'pickaxe',
    forbiddenToolEnchantments: ORE_DROP_FORBIDDEN,
    acceleratorForbiddenToolEnchantments: EXACT_ORE_ACCELERATOR_FORBIDDEN
  },
  {
    aliases: ['nether_quartz_ore', 'quartz'],
    blockNames: ['nether_quartz_ore'],
    collectedItemNames: ['quartz'],
    capabilityId: 'vein_mining',
    exactOnePerBlock: true,
    toolKind: 'pickaxe',
    forbiddenToolEnchantments: ORE_DROP_FORBIDDEN,
    acceleratorForbiddenToolEnchantments: EXACT_ORE_ACCELERATOR_FORBIDDEN
  },
  {
    aliases: ['copper_ore', 'deepslate_copper_ore', 'raw_copper'],
    blockNames: ['copper_ore', 'deepslate_copper_ore'],
    collectedItemNames: ['raw_copper'],
    capabilityId: 'vein_mining',
    exactOnePerBlock: false,
    toolKind: 'pickaxe',
    forbiddenToolEnchantments: ORE_DROP_FORBIDDEN
  },
  {
    aliases: ['redstone_ore', 'deepslate_redstone_ore', 'redstone'],
    blockNames: ['redstone_ore', 'deepslate_redstone_ore'],
    collectedItemNames: ['redstone'],
    capabilityId: 'vein_mining',
    exactOnePerBlock: false,
    toolKind: 'pickaxe',
    forbiddenToolEnchantments: ORE_DROP_FORBIDDEN
  },
  {
    aliases: ['lapis_ore', 'deepslate_lapis_ore', 'lapis_lazuli'],
    blockNames: ['lapis_ore', 'deepslate_lapis_ore'],
    collectedItemNames: ['lapis_lazuli'],
    capabilityId: 'vein_mining',
    exactOnePerBlock: false,
    toolKind: 'pickaxe',
    forbiddenToolEnchantments: ORE_DROP_FORBIDDEN
  },
  {
    aliases: ['nether_gold_ore', 'gold_nugget'],
    blockNames: ['nether_gold_ore'],
    collectedItemNames: ['gold_nugget'],
    capabilityId: 'vein_mining',
    exactOnePerBlock: false,
    toolKind: 'pickaxe',
    forbiddenToolEnchantments: ORE_DROP_FORBIDDEN
  },
  {
    aliases: ['ancient_debris'],
    blockNames: ['ancient_debris'],
    collectedItemNames: ['ancient_debris'],
    capabilityId: 'vein_mining',
    exactOnePerBlock: true,
    toolKind: 'pickaxe',
    forbiddenToolEnchantments: [],
    acceleratorForbiddenToolEnchantments: []
  }
])

export function resolveResourceProfile(resource: string): ResourceProfile {
  const normalized = normalizeResource(resource)
  const path = resourcePath(normalized)
  const vanilla = isVanillaResource(normalized)
  const staticProfile = vanilla
    ? STATIC_PROFILES.find(profile => profile.aliases.includes(path))
    : undefined

  if (staticProfile) {
    return {
      requestedResource: normalized,
      blockNames: [...staticProfile.blockNames],
      collectedItemNames: [...staticProfile.collectedItemNames],
      capabilityId: staticProfile.capabilityId,
      exactOnePerBlock: staticProfile.exactOnePerBlock,
      toolKind: staticProfile.toolKind,
      forbiddenToolEnchantments: [...(staticProfile.forbiddenToolEnchantments ?? [])],
      acceleratorForbiddenToolEnchantments: [
        ...(staticProfile.acceleratorForbiddenToolEnchantments
          ?? staticProfile.forbiddenToolEnchantments
          ?? [])
      ]
    }
  }

  const capabilityId = vanilla ? fallbackCapabilityId(path) : null
  const runtimeName = runtimeResourceName(normalized)
  return {
    requestedResource: normalized,
    blockNames: [runtimeName],
    collectedItemNames: [runtimeName],
    capabilityId,
    exactOnePerBlock: capabilityId === 'tree_felling',
    toolKind: null,
    forbiddenToolEnchantments: [],
    acceleratorForbiddenToolEnchantments: []
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

function isVanillaResource(resource: string): boolean {
  const separator = resource.indexOf(':')
  return separator < 0 || resource.slice(0, separator) === 'minecraft'
}

function runtimeResourceName(resource: string): string {
  const separator = resource.indexOf(':')
  if (separator < 0) return resource
  return resource.slice(0, separator) === 'minecraft'
    ? resource.slice(separator + 1)
    : resource
}

function resourcePath(resource: string): string {
  const separator = resource.indexOf(':')
  return separator < 0 ? resource : resource.slice(separator + 1)
}

function normalizeResource(resource: string): string {
  return resource.trim().toLowerCase()
}
