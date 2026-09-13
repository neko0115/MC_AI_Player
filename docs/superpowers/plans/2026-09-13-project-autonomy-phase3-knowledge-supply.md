# Project Autonomy Phase 3: Versioned Game Knowledge and Supply Planning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give MC_AI_Player deterministic, versioned Minecraft production knowledge and the ability to derive/materialize resource, workstation, fuel, crafting, smelting, and stonecutting dependencies without per-step AI calls.

**Architecture:** Keep committed human-reviewable game facts separate from Moxue behavior policy. Load a pack keyed by the connected Minecraft version, build an in-memory production graph, then have a pure supply planner expand BOM requirements against inventory/authorized storage/world acquisition and reserve shared stock. Runtime adapters execute bounded craft/process operations; they do not choose production strategy themselves.

**Tech Stack:** TypeScript 7, Node.js 24, Mineflayer 4.39, better-sqlite3 12.11.1, Zod 4.5.4, minecraft-data resolved/pinned to the exact version already used by the installed Mineflayer dependency, node:test/tsx.

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
- Create `src/knowledge/policy.ts` — Moxue-specific rarity/scaffold/tool-preservation policy, separate from game facts.
- Create `scripts/generate-game-knowledge.ts` — deterministic pack generator from pinned `minecraft-data`.
- Create `game-data/java/<runtime-version>/*.json` during implementation for the actual private-server version used in live validation.
- Create `fixtures/game-data/java/test-1.0/*.json` — tiny deterministic test pack.
- Create `src/projects/resource-reservations.ts` — repository-backed material reservation service.
- Extend `src/projects/repository.ts` and `src/projects/sqlite-repository.ts` with `resource_reservations`.
- Create `src/supply/planner.ts` — BOM/source/production expansion.
- Create `src/minecraft/production.ts` — runtime interfaces for crafting/processing/workstations.
- Create `src/minecraft/mineflayer-production.ts` — Mineflayer implementation.
- Modify `src/minecraft/runtime-bundle.ts` — expose production runtime.
- Create `src/skills/production.ts` — bounded craft/smelt/stonecut skills or executor helpers.
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
- Produces Zod schemas and `GameKnowledgePack` consumed by all later tasks.

- [ ] **Step 1: Write RED schema tests**

Define normalized IDs as lowercase namespaced-or-vanilla identifiers matching `/^[a-z0-9_.:-]{1,128}$/`.

Required core types:

```ts
export interface IngredientRequirement {
  readonly item: string
  readonly count: number
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
```

Pack metadata:

```ts
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

Test duplicate IDs, missing referenced items/workstations, invalid counts, zero/negative fuel, and unknown references are rejected by `validateKnowledgePackReferences(pack)`.

- [ ] **Step 2: Run RED**

```powershell
npm test -- tests/knowledge/contracts.test.ts
```

Expected: module missing.

- [ ] **Step 3: Implement schemas and fixture data**

The fixture must include a multi-stage chain sufficient to test recursion, for example:

```text
cobblestone -> smelt stone -> smelt smooth_stone
stone -> stonecutting stone_bricks (test-only normalized fixture rule)
sand -> smelt glass -> crafting glass_pane
log -> crafting planks -> crafting crafting_table
cobblestone -> crafting furnace
```

The fixture is explicitly test data and must not claim to be a real Minecraft version.

- [ ] **Step 4: Run tests/typecheck and commit**

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
- Produces:

```ts
export class GameKnowledgeLoader {
  constructor(private readonly rootDirectory: string) {}
  loadJavaVersion(version: string): GameKnowledgePack
}
```

Generator CLI:

```text
node --import tsx scripts/generate-game-knowledge.ts --version <exact-java-version> --out game-data/java
```

- [ ] **Step 1: Pin the existing Mineflayer-compatible `minecraft-data` version**

Run:

```powershell
npm ls minecraft-data --json
```

Read the resolved version already installed under the Mineflayer dependency graph, then add that exact version as a direct dependency using:

```powershell
npm install --save-exact minecraft-data@<the-exact-version-reported-by-npm-ls>
```

Do not upgrade Mineflayer or choose a different minecraft-data release in this task.

- [ ] **Step 2: Write RED loader tests**

Assert `loadJavaVersion('test-1.0')` succeeds from fixtures when a test root is supplied; missing version throws `knowledge_pack_missing:test-2.0`; mismatched metadata/version throws `knowledge_pack_version_mismatch`.

- [ ] **Step 3: Implement loader**

Read the eight JSON files from `<root>/java/<version>/`, parse JSON, combine into one pack, then run cross-reference validation. No nearest-version fallback.

- [ ] **Step 4: Write RED generator tests around pure normalization functions**

Export pure helpers from the script module so tests can feed small minecraft-data-shaped objects and assert stable sorted JSON records. Ensure output ordering is lexical by ID so Git diffs stay stable.

- [ ] **Step 5: Implement generator**

Use `minecraft-data(version)` as source and normalize only facts needed by this design. The CLI validates `--version`, creates `game-data/java/<version>/`, writes formatted JSON with trailing newline, and exits non-zero when the version is unsupported.

Never scrape the web at runtime.

- [ ] **Step 6: Generate the actual private-server pack**

Determine the exact connected Java version from the existing configured/runtime Minecraft version. If `.env` already fixes `MC_VERSION`, use that exact value; otherwise inspect the Mineflayer spawn/version value and pass it explicitly to the generator. Then run the generator and commit the resulting `game-data/java/<exact-version>/` directory.

- [ ] **Step 7: Run tests/typecheck and commit**

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
- Consumes: `GameKnowledgePack`.
- Produces:

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

Cover:

- output batch rounding (`3 panes per craft` requiring ceil division);
- two-stage smelting chain;
- workstation dependency preserved in route facts;
- raw item leaf when no recipe exists;
- cycle detection returns/throws `production_cycle_detected` with the cycle path;
- max depth default 32 and max nodes default 2048 fail closed.

- [ ] **Step 2: Run RED**

```powershell
npm test -- tests/knowledge/graph.test.ts
```

- [ ] **Step 3: Implement deterministic route ordering**

When multiple routes exist, sort by a stable tuple before selecting a default route:

```text
explicit policy preference
processing kind order
fewest distinct inputs
lexical fact id
```

Do not introduce AI route selection. Preserve an API that can later expose multiple candidate routes to the supply cost planner.

- [ ] **Step 4: Run tests/typecheck and commit**

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
- Produces:

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

reserve(input: Omit<ResourceReservation, 'reservationId' | 'status'>): ResourceReservation
consume(reservationId: string): ResourceReservation
release(reservationId: string): ResourceReservation
listActiveForSource(sourceKind: string, sourceId: string, item: string): ResourceReservation[]
```

- [ ] **Step 1: Write RED repository/reservation tests**

Assert two tasks cannot reserve more than the supplied `availableQuantity` when `ReservationService.reserveAvailable(...)` is called transactionally. Test consume/release idempotence rules explicitly: consuming an already consumed reservation returns the same consumed record; released reservations cannot later consume.

- [ ] **Step 2: Add schema/table and service**

Create `resource_reservations` with foreign key to project, indexes on `(source_kind, source_id, item, status)`, and all quantity/status validation through domain schemas.

- [ ] **Step 3: Run tests/typecheck and commit**

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
- Consumes: BOM requirements, knowledge graph, current inventory snapshot, authorized storage stock, legal world-resource candidates, active reservations.
- Produces:

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
```

- [ ] **Step 1: Write RED planning tests**

Cover:

- inventory is consumed before authorized storage when configured cost is lower;
- unauthorized storage is absent from input/candidates and therefore never selected;
- missing product recursively expands raw material + workstation + fuel steps;
- existing furnace capacity reduces `ensure_workstation` quantity;
- fuel quantity uses burn-time arithmetic and rounds up;
- active reservation reduces apparent storage availability;
- visually significant substitutions are not invented by the supply planner; only alternatives explicitly allowed by the plan/policy may be considered;
- unresolved raw resource remains explicit rather than silently disappearing.

- [ ] **Step 2: Run RED**

```powershell
npm test -- tests/supply/planner.test.ts
```

- [ ] **Step 3: Implement cost tuple and stable ordering**

Use explicit deterministic cost fields:

```ts
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

Compare lexically by weighted total then stable source ID. Keep weights in `src/knowledge/policy.ts`, versioned as code/policy rather than model prompt.

- [ ] **Step 4: Run tests/typecheck and commit**

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
- Test: `tests/minecraft/runtime-bundle.test.ts` if such test exists; otherwise create it.

**Interfaces:**
- Produces:

```ts
export interface ProductionRuntime {
  craft(item: string, quantity: number, workstation: ResolvedWorkstation | null, signal: AbortSignal): Promise<SkillResult>
  process(request: {
    kind: 'smelting' | 'blasting' | 'smoking' | 'stonecutting'
    input: string
    output: string
    quantity: number
    workstation: ResolvedWorkstation
    fuel?: string
  }, signal: AbortSignal): Promise<SkillResult>
}
```

- [ ] **Step 1: Write RED Mineflayer tests**

Mock bot crafting/container APIs and assert:

- craft finds a recipe for the requested output and performs enough batches for requested quantity;
- missing workstation returns `workstation_required`;
- inventory shortage returns `insufficient_ingredients`;
- smelting opens the exact resolved furnace block, loads input/fuel, waits/polls boundedly for output, withdraws output, closes on abort/disconnect;
- stonecutting uses only the resolved stonecutter and validated recipe/result;
- no arbitrary nearby workstation selection occurs inside runtime.

- [ ] **Step 2: Run RED**

```powershell
npm test -- tests/minecraft/mineflayer-production.test.ts
```

- [ ] **Step 3: Implement runtime with abort/disconnect cleanup**

Keep strategy out of this class. It receives exact item/quantity/workstation chosen by the supply/task layer. Every opened container/workstation closes in `finally`.

- [ ] **Step 4: Expose runtime bundle and run tests**

Add `readonly production: ProductionRuntime` to `MineflayerRuntimeBundle` and instantiate with the existing `readyBot()` provider.

```powershell
npm test -- tests/minecraft/mineflayer-production.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/minecraft/production.ts src/minecraft/mineflayer-production.ts src/minecraft/runtime-bundle.ts tests/minecraft/mineflayer-production.test.ts
git commit -m "feat: execute bounded Minecraft production"
```

---

### Task 7: Add production skills and focused live validation

**Files:**
- Create: `src/skills/production.ts`
- Modify: `src/skills/registry.ts` only if helper changes are needed.
- Modify: `src/main.ts` to register bounded production skills for later Project tasks without exposing new raw AI actions yet.
- Test: `tests/skills/production.test.ts`
- Test: `tests/main.test.ts`
- Modify: this plan to append live evidence after validation.

**Interfaces:**
- Produces skill names internal to Project orchestration, for example `craft_item`, `process_item`, `ensure_workstation`; they are registered but are not automatically advertised to current action Gemini unless explicitly added later.

- [ ] **Step 1: Write RED skill tests**

Each skill validates strict args, delegates once to `ProductionRuntime`, propagates cancellation/failure codes, and declares only required capabilities. Creating/placing a new workstation is not permitted in Phase 3; `ensure_workstation` may resolve/use existing infrastructure or return a bounded `workstation_missing` result until Phase 4 construction can place one.

- [ ] **Step 2: Implement and register skills**

Keep current action schema unchanged. Project orchestration in Phase 5 will call these through `SkillExecutor`/bounded internal APIs.

- [ ] **Step 3: Run full automated verification**

```powershell
npm test
npm run typecheck
```

- [ ] **Step 4: Live validate one production chain**

On the private server, prepare an authorized storage/inventory scenario and run a focused harness or temporary local-admin Project test that proves:

```text
raw material -> furnace processing -> workstation recipe -> final requested block
```

Record observed quantities, workstation use, and that no unauthorized container was opened. Do not mark Phase 3 PASS if only unit tests ran.

- [ ] **Step 5: Commit evidence**

```bash
git add src/skills/production.ts src/main.ts tests/skills/production.test.ts docs/superpowers/plans/2026-09-13-project-autonomy-phase3-knowledge-supply.md
git commit -m "docs: record phase 3 supply validation"
```

Phase 3 is complete when exact-version knowledge loads, recursive production/fuel/workstation tests pass, reservations prevent double counting, production runtime passes abort/disconnect tests, full CI/typecheck passes, and one real private-server production chain succeeds.
