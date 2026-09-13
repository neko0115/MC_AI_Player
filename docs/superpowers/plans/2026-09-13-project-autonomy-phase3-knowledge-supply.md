# Project Autonomy Phase 3: Versioned Game Knowledge and Supply Planning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give MC_AI_Player deterministic, versioned Minecraft production knowledge and the ability to derive/materialize resource, workstation, fuel, crafting, smelting, and stonecutting dependencies without per-step AI calls.

**Architecture:** Keep committed human-reviewable game facts separate from Moxue behavior policy. Load a pack keyed by the connected Minecraft version, build an in-memory production graph, then have a pure supply planner expand BOM requirements against inventory/authorized storage/world acquisition and reserve shared stock. Runtime adapters execute bounded craft/process operations; they do not choose production strategy themselves.

**Tech Stack:** TypeScript 7, Node.js 24, Mineflayer 4.39, better-sqlite3 12.11.1, Zod 4.5.4, `minecraft-data` pinned to the exact version already resolved by the installed Mineflayer dependency, node:test/tsx.

**Spec:** `docs/superpowers/specs/2026-09-13-project-autonomy-construction-design.md`

## Global Constraints

- Knowledge packs are keyed by exact Minecraft Java version; no silent cross-version fallback.
- Committed JSON remains reviewable source data; runtime indexes/caches may be generated but are not the only source of truth.
- Recipe expansion has cycle detection and bounded depth/node count.
- Storage sources are considered only after Phase 2 ACL authorization.
- Resource planning never treats protected/player-built world content as harvestable merely because it is cheap.
- AI is not called for recipe, fuel, tool, workstation, or quantity arithmetic.
- Shared material stock is reserved before execution to prevent double counting.
- Existing action/gather/safety behavior remains valid when no Project supply plan is active.

---

## File structure

- Create `src/knowledge/contracts.ts` — pack schemas and normalized facts.
- Create `src/knowledge/loader.ts` — exact-version pack loading/validation.
- Create `src/knowledge/graph.ts` — production graph and bounded reverse expansion.
- Create `src/knowledge/policy.ts` — Moxue-specific rarity/tool/resource policy, separate from game facts.
- Create `scripts/generate-game-knowledge.ts` — deterministic pack generator from pinned `minecraft-data`.
- Create `fixtures/game-data/java/test-1.0/*.json` — deterministic test-only pack.
- During implementation, generate and commit `game-data/java/$minecraftVersion/*.json` for the exact private-server version used in live validation.
- Create `src/projects/resource-reservations.ts` and extend the Phase 2 repository.
- Create `src/supply/planner.ts` — BOM/source/production expansion.
- Create `src/minecraft/production.ts` and `src/minecraft/mineflayer-production.ts` — bounded production runtime.
- Modify `src/minecraft/runtime-bundle.ts` — expose production runtime.
- Create `src/skills/production.ts` — bounded internal production skills.
- Tests under `tests/knowledge/`, `tests/supply/`, `tests/minecraft/`, `tests/skills/`, `tests/projects/`.

---

### Task 1: Define and validate versioned Game Knowledge Pack schemas

**Files:**
- Create: `src/knowledge/contracts.ts`
- Create: `fixtures/game-data/java/test-1.0/blocks.json`
- Create: `fixtures/game-data/java/test-1.0/items.json`
- Create: `fixtures/game-data/java/test-1.0/recipes.json`
- Create: `fixtures/game-data/java/test-1.0/processing.json`
- Create: `fixtures/game-data/java/test-1.0/fuels.json`
- Create: `fixtures/game-data/java/test-1.0/tools.json`
- Create: `fixtures/game-data/java/test-1.0/combat.json`
- Create: `fixtures/game-data/java/test-1.0/workstations.json`
- Test: `tests/knowledge/contracts.test.ts`

**Interfaces:**
- Produces every fact type used by later tasks.

- [ ] **Step 1: Write the failing contract tests**

Define normalized IDs using `/^[a-z0-9_.:-]{1,128}$/` and add these exact shapes:

```ts
export interface IngredientRequirement {
  readonly item: string
  readonly count: number
}

export interface BlockFact {
  readonly id: string
  readonly hardness: number | null
  readonly harvestToolClasses: readonly string[]
  readonly naturalTerrainCandidate: boolean
  readonly replaceable: boolean
  readonly gravityAffected: boolean
  readonly liquid: boolean
  readonly container: boolean
  readonly redstoneLike: boolean
}

export interface ItemFact {
  readonly id: string
  readonly stackSize: number
}

export interface RecipeFact {
  readonly id: string
  readonly output: IngredientRequirement
  readonly inputs: readonly IngredientRequirement[]
  readonly workstation: 'inventory' | 'crafting_table'
}

export interface ProcessingFact {
  readonly id: string
  readonly kind: 'smelting' | 'blasting' | 'smoking' | 'stonecutting'
  readonly input: IngredientRequirement
  readonly output: IngredientRequirement
  readonly workstation: string
  readonly cookTimeTicks: number | null
}

export interface FuelFact {
  readonly item: string
  readonly burnTimeTicks: number
}

export interface ToolFact {
  readonly item: string
  readonly class: 'axe' | 'pickaxe' | 'shovel' | 'hoe' | 'shears' | 'sword' | 'other'
  readonly tier: string | null
  readonly maxDurability: number | null
  readonly attackDamage: number | null
  readonly attackSpeed: number | null
}

export interface CombatFact {
  readonly item: string
  readonly attackDamage: number
  readonly attackSpeed: number
  readonly ranged: boolean
  readonly ammoItem: string | null
}

export interface WorkstationFact {
  readonly id: string
  readonly blockNames: readonly string[]
  readonly supportedKinds: readonly ('crafting' | 'smelting' | 'blasting' | 'smoking' | 'stonecutting')[]
}

export interface GameKnowledgePack {
  readonly schemaVersion: 1
  readonly edition: 'java'
  readonly minecraftVersion: string
  readonly blocks: readonly BlockFact[]
  readonly items: readonly ItemFact[]
  readonly recipes: readonly RecipeFact[]
  readonly processing: readonly ProcessingFact[]
  readonly fuels: readonly FuelFact[]
  readonly tools: readonly ToolFact[]
  readonly combat: readonly CombatFact[]
  readonly workstations: readonly WorkstationFact[]
}
```

Test duplicate IDs, invalid counts, zero/negative fuel, unknown item references, and unknown workstation references through `validateKnowledgePackReferences(pack)`.

- [ ] **Step 2: Run RED**

```powershell
npm test -- tests/knowledge/contracts.test.ts
```

Expected: module missing.

- [ ] **Step 3: Implement schemas and fixture data**

The test pack must contain a recursive chain such as:

```text
cobblestone -> smelt stone -> smelt smooth_stone
stone -> stonecutting stone_bricks (test-only rule)
sand -> smelt glass -> craft glass_pane
log -> craft planks -> craft crafting_table
cobblestone -> craft furnace
```

The fixture metadata uses `minecraftVersion = "test-1.0"` and is never presented as a real Minecraft release.

- [ ] **Step 4: Verify and commit**

```powershell
npm test -- tests/knowledge/contracts.test.ts
npm run typecheck
```

```bash
git add src/knowledge/contracts.ts fixtures/game-data/java/test-1.0 tests/knowledge/contracts.test.ts
git commit -m "feat: define versioned Minecraft knowledge packs"
```

---

### Task 2: Add exact-version loader and deterministic pack generator

**Files:**
- Create: `src/knowledge/loader.ts`
- Create: `scripts/generate-game-knowledge.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `tests/knowledge/loader.test.ts`
- Test: `tests/scripts/generate-game-knowledge.test.ts`

**Interfaces:**

```ts
export class GameKnowledgeLoader {
  constructor(private readonly rootDirectory: string) {}
  loadJavaVersion(version: string): GameKnowledgePack
}
```

CLI contract:

```text
node --import tsx scripts/generate-game-knowledge.ts --version 1.21.8 --out game-data/java
```

The numeric version above is a CLI example only; live generation uses the actual configured private-server version as described below.

- [ ] **Step 1: Pin the already-resolved Mineflayer-compatible `minecraft-data` dependency**

Use PowerShell so no manual version placeholder is needed:

```powershell
$mdVersion = node -p "require('minecraft-data/package.json').version"
if (-not $mdVersion) { throw 'minecraft-data is not resolved by the current install' }
npm install --save-exact "minecraft-data@$mdVersion"
```

Do not upgrade Mineflayer in this task.

- [ ] **Step 2: Write RED loader tests**

Assert `loadJavaVersion('test-1.0')` succeeds from the fixture root. Missing `test-2.0` throws `knowledge_pack_missing:test-2.0`; mismatched metadata throws `knowledge_pack_version_mismatch`.

- [ ] **Step 3: Implement the loader**

Read these exact filenames from `${rootDirectory}/java/${version}/`: `blocks.json`, `items.json`, `recipes.json`, `processing.json`, `fuels.json`, `tools.json`, `combat.json`, `workstations.json`; parse them through Zod and run cross-reference validation. Do not fall back to a nearest version.

- [ ] **Step 4: Write RED generator normalization tests**

Export pure normalizers used by the CLI. Feed small minecraft-data-shaped objects and assert lexical stable ordering by ID and repeatable JSON output.

- [ ] **Step 5: Implement the generator**

The script parses `--version` and `--out`, loads `minecraft-data(version)`, writes the eight files with two-space JSON + trailing newline, and exits non-zero for unsupported versions.

- [ ] **Step 6: Generate the actual private-server pack**

On the MC host, use the exact version configured for the real server. If `.env` already contains `MC_VERSION`, run:

```powershell
$version = (Get-Content .env | Where-Object { $_ -match '^MC_VERSION=' } | Select-Object -First 1) -replace '^MC_VERSION=', ''
if (-not $version) { throw 'Set MC_VERSION locally to the exact Paper Java version before generating the release knowledge pack.' }
node --import tsx scripts/generate-game-knowledge.ts --version $version --out game-data/java
```

If the deployment intentionally leaves `MC_VERSION` unset, determine the exact server protocol version from the current Paper/Mineflayer runtime first, set `MC_VERSION` locally, restart once to verify that exact version connects, then run the command above. Do not commit `.env`.

- [ ] **Step 7: Verify and commit**

```powershell
npm test -- tests/knowledge/loader.test.ts tests/scripts/generate-game-knowledge.test.ts
npm run typecheck
```

```bash
git add package.json package-lock.json src/knowledge/loader.ts scripts/generate-game-knowledge.ts game-data/java tests/knowledge/loader.test.ts tests/scripts/generate-game-knowledge.test.ts
git commit -m "feat: generate exact-version game knowledge"
```

---

### Task 3: Build bounded reverse production graph expansion

**Files:**
- Create: `src/knowledge/graph.ts`
- Test: `tests/knowledge/graph.test.ts`

**Interfaces:**

```ts
export type ProductionRoute =
  | { readonly kind: 'craft'; readonly fact: RecipeFact }
  | { readonly kind: 'process'; readonly fact: ProcessingFact }
  | { readonly kind: 'raw'; readonly item: string }

export interface ProductionRequirementNode {
  readonly item: string
  readonly quantity: number
  readonly route: ProductionRoute
  readonly children: readonly ProductionRequirementNode[]
}

export function expandProductionRequirement(
  pack: GameKnowledgePack,
  item: string,
  quantity: number,
  options?: { readonly maxDepth?: number; readonly maxNodes?: number }
): ProductionRequirementNode
```

- [ ] **Step 1: Write RED graph tests**

Cover output-batch rounding, two-stage processing, workstation preservation, raw leaves, cycle detection with `production_cycle_detected`, default max depth 32, and default max node count 2048.

- [ ] **Step 2: Run RED**

```powershell
npm test -- tests/knowledge/graph.test.ts
```

- [ ] **Step 3: Implement deterministic route ordering**

Order candidate routes by explicit policy preference, processing-kind order, fewest distinct inputs, then lexical fact ID. Keep an internal API returning all candidates so the supply cost planner can compare allowed routes without AI.

- [ ] **Step 4: Verify and commit**

```powershell
npm test -- tests/knowledge/graph.test.ts
npm run typecheck
```

```bash
git add src/knowledge/graph.ts tests/knowledge/graph.test.ts
git commit -m "feat: expand Minecraft production dependencies"
```

---

### Task 4: Persist atomic material reservations

**Files:**
- Modify: `src/projects/repository.ts`
- Modify: `src/projects/sqlite-repository.ts`
- Create: `src/projects/resource-reservations.ts`
- Test: `tests/projects/resource-reservations.test.ts`
- Test: `tests/projects/sqlite-repository.test.ts`

**Interfaces:**

```ts
export interface ResourceReservation {
  readonly reservationId: string
  readonly projectId: string
  readonly taskId: string
  readonly sourceKind: 'inventory' | 'storage' | 'world' | 'production'
  readonly sourceId: string
  readonly item: string
  readonly quantity: number
  readonly status: 'reserved' | 'consumed' | 'released'
}

export interface ReservationService {
  reserveAvailable(input: Omit<ResourceReservation, 'reservationId' | 'status'> & { readonly availableQuantity: number }): ResourceReservation
  consume(reservationId: string): ResourceReservation
  release(reservationId: string): ResourceReservation
  listActiveForSource(sourceKind: ResourceReservation['sourceKind'], sourceId: string, item: string): ResourceReservation[]
}
```

- [ ] **Step 1: Write RED reservation tests**

Assert two tasks cannot reserve more than `availableQuantity` transactionally. Consuming an already consumed reservation is idempotent; a released reservation cannot later be consumed.

- [ ] **Step 2: Add schema/table/service**

Create `resource_reservations` with a foreign key to project and index `(source_kind, source_id, item, status)`.

- [ ] **Step 3: Verify and commit**

```powershell
npm test -- tests/projects/resource-reservations.test.ts tests/projects/sqlite-repository.test.ts
npm run typecheck
```

```bash
git add src/projects/repository.ts src/projects/sqlite-repository.ts src/projects/resource-reservations.ts tests/projects/resource-reservations.test.ts tests/projects/sqlite-repository.test.ts
git commit -m "feat: reserve shared project materials"
```

---

### Task 5: Implement deterministic Supply Planner

**Files:**
- Create: `src/supply/planner.ts`
- Create: `src/knowledge/policy.ts`
- Test: `tests/supply/planner.test.ts`

**Interfaces:**

```ts
export type SupplyStep =
  | { readonly kind: 'use_inventory'; readonly item: string; readonly quantity: number }
  | { readonly kind: 'withdraw_storage'; readonly storageId: string; readonly item: string; readonly quantity: number }
  | { readonly kind: 'gather'; readonly item: string; readonly quantity: number }
  | { readonly kind: 'craft'; readonly recipeId: string; readonly batches: number }
  | { readonly kind: 'process'; readonly processingId: string; readonly batches: number }
  | { readonly kind: 'ensure_workstation'; readonly workstation: string; readonly quantity: number }
  | { readonly kind: 'acquire_fuel'; readonly item: string; readonly quantity: number }

export interface SupplyPlan {
  readonly steps: readonly SupplyStep[]
  readonly unresolved: readonly { item: string; quantity: number; code: string }[]
}

export interface SupplyCost {
  readonly travel: number
  readonly gatherTime: number
  readonly processingTime: number
  readonly toolWear: number
  readonly fuel: number
  readonly rarity: number
  readonly risk: number
}
```

- [ ] **Step 1: Write RED planner tests**

Cover inventory/authorized storage ordering, recursive raw/workstation/fuel expansion, existing furnace capacity, burn-time rounding, active reservations reducing available stock, allowed substitutions only, and explicit unresolved resources.

- [ ] **Step 2: Run RED**

```powershell
npm test -- tests/supply/planner.test.ts
```

- [ ] **Step 3: Implement deterministic cost comparison**

Keep numeric weights in `src/knowledge/policy.ts`; compare weighted total then stable source ID. No Gemini call.

- [ ] **Step 4: Verify and commit**

```powershell
npm test -- tests/supply/planner.test.ts tests/knowledge/graph.test.ts
npm run typecheck
```

```bash
git add src/supply/planner.ts src/knowledge/policy.ts tests/supply/planner.test.ts
git commit -m "feat: plan project material supply"
```

---

### Task 6: Add bounded Mineflayer crafting/processing runtime

**Files:**
- Create: `src/minecraft/production.ts`
- Create: `src/minecraft/mineflayer-production.ts`
- Modify: `src/minecraft/runtime-bundle.ts`
- Test: `tests/minecraft/mineflayer-production.test.ts`
- Create or modify: `tests/minecraft/runtime-bundle.test.ts`

**Interfaces:**

```ts
export interface ResolvedWorkstation {
  readonly id: string
  readonly kind: 'crafting_table' | 'furnace' | 'blast_furnace' | 'smoker' | 'stonecutter'
  readonly position: Position
  readonly expectedBlockNames: readonly string[]
}

export interface ProductionRuntime {
  craft(item: string, quantity: number, workstation: ResolvedWorkstation | null, signal: AbortSignal): Promise<SkillResult>
  process(request: {
    readonly kind: 'smelting' | 'blasting' | 'smoking' | 'stonecutting'
    readonly input: string
    readonly output: string
    readonly quantity: number
    readonly workstation: ResolvedWorkstation
    readonly fuel?: string
  }, signal: AbortSignal): Promise<SkillResult>
}
```

- [ ] **Step 1: Write RED runtime tests**

Mock Mineflayer crafting/container APIs and assert exact workstation use, enough batches, missing workstation/ingredient failures, bounded smelting polling, abort/disconnect cleanup, and no implicit nearby-workstation search inside the runtime.

- [ ] **Step 2: Run RED**

```powershell
npm test -- tests/minecraft/mineflayer-production.test.ts
```

- [ ] **Step 3: Implement production runtime**

The runtime performs only the exact operation chosen by the planner/task layer. Every opened workstation/container closes in `finally`.

- [ ] **Step 4: Expose through the runtime bundle**

Add `readonly production: ProductionRuntime` to `MineflayerRuntimeBundle` and instantiate it from the existing ready-bot provider.

- [ ] **Step 5: Verify and commit**

```powershell
npm test -- tests/minecraft/mineflayer-production.test.ts tests/minecraft/runtime-bundle.test.ts
npm run typecheck
```

```bash
git add src/minecraft/production.ts src/minecraft/mineflayer-production.ts src/minecraft/runtime-bundle.ts tests/minecraft/mineflayer-production.test.ts tests/minecraft/runtime-bundle.test.ts
git commit -m "feat: execute bounded Minecraft production"
```

---

### Task 7: Register internal production skills and validate a real chain

**Files:**
- Create: `src/skills/production.ts`
- Modify: `src/main.ts`
- Test: `tests/skills/production.test.ts`
- Modify: this plan to append live evidence after validation.

**Interfaces:**
- Produces internal skill names `craft_item` and `process_item`. They are registered for Project orchestration but are not added to the current action-Gemini tool list in this phase.

- [ ] **Step 1: Write RED skill tests**

Each skill validates strict args, delegates exactly once to `ProductionRuntime`, propagates cancellation/failure codes, and declares only required capabilities. Creating/placing a missing workstation remains a later construction task; production returns `workstation_missing` when the supplied plan cannot resolve one.

- [ ] **Step 2: Implement/register skills**

Keep current action DecisionOutcome schema unchanged.

- [ ] **Step 3: Run full verification**

```powershell
npm test
npm run typecheck
```

- [ ] **Step 4: Live-validate one real production chain**

Prepare authorized inventory/storage and validate one chain containing raw material, fuel, furnace processing, and a workstation recipe. Record observed quantities/workstations and verify no unauthorized container opens.

- [ ] **Step 5: Commit evidence**

```bash
git add src/skills/production.ts src/main.ts tests/skills/production.test.ts docs/superpowers/plans/2026-09-13-project-autonomy-phase3-knowledge-supply.md
git commit -m "docs: record phase 3 supply validation"
```

Phase 3 is complete when exact-version knowledge loads, recursive production/fuel/workstation tests pass, reservations prevent double counting, the production runtime passes abort/disconnect tests, full suite/typecheck passes, and one real private-server production chain succeeds.
