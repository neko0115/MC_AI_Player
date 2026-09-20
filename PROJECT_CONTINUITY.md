# MC_AI_Player Project Continuity Contract

> **MANDATORY:** Every AI assistant, coding conversation, or engineer MUST read this file before changing code in this repository.  
> Do not rely on chat memory alone. Do not assume another worktree or branch is synchronized.  
> Before ending a coding session, update the relevant progress section in this file so the next session can continue without reconstructing context from chat history.

**Last continuity update:** 2026-09-20  
**Current canonical development branch for this copy:** `feature/workspace-planner`  
**Current accepted modularization code baseline:** `49f3a57` (`refactor: close parallelization extension hotspots`).

---

## 1. Why this file exists

MC_AI_Player is now large enough that work regularly spans multiple conversations, branches, worktrees, live Minecraft validations, and partially completed long-term plans.

This file is the durable handoff layer between those sessions.

Historical documents under `docs/superpowers/plans/` and `docs/superpowers/specs/` remain design/execution records. They are useful references, but they are not the single current-state handoff.

This file owns four things:

1. the long-term product/architecture objective;
2. non-negotiable extensibility and safety rules;
3. current workstream/branch/live-validation status;
4. the collaboration protocol for concurrent conversations and worktrees.

---

## 2. Mandatory startup protocol

Before modifying any code:

1. Run `git fetch --all --prune`.
2. Run:
   - `git branch --show-current`
   - `git status --short --branch`
   - `git branch -vv`
   - `git worktree list`
3. Read this entire file from the current branch.
4. If the branch is not based on the latest merged canonical state, compare this file with the copy on `origin/main` before assuming project-wide status.
5. Read the spec/plan documents referenced by the active workstream only after this continuity file establishes which workstream is active.
6. Verify the branch/worktree is not owned by another active conversation.
7. Do not reset, rebase, merge, pull into, or force-update another worktree's active branch.
8. Reproduce or inspect the current failing test/live evidence before changing behavior.
9. Use RED -> GREEN for behavior fixes whenever practical.
10. Do not start a new feature while the active workstream has an unresolved validation gate unless the new work is deliberately isolated on a different branch/worktree.

No session should begin by guessing what was done in a previous chat.

---

## 3. Mandatory update / handoff protocol

After every completed logical code change, and always before a conversation ends, update the **Current Workstreams** section in the branch-local copy of this file.

A workstream update must include:

- branch and worktree;
- baseline / current HEAD;
- exact goal;
- important files changed;
- tests run and their result;
- live validation performed and its evidence;
- known failures or uncertainty;
- next exact action;
- whether the branch is safe to PR/merge/rebase.

A code-changing session must never end with stale progress documentation.

For very small edits, the continuity update may be in the same commit. For a sequence of tightly related RED/GREEN commits, it may be a final handoff commit before stopping or opening/updating the PR.

### Branch-local truth

Each active branch carries its own copy of this file. Unmerged work remains branch-local truth.

After a PR is merged, the merged copy becomes canonical for that workstream. Other active branches are **not** automatically rebased or merged. They keep their own baseline until their owner explicitly performs a safe synchronization.

If this file conflicts during merge/rebase, merge the workstream records semantically. Never resolve it with blanket `ours` or `theirs`.

---

## 4. Program-level objective

The final system should behave like a durable Minecraft player, not a collection of hard-coded command cases.

The target is:

- understand high-level player intent;
- decompose long tasks into deterministic goals/skills;
- gather resources;
- discover and remember useful locations;
- obtain/equip tools;
- craft/process materials;
- use authorized storage;
- survive ordinary hazards;
- fight hostile mobs when policy says engagement is preferable to retreat;
- build structures, bases, and outposts in Survival-valid ways;
- persist and resume long-running projects;
- support vanilla and modded content without adding one `if` statement per mod/item/block;
- safely learn/import new game semantics through data/capability providers rather than granting AI direct world mutation.

The central authority rule remains:

> AI chooses high-level intent, semantics, and bounded plans. Deterministic code owns Minecraft mechanics, world mutation, resource accounting, tool use, combat execution, construction execution, safety, retry limits, and recovery.

AI output must never directly call Mineflayer mutation APIs, arbitrary Minecraft commands, shell code, or raw protocol operations.

---

## 5. Extensibility rule: no per-mod behavior forests

### 5.1 Hard rule

Do **not** grow code like:

```ts
if (mod === 'mod_a') { ... }
else if (mod === 'mod_b') { ... }
else if (item === 'some_mod:rifle') { ... }
```

for every new mod, ore, weapon, machine, or building block.

Mod/content support must be data-driven or capability-driven whenever the gameplay mechanic is structurally the same.

Namespaced IDs such as `minecraft:iron_ore` or `some_mod:uranium_ore` are data identifiers, not reasons to create new control-flow branches.

### 5.2 Generic behavior layers

The intended stack is:

```text
Player / AI high-level intent
        |
        v
Goal / Project planner
        |
        v
Generic Skill Registry
        |
        +--> Resource acquisition skills
        +--> Navigation / exploration skills
        +--> Production / tool skills
        +--> Interaction / item-use skills
        +--> Combat skills
        +--> Construction skills
        |
        v
Capability / Knowledge resolution
        |
        +--> committed versioned game knowledge
        +--> server/plugin capability descriptors
        +--> trusted runtime observations
        +--> authorized storage/project state
        |
        v
SafetyPolicy + scoped permits
        |
        v
Deterministic Minecraft adapters
```

A skill asks **what capability is needed**, not **which mod is installed**.

### 5.3 Resource example

`acquire_resource(resource, quantity)` should work for new ores/resources when an authoritative profile can provide facts such as:

- namespaced resource ID and aliases;
- source block IDs;
- collected item IDs;
- minimum drop semantics;
- required tool class/tier;
- forbidden tool/enchantment semantics;
- bounded server capability such as vein mining;
- confidence / authority source.

The generic acquisition coordinator should not need a new branch of code for every ore mod.

### 5.4 Weapon / gun example

Future hostile combat should not implement one skill per gun mod.

A generic combat/equipment capability should be able to describe, where safely knowable:

- item ID;
- melee/ranged role;
- attack/use action;
- effective range;
- cadence/cooldown;
- ammunition or energy requirement;
- reload/use constraints;
- safety constraints;
- target class restrictions.

The deterministic combat skill chooses and executes from these descriptors. Mod-specific adapters/providers may translate a mod's mechanics into this contract, but the combat planner should not contain `if (gun_mod_x)` logic.

PvP remains disabled unless a future explicitly approved design changes that hard policy.

### 5.5 Unknown content

Unknown or inferred mod content must fail closed for mutation-critical behavior.

Untrusted/inferred metadata may be shown to planning/context, but it must not automatically become mutation-authoritative.

New authoritative mechanics should enter through one of:

- versioned game knowledge packs;
- a reviewed server capability provider;
- a narrow adapter implementing an existing capability contract;
- an explicitly reviewed extension to the capability contract when the mechanic is genuinely new.

---

## 6. Skill architecture rule

Use one stable registry/router to connect many independently implemented skills.

Do **not** build one giant “universal skill” containing a large switch over every behavior.

Preferred shape:

```text
Goal / Task kind
   -> SkillRegistry lookup
      -> typed SkillDefinition
         -> capability/knowledge lookup
            -> SafetyPolicy permit
               -> deterministic executor
```

Each skill should have:

- one bounded responsibility;
- typed arguments;
- deterministic success/failure codes;
- bounded retries/budgets;
- explicit cancellation behavior;
- isolated tests;
- its own feature/fix branch when developed independently.

Cross-skill orchestration belongs above the skill layer in the acquisition coordinator or durable Project DAG, not inside unrelated individual skills.

---

## 7. Branch / worktree concurrency contract

### 7.1 One independently reviewable skill/workstream per branch

Preferred naming examples:

- `feature/skill-resource-acquisition`
- `feature/skill-hostile-combat`
- `feature/skill-production`
- `feature/skill-construction`
- `fix/resource-memory-recall`

Existing long-lived branches may keep their current names until their PRs land, but new work should become more granular.

### 7.2 One active conversation per worktree

Every concurrently active coding conversation must use a distinct Git worktree and distinct branch.

A conversation must not edit files in another conversation's worktree.

Recommended shape:

```text
D:\MC_AI_Player
D:\MC_AI_player-worktrees\resource-acquisition
D:\MC_AI_player-worktrees\hostile-combat
D:\MC_AI_player-worktrees\construction
D:\MC_AI_player-worktrees\production
```

### 7.3 A merged PR must not silently change another active branch

When one PR merges:

- do not auto-merge/rebase other active branches;
- their worktrees continue on the baseline they started from;
- synchronize only at a deliberate safe checkpoint;
- inspect conflicts before rebasing;
- rerun tests affected by the new base;
- never force-push another conversation's branch.

### 7.4 Shared contracts

If two skills require the same new shared interface:

1. identify the earliest owning/shared layer;
2. land that contract in an isolated prerequisite branch if possible;
3. dependent branches then synchronize deliberately;
4. do not independently invent incompatible duplicate contracts.

### 7.5 Current known worktrees / branches

Last observed from the local repository:

| Worktree | Branch | Last observed state | Rule |
| --- | --- | --- | --- |
| `D:\MC_AI_Player` | `feature/moxuebridge-capabilities` | active; PR #5; resource acquisition / server capability integration | current conversation may modify |
| `D:\MC_AI_player-worktrees\gemini-multi-model-routing` | `feature/gemini-multi-model-routing` | last observed `c2a61c5`, tracking origin | keep isolated |
| `D:\MC_AI_player-worktrees\project-autonomy-construction` | `feature/project-autonomy-construction` | local was last observed at `7a8ca4a`, **ahead of origin by 30 commits**; remote currently exposes docs-only history through `4d2ee69` | **do not reset/rebase/overwrite from another conversation; inspect this worktree locally first** |
| `D:\MC_AI_player-worktrees\modular-extension-core` | `feature/modular-extension-core` | M0-M7 modularization gate complete; 419 tests / 415 pass / 0 fail / 4 skipped; live Resource memory recall PASS | accepted modular integration baseline; use as prerequisite for new parallel gameplay modules |

The table is a handoff record, not a substitute for running `git worktree list` and `git branch -vv` at startup.

---

## 8. Existing long-term roadmap that must be preserved

The project already contains an approved durable project/autonomy/construction design on `feature/project-autonomy-construction`.

Important references:

- `docs/superpowers/specs/2026-09-13-project-autonomy-construction-design.md`
- `docs/superpowers/plans/2026-09-13-project-autonomy-construction-roadmap.md`
- Phase 1: chat feedback and deterministic tool use
- Phase 2: project state, identity, ACL, drafts, storage
- Phase 3: versioned game knowledge and supply planning
- Phase 4: blueprint, terrain, construction, survival/combat
- Phase 5: durable project DAG, AI planning, recovery, multiplayer integration

That roadmap already includes:

- versioned game facts;
- recipes/workstations/fuels/tools/combat facts;
- deterministic supply planning;
- exact blueprints and BOMs;
- Survival-valid construction;
- hostile-mob interruption/handling;
- durable multi-step project orchestration;
- restart reconciliation and offline continuation.

The extensibility rules in this continuity document are a program-wide requirement layered on top of that roadmap.

---

## 9. Current Workstreams

### WS-WORKSPACE-PLANNER — active

**Branch:** `feature/workspace-planner`  
**Proposed worktree:** `D:\MC_AI_player-worktrees\workspace-planner`  
**Base:** `b75cb48` (M7 SAFE PARALLELIZATION POINT)  
**Goal:** add a persistent user-defined workspace/area system driven by a dedicated setting wand, with generic region semantics and deterministic bounded directives such as lighting.

Design:

- `docs/superpowers/specs/2026-09-20-workspace-area-planner-design.md`
- `docs/superpowers/plans/2026-09-20-workspace-area-planner.md`

#### W0 contracts/geometry — PASS

Commit:

- `0656a12` — `feat: add workspace region geometry contracts`

Current behavior:

- two selected block points normalize to one inclusive axis-aligned cuboid;
- exact X/Y/Z sizes and volume are derived;
- chunk coverage is derived without enumerating every block;
- containment/intersection are deterministic;
- 5 x 10 x 10, 9 x 1 x 9, and 12-chunk examples have focused tests;
- workspace region labels/purpose/tags/constraints are bounded data;
- custom labels such as `快速熔爐` do not create mutation authority;
- horizontal/vertical selection spans are bounded while still allowing large multi-chunk workspaces.

Important integration boundary:

- MC_AI_Player cannot reliably observe another player's block click with a stick;
- the setting-wand click must arrive through a trusted Paper observation adapter (preferred MoxueBridge extension);
- visible wand name should be `墨雪設定棍`, with an internal persistent marker/version preferred as authoritative identity;
- selection observation never grants world-mutation authority.

**W0 verification:** full suite PASS — 426 tests total, 422 passed, 0 failed, 4 skipped; working tree clean.

#### W1 durable SQLite workspace repository — PASS

Commit:

- `98aec83` — `feat: persist durable workspace regions`

Current W1 scope:

- added `WorkspaceRegionInputSchema` and bounded workspace search query contract;
- added `WorkspaceRepository` interface;
- added `SqliteWorkspaceRepository`;
- workspace geometry is persisted as indexed min/max coordinates rather than opaque JSON;
- tags use a separate normalized table;
- query supports world, dimension, purpose, tags, owner and region intersection;
- create/update/get/search/delete are bounded and deterministic;
- provenance via `ownerPrincipal` and `sourceSelectionId` persists;
- repository uses foreign keys, busy timeout, NORMAL synchronous mode, WAL for file databases and a schema version;
- tests cover exact round-trip, update semantics, world/dimension isolation, spatial intersection, deletion cascade, restart persistence and strict rejection of transient/raw fields.

**W1 verification status:** full automated verification PASS — 432 tests total, 428 passed, 0 failed, 4 skipped; typecheck PASS; working tree clean.

#### W2 setting-wand selection observation contract — PASS

Commits:

- `8c3b893` — `feat: define workspace selection observation contract`
- `d27c660` — `fix: reject stale workspace selection snapshots`

Current W2 scope:

- added versioned `WorkspaceSelectionSnapshotSchema`;
- added strict query contract scoped by world + dimension + player identity;
- added `WorkspaceSelectionSource` and `WorkspaceSelectionTracker`;
- source states are `current | stale | unavailable`;
- last-known-good data is hidden from new workspace actions while source is stale;
- selection age is bounded and expired selections fail closed;
- selection identity is isolated by world, dimension and authoritative player id;
- malformed snapshots, duplicate identities, out-of-order whole snapshots, out-of-order selections and same-generation conflicting geometry fail closed;
- successful empty snapshot explicitly clears prior selections;
- old empty snapshots cannot erase newer selections;
- Paper/MoxueBridge semantic contract is documented in `docs/superpowers/specs/2026-09-20-moxuebridge-workspace-selection-contract.md`;
- transport endpoint/path is intentionally not fixed yet;
- setting-wand observation remains read-only and does not grant mutation authority.

**W2 verification status:** full automated verification PASS — 442 tests total, 438 passed, 0 failed, 4 skipped; working tree clean.

#### W3 Paper selection bridge + MC_AI transport — implementation in progress

W2 is complete.

Cross-repository implementation:

**MoxueBridge**

- repository: `neko0115/MoxueBridge`;
- branch: `feature/workspace-selection-observation`;
- base: `e99db18` from `feature/veinminer-capability-scope`;
- `ae249ca` — `feat: observe workspace wand selections`;
- `4e91fc5` — `feat: expose workspace selections over bridge api`.

Paper-side behavior:

- exact main-hand `minecraft:stick` display name `墨雪設定棍`;
- optional `moxuebridge:workspace_wand=v1` persistent marker is accepted/validated;
- left-click block sets A;
- right-click block sets B;
- wand interaction is cancelled to avoid using the clicked block;
- crossing world/dimension resets pending corners;
- completed selection generation is monotonic per player;
- authenticated read-only `GET /api/v1/workspace-selections`;
- endpoint uses snake_case semantic JSON only;
- no raw PlayerInteractEvent/NBT and no mutation authority.

**MC_AI_Player**

- `5a766f9` — `feat: consume bridge workspace selections`;
- `c7d72e0` — `feat: manage workspace selection source lifecycle`.

Client behavior:

- validates Bridge v1 wire schema;
- injects MC_AI_Player's actual connection `worldKey`;
- feeds the existing fail-closed `WorkspaceSelectionTracker`;
- authenticated polling uses existing MoxueBridge config;
- malformed/HTTP failure becomes stale/unavailable;
- selection source participates in application start/stop;
- selection data is intentionally NOT in AI context yet.

**W3 verification status:** automated cross-repository verification PASS; live Paper validation in progress.

Live evidence completed:

- deployed rebuilt MoxueBridge JAR to Paper and restarted the server;
- authenticated `GET /api/v1/workspace-selections` returned HTTP success with semantic snapshot:
  - `version = 1`;
  - finite `generated_at`;
  - initial `selections = []`;
- this proves the new plugin build is loaded and the authenticated read-only workspace-selection endpoint is active.

Remaining live gates:

- in-game `墨雪設定棍` A/B selection;
- endpoint returns the expected player/dimension/coordinates;
- MC_AI_Player workspace selection client reaches `current` and resolves the same selection.

Automated evidence:

- MC_AI_Player full suite: 445 tests total, 441 passed, 0 failed, 4 skipped; working tree clean;
- MoxueBridge `.\\gradlew.bat clean test build`: BUILD SUCCESSFUL; working tree clean;
- MC_AI workspace selection transport/lifecycle tests PASS as part of the full suite;
- MoxueBridge workspace selection store/API tests PASS as part of Gradle build.

**Next exact action:**

1. run MoxueBridge Gradle tests/build on `feature/workspace-selection-observation`;
2. run MC_AI focused workspace/bridge/main tests;
3. run MC_AI `npm run typecheck` and full suite;
4. if both repos are green, deploy the Bridge JAR to the test Paper server;
5. live-test `墨雪設定棍` A/B selection and authenticated endpoint output;
6. verify MC_AI source becomes `current` and resolves the same selection;
7. only then begin W4 chat/context binding for “這裡 / 剛才那區 / <workspace name>”.

**Do not:**

- implement lighting by hard-coded farm/furnace special cases;
- let region labels directly authorize mutation;
- expose raw Mineflayer Bot to this module;
- make Paper wand observations responsible for executing world changes.

---

### WS-MODULAR-EXTENSION-CORE — active / primary gate

**Branch:** `feature/modular-extension-core`  
**Base:** `c61d389` from `feature/moxuebridge-capabilities`  
**Goal:** establish a fail-closed modular extension architecture before opening parallel Production / Combat / Construction coding workstreams.

#### M0 design — PASS

Created:

- `docs/superpowers/specs/2026-09-20-modular-extension-core-design.md`
- `docs/superpowers/plans/2026-09-20-modular-extension-core.md`

Locked principles:

- no per-mod control-flow forests for content using existing mechanics;
- content extension is data/capability driven;
- genuinely new mechanics receive generic capability/runtime contracts;
- behavior modules remain deterministic below high-level planning;
- do not open parallel gameplay coding workstreams until the Modularization Gate passes.

#### M1 skill composition seam — PASS

Commit:

- `0eb0236` — `refactor: introduce skill module composition seam`

Changed:

- added `src/modules/skill-module.ts`;
- added `src/modules/builtin-skills.ts`;
- added `tests/modules/skill-module.test.ts`;
- removed direct navigation/survival/resource skill construction from `src/main.ts`;
- application composition now installs declared skill modules through `installSkillModules()`.

Safety/behavior constraints preserved:

- no skill name/schema change;
- no Goal/Decision contract change;
- no SafetyPolicy change;
- no gameplay algorithm change;
- duplicate module IDs fail before any module installs;
- existing `SkillRegistry` duplicate-skill rejection remains authoritative.

**Verification status:** M1 local FULL automated verification PASS — 404 tests, 400 passed, 0 failed, 4 skipped; working tree clean.

#### M2 trusted skill/action metadata catalog — PASS

Commits:

- `9a8b327` — `refactor: centralize trusted skill metadata`
- `83e0e57` — `fix: keep internal find resource outside action schema`

Current M2 scope:

- added `src/contracts/skill-catalog.ts` as the trusted metadata source;
- catalog carries canonical skill name, external args schema when applicable, AI exposure/description, safety capabilities, and mutation-authority class;
- `src/agent/skill-catalog.ts` now derives AI-visible descriptions from the trusted catalog;
- `tests/contracts/skill-catalog.test.ts` locks full canonical skill coverage, exact AI exposure ordering/descriptions, bounded args parsing, and current resource-mutation metadata;
- Goal/Decision schemas remain unchanged in M2;
- SafetyPolicy remains unchanged in M2.

**Verification status:** M2 local FULL automated verification PASS — 407 tests, 403 passed, 0 failed, 4 skipped; focused catalog/decision tests and typecheck PASS.

#### M3 catalog-derived Goal/Decision actions — PASS

Commits:

- `ef9cfdd` — `refactor: extract shared action argument schemas`
- `ad3f357` — `refactor: derive action schemas from trusted catalog`

Current M3 scope:

- moved shared bounded action argument schemas to `src/contracts/action-args.ts`;
- `src/contracts/goals.ts` still re-exports the old schema names for compatibility;
- trusted catalog now marks whether each skill is a direct Goal action and/or provider Decision action;
- `GoalRequestSchema`, `DecisionV1Schema`, and V2 action validation are generated from the trusted catalog;
- `DecisionGate` no longer contains a per-skill action-to-goal switch;
- internal-only `stop` and `find_resource` remain excluded from Goal/Decision actions;
- strict unknown-field rejection and existing bounded argument schemas are preserved;
- SafetyPolicy is intentionally unchanged until M4.

**Verification status:** M3 local FULL automated verification PASS — 409 tests, 405 passed, 0 failed, 4 skipped; working tree clean.

#### M4 catalog-owned Safety authority — PASS

Commits:

- `baa0d00` — `refactor: derive safety authority from trusted catalog`
- `c408cab` — `refactor: make safety trust the skill catalog`

Current M4 scope:

- removed caller-owned `SkillSafetyMetadata` from capability and resource-mutation authorization;
- `SafetyPolicy` now reads capabilities and mutation authority from the trusted skill catalog;
- `gather_resource` and `excavate_resource` no longer self-declare `break_blocks` when requesting a permit;
- resource-mutation authorization no longer contains hard-coded `gather_resource || excavate_resource` name checks;
- known-skill authorization now checks the trusted catalog instead of a separate SkillNameSchema authority list;
- PvP remains hard-denied;
- scoped mutation permits remain WeakSet-authenticated and bounded by allowed block names;
- tests were updated to prove catalog authority and fail-closed behavior.

**Verification status:** M4 local FULL automated verification PASS — 410 tests, 406 passed, 0 failed, 4 skipped; working tree clean. The stale Mineflayer gathering permit helper regression was fixed in `fd40a30`.

#### M5 typed runtime extension seam — PASS

Commits:

- `90474a3` — `refactor: add typed runtime extension ports`
- `7dcf85f` — `fix: preserve legacy runtime bundle injection`
- `fb4b460` — `test: preserve legacy runtime port injection`

Current M5 scope:

- added `RuntimePort<T>` tokens and `RuntimePortRegistry`;
- added built-in typed ports for adapter, survival inventory, and resource gathering;
- added a low-level `MineflayerRuntimeExtension` installer with duplicate-ID fail-closed behavior;
- default Mineflayer runtime registers typed semantic ports and keeps raw `Bot` hidden;
- port registry is stored on a Symbol property, so existing enumerable bundle keys remain exactly `adapter / inventory / gathering`;
- legacy/custom runtime bundles without the Symbol registry are adapted from their existing semantic ports for backward compatibility;
- survival skill wiring now consumes the inventory runtime through the typed port seam;
- tests cover typed lookup, duplicate port IDs, missing ports, invalid IDs, runtime extension registration, duplicate extension IDs, and legacy bundle adaptation.

**Verification status:** M5 local FULL automated verification PASS — 416 tests, 412 passed, 0 failed, 4 skipped; working tree clean.

#### M6 isolated Resource module proof — FULL PASS

Commit:

- `2435c20` — `refactor: isolate resource skill module`

Current M6 scope:

- added `src/modules/resource-module.ts` as the owner of the full resource workflow;
- resource module consumes only typed `MINECRAFT_ADAPTER_PORT` and `RESOURCE_GATHERING_PORT`, not the whole Mineflayer runtime bundle;
- resource module owns registration/wiring for `find_resource`, `explore_resource`, `excavate_resource`, `gather_resource`, and `acquire_resource`;
- resource profiles, server capabilities, memory, safety, state, telemetry, and leaf-cleanup policy are explicit module dependencies;
- `builtin-skills.ts` now composes the resource module instead of containing its internal wiring;
- tests assert the complete resource skill set, AI exposure of only `acquire_resource`, and fail-closed behavior when a required runtime port is missing.

**Verification status:** M6 FULL PASS.

Automated evidence:

- 418 tests total;
- 414 passed;
- 0 failed;
- 4 skipped;
- focused Resource module tests PASS;
- typecheck PASS;
- working tree clean.

Controlled Minecraft live memory-recall regression PASS:

- first run created a fresh resource memory after acquiring iron;
- Paper confirmed remembered source A at `-261 84 313` was consumed;
- backup B was then placed at `-258 84 313` and was not ore-connected to A;
- bot was moved away to about `(-247.5, 84, 317.5)`;
- second run emitted `visible -> memory`;
- memory navigation moved the bot back toward the remembered area, ending near `(-260.55, 84, 314.91)`;
- normal post-arrival visible/LOS rescan rediscovered nearby B;
- second run proceeded directly to `gather` without `explore` or `excavate`;
- inventory `raw_iron` increased 3 -> 4;
- `skill_completed` and `goal_completed` emitted;
- Paper confirmed A remained consumed and B was consumed;
- no hidden-block server lookup/X-ray path was introduced.

#### M7 Safe Parallelization Gate — PASS / SAFE PARALLELIZATION POINT

Acceptance criteria:

- module installer/composition seam is live in production wiring;
- trusted skill/action metadata is centralized;
- Goal/Decision action schemas are catalog-derived;
- Safety authority is catalog-owned and fail-closed;
- typed runtime extension ports exist without exposing raw Mineflayer Bot to skills;
- Resource gameplay family is isolated as an independent module using typed runtime ports;
- Resource module automated and controlled live regression evidence are PASS;
- adding a new generic behavior module no longer requires editing existing Resource/Survival/Navigation module internals;
- new modded resource content using an existing mechanic is data/profile driven rather than a new high-level skill;
- PROJECT_CONTINUITY documents branch/worktree ownership and no-cross-worktree reset/rebase rules.

M7 hardening commit:

- `49f3a57` — `refactor: close parallelization extension hotspots`

M7 implementation status:

- `SkillName` and `SkillNameSchema` now derive from the trusted skill catalog; the separate central enum is removed;
- Goal/Decision/AI/Safety/name authority now converge on the catalog;
- added `tests/modules/parallelization-acceptance.test.ts`;
- acceptance test creates an independent typed runtime port, installs it through the runtime-extension seam, installs a separate skill module, and executes it through `SkillRegistry -> SkillExecutor` without importing or modifying builtin gameplay modules;
- modularization design now documents the final extension recipe for future parallel workstreams;
- Resource M6 live proof is already FULL PASS.

**Verification status:** M7 FULL automated acceptance PASS.

Final M7 evidence:

- focused parallelization/catalog/resource/runtime-port acceptance tests PASS;
- `npm run typecheck` PASS;
- full suite: 419 tests total, 415 passed, 0 failed, 4 skipped;
- working tree clean;
- independent test module registered its own typed runtime port and executed through `SkillRegistry -> SkillExecutor` without editing builtin gameplay module internals;
- M6 Resource module already holds FULL automated + controlled Minecraft live PASS evidence.

**SAFE PARALLELIZATION POINT:** reached on 2026-09-20.

### Recommended parallel split after M7

The architecture is now safe for parallel gameplay-module work, subject to the branch/worktree rules above.

Recommended active coding conversations:

1. **Production / supply**
   - proposed branch: `feature/skill-production`
   - proposed worktree: `D:\MC_AI_player-worktrees\production`
   - scope: tool acquisition, crafting, smelting/processing, workstation use, versioned knowledge/supply planning;
   - do not edit Combat or Construction module internals.

2. **Hostile combat**
   - proposed branch: `feature/skill-hostile-combat`
   - proposed worktree: `D:\MC_AI_player-worktrees\hostile-combat`
   - scope: hostile mobs only, deterministic engage/retreat policy, generic weapon descriptors, bounded attack/reposition/reload/use loops;
   - PvP remains disabled.

3. **Project-autonomy / construction audit first**
   - existing branch/worktree: `feature/project-autonomy-construction` / `D:\MC_AI_player-worktrees\project-autonomy-construction`;
   - this worktree was last observed **ahead by 30 local commits**;
   - first action is inspection/audit only;
   - do not reset/rebase/overwrite it;
   - only after its unpublished state is understood should Construction be split to a new `feature/skill-construction` branch if appropriate.

Keep one integration/core conversation available for shared-contract changes. If two parallel workstreams need the same new contract, land that contract deliberately in the shared modular layer rather than independently editing each other's modules.

### Branch baseline rule

Until the modularization branch is merged into the chosen integration base, any new gameplay branch created from it is intentionally stacked. Record its exact base SHA in this file. Prefer branching from the latest accepted `feature/modular-extension-core` HEAD so every workstream inherits the M7 contracts and continuity rules.

**Parallel-work safety rules after M7:**

- Production and hostile-combat modules may now begin on distinct branches/worktrees;
- Construction must first audit the existing ahead-30 project-autonomy worktree;
- do not relax trusted catalog / Goal / Decision / Safety contracts from a feature branch merely to make one module easier;
- shared-contract changes belong to the modular/core integration layer;
- never merge/reset/rebase another active conversation's worktree without deliberate handoff.

---

### WS-RESOURCE-ACQUISITION — active

**Branch:** `feature/moxuebridge-capabilities`  
**PR:** #5 — `feat: consume MoxueBridge capabilities in Minecraft runtime` (Draft, stacked on PR #4)  
**Baseline before latest fix:** `ce2b7e8`  
**Current code fix commit:** `014d684` — `fix: tighten resource memory recall navigation`  
**CI on `014d684`:** PASS  
**Local full suite after the fix:** 401 tests, 397 passed, 0 failed, 4 skipped.

#### Goal

Validate a generic autonomous resource-acquisition coordinator:

```text
visible search
-> known resource memory
-> bounded no-dig exploration
-> bounded safe excavation
-> gather until newly acquired resource delta >= requested minimum
```

Vein mining may legitimately over-collect. Requested quantity is a minimum, not an exact cap.

#### Live validations already completed

- `excavate_resource` bounded 1x2 tunnel: PASS.
- stop when target becomes visible and preserve target: PASS.
- non-allowlisted/player block fail-closed before mutation: PASS.
- adjacent lava pre-mutation stop: PASS.
- no partial mutation on those hazards: PASS.
- `acquire_resource(iron_ore, quantity=1, exploreRadius=6, exploreSteps=2, excavateLength=6)` positive E2E: PASS.
  - observed `visible -> memory -> explore -> excavate -> memory_written -> gather`;
  - actual movement and cobblestone accumulation occurred;
  - raw iron increased by at least the requested amount;
  - `skill_completed -> goal_completed`.
- no suitable pickaxe: `correct_tool_unavailable` fail-closed: PASS.
- bounded search exhaustion: PASS.
- old inventory does not cause false completion: PASS.

#### Known Resource Memory regression

Controlled A/B fixture:

- stale/consumed ore A: `-261 84 313`;
- disconnected backup ore B: `-258 84 313`;
- Paper verification confirmed:
  - A was consumed;
  - B remained `minecraft:iron_ore`.

Second acquisition run:

- `visible -> memory`;
- memory navigation moved the bot from about `(-248.5,84,317.5)` back toward the remembered area;
- navigation exited around `(-260.46,84,316.99)`;
- it then entered `explore`, excavated cardinal directions, and ended `resource_search_exhausted`;
- B still existed afterward.

Root cause reproduced in an automated RED test:

- `tryKnownMemories()` used `goTo(memory.position, { range: 4, canDig: false })`;
- old fake navigation ignored `range` and teleported exactly to memory position, hiding the live bug;
- a range-sensitive fake reproduced `resource_search_exhausted`.

Fix on `014d684`:

```diff
- { range: 4, canDig: false }
+ { range: 1, canDig: false }
```

The existing normal-player visible rescan remains unchanged. No hidden-block/X-ray lookup was added.

#### Known Resource Memory live gate — PASS on later modularized descendant

The required controlled recall scenario was rerun on the later `feature/modular-extension-core` descendant and PASSed:

- second run emitted `visible -> memory`;
- bot navigated from about `(-247.5,84,317.5)` back near the remembered anchor;
- normal visible/LOS rescan rediscovered the disconnected backup ore B;
- run proceeded directly to `gather` without `explore` or `excavate`;
- `raw_iron` increased 3 -> 4;
- `skill_completed` and `goal_completed` emitted;
- Paper confirmed A and B consumed;
- no hidden-block/X-ray lookup was introduced.

This satisfies the original `014d684` live regression gate on an equivalent later descendant.

#### Next after memory recall passes

Do not immediately hard-code tool crafting inside `acquire_resource`.

The next resource/production work should move toward the generic knowledge/supply architecture:

- missing-tool dependency resolution;
- tool acquisition/crafting;
- versioned recipes/workstations;
- generic modded resource profiles;
- material supply planning.

---

### WS-PROJECT-AUTONOMY-CONSTRUCTION — isolated / inspect before work

A separate worktree already exists.

The remote branch contains the approved Phase 1-5 roadmap/design. The local worktree was last observed substantially ahead of remote. Treat it as unpublished active state until locally inspected.

Do not use PR #5 or the current resource-acquisition worktree to opportunistically modify construction/project files.

---

### WS-HOSTILE-COMBAT — future isolated workstream

Current hostile behavior has validated observation and suspend/retreat/resume safety behavior.

Future goal:

- distinguish retreat vs engagement under deterministic policy;
- hostile mobs only;
- choose a suitable available weapon/equipment capability;
- support vanilla and modded weapons through generic descriptors;
- bounded attack/reposition/reload/use loops;
- preserve hard health/death/retry limits;
- resume the interrupted higher-level goal when safe.

Do not implement combat as a list of per-mob or per-gun-mod special cases unless a mechanic is truly unique and cannot fit an existing capability contract.

---

### WS-CONSTRUCTION-OUTPOSTS — future / existing roadmap

Target examples:

- house;
- workshop;
- forward outpost;
- storage/supply point;
- temporary project infrastructure.

Implementation belongs to the existing project-autonomy/construction roadmap:

```text
intent
-> project/draft
-> architectural plan
-> deterministic blueprint + BOM
-> supply plan
-> terrain/scaffolding permits
-> construction executor
-> survival supervisor
-> checkpoint/recovery
```

Construction must use Survival-valid placement/reach/support and provenance-tracked temporary infrastructure.

---

## 10. Validation hierarchy

A feature is not FULL PASS just because unit tests are green.

Use these labels:

- **RED reproduced** — a regression test demonstrably fails for the expected reason.
- **Automated PASS** — focused tests pass.
- **Suite PASS** — full `npm test` and `npm run typecheck` pass.
- **Live PASS** — controlled Minecraft runtime evidence proves the intended behavior.
- **FULL PASS** — required automated + live gates are complete.
- **BLOCKED** — dependency or external condition prevents validation.
- **FAIL** — controlled validation proves behavior is wrong.

Every workstream entry must explicitly state which level it has reached.

---

## 11. Safety invariants that future features must not bypass

- Generic navigation defaults to `canDig=false`.
- World mutation occurs only through purpose-specific bounded skills and SafetyPolicy permits.
- No X-ray/hidden-block search for ordinary autonomous gameplay.
- Memory is a hint/area belief, not omniscient world truth.
- Player-built/protected content fails closed unless explicitly authorized.
- Arbitrary nearby storage is not automatically usable.
- PvP is disabled by default.
- Hostile-mob combat must not target players.
- Project/autonomy modes never bypass hard safety.
- Unknown mod semantics do not become mutation-authoritative merely because AI guessed them.
- Runtime retry/search/mutation budgets remain finite.
- Existing inventory counts must not create false “newly acquired” success.
- Minimum resource quantities allow safe over-collection from bounded chain mechanics.

---

## 12. Handoff template

Copy this block into the relevant workstream section when handing work to another conversation:

```md
#### Handoff YYYY-MM-DD HH:MM +08:00

Branch:
Worktree:
Base SHA:
Current HEAD:
Goal:

Changed:
- ...

RED evidence:
- ...

Automated verification:
- ...

Live verification:
- ...

Known issue / uncertainty:
- ...

Next exact action:
1. ...
2. ...

Do not:
- ...
```

The next conversation must continue from the **Next exact action**, not reconstruct a new plan from scratch unless the documented assumptions are disproven.
