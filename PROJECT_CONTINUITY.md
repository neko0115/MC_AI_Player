# MC_AI_Player Project Continuity Contract

> **MANDATORY:** Every AI assistant, coding conversation, or engineer MUST read this file before changing code in this repository.  
> Do not rely on chat memory alone. Do not assume another worktree or branch is synchronized.  
> Before ending a coding session, update the relevant progress section in this file so the next session can continue without reconstructing context from chat history.

**Last continuity update:** 2026-09-20  
**Current canonical development branch for this copy:** `feature/skill-production`  
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

### WS-PRODUCTION — active / isolated

**Branch:** `feature/skill-production`  
**Proposed worktree:** `D:\MC_AI_player-worktrees\production`  
**Base:** `b75cb48` (M7 SAFE PARALLELIZATION POINT)

**Goal:** generic production/supply behavior: missing-tool dependency resolution, crafting, smelting/processing, workstation use, and versioned knowledge/supply planning.

**Startup action:** audit the existing Phase 3 knowledge/supply design before writing code, then define the smallest independent Production module and typed runtime ports required.

**New user-visible acquisition requirement (2026-09-21):**

Observed live utterance:

- `墨雪幫我採一組石頭`;
- user observed no visible reaction.

Production must treat this as a generic item-acquisition requirement, not as a one-off `stone` patch.

Required architecture direction:

- introduce/complete a high-level item acquisition plan that can choose among:
  - already-held inventory;
  - authorized storage retrieval;
  - direct world resource acquisition;
  - crafting;
  - smelting/processing;
  - workstation/tool dependencies;
- do not assume every requested item is directly mined as itself;
- `minecraft:stone` is a canonical validation case:
  - ordinary mining of stone does not directly yield the stone item without Silk Touch;
  - valid plans may use an appropriate Silk Touch path when available or obtain cobblestone and smelt it to stone;
  - never silently reinterpret a request for stone as a request for cobblestone;
- “one stack / 一組” must be resolved from authoritative item stack-size knowledge;
  - do not globally hard-code one stack = 64 because some items stack to 16 or 1;
- namespaced vanilla/modded IDs remain data;
- unknown mutation-critical acquisition facts fail closed.

Shared-boundary rule:

- Production owns acquisition dependency/recipe/workstation/smelting knowledge and orchestration;
- the existing Resource module continues to own deterministic direct world search/gather;
- long-running task watchdogs, gameplay acknowledgement visibility, and Workspace hostile-tolerance policy belong to the separate Runtime Reliability workstream;
- if Production needs a new shared contract, land it deliberately rather than editing another active workstream's internals.

**Do not:**

- add per-item/per-mod recipe if forests;
- duplicate Resource module logic;
- edit Hostile Combat or Workspace module internals;
- bypass trusted catalog or SafetyPolicy.

#### Handoff 2026-09-21 22:xx +08:00 — Production knowledge / acquisition core slice

Branch: `feature/skill-production`  
Worktree: `D:\\MC_AI_player-worktrees\\production` (user-owned local worktree; this session wrote the connected GitHub branch directly)  
Base SHA: `b75cb48`  
Current remote HEAD at initial handoff write: `2264379d`  
Latest follow-up code HEAD before this continuity refresh: `2d400e57`  
Goal: establish the generic, exact-item Production knowledge / supply core without touching Resource internals, Runtime Reliability, or Workspace threat internals.

Audit completed:
- read this entire continuity contract and `WS-PRODUCTION`;
- read the approved Project Autonomy design and Phase 3 knowledge/supply plan from `feature/project-autonomy-construction`;
- confirmed this Production branch did not already contain the old Phase 3 implementation, so no existing Phase 3 code was duplicated;
- confirmed M7 typed runtime/module seams are the integration point and M7 itself was not reimplemented;
- identified that Resource's generic fallback may assume block/item identity for unknown resources; Production therefore only treats direct gathering as authoritative when an explicit exact-output acquisition fact exists, instead of changing Resource internals.

Changed:
- added `src/knowledge/contracts.ts`:
  - exact namespaced item IDs;
  - authoritative per-item `stackSize`;
  - explicit exact-output world acquisition facts;
  - recipe / processing / fuel / tool / workstation facts;
  - data-driven tool tier ranks and enchantment requirements;
  - cross-reference and duplicate validation;
  - unknown mutation-critical facts fail closed;
  - no global stack-size ceiling is hard-coded.
- added `src/knowledge/graph.ts`:
  - bounded/cycle-safe reverse production graph;
  - exact output matching, so a cobblestone drop route is not a stone route;
  - deterministic batch calculation and route ordering.
- added `src/knowledge/loader.ts` plus `fixtures/game-data/java/test-1.0/*`:
  - exact Java-version loading only;
  - no nearest-version fallback;
  - metadata mismatch and traversal-like version strings rejected.
- added `src/supply/planner.ts`:
  - inventory -> authorized storage -> exact world/craft/process dependencies;
  - tool class/tier/enchantment dependency resolution;
  - workstation dependency resolution;
  - processing fuel arithmetic;
  - bounded recursion / node budget;
  - unresolved/fail-closed results rather than invented acquisition semantics.
- added `src/minecraft/production.ts`:
  - independent typed `minecraft.production` runtime port;
  - runtime receives already-selected recipe/processing IDs and batch counts, so it does not choose production strategy.
- added `src/skills/production.ts` and `src/modules/production-module.ts`:
  - internal-only `craft_item` / `process_item`;
  - strict args and cancellation;
  - module requires only the Production runtime port.
- added internal Production skill names to the trusted skill catalog with `goal=false`, `decision=false`, `ai.exposed=false`; existing AI/Goal/Decision surfaces remain unchanged.
- added focused tests under `tests/knowledge/`, `tests/supply/`, `tests/skills/production.test.ts`, and `tests/modules/production-module.test.ts`.

Canonical validation cases now encoded in tests:
- one stack uses the requested item's authoritative max stack:
  - stone 64 in the fixture;
  - ender pearl 16 (validated from existing inventory; no fake direct-acquisition route is invented);
  - diamond pickaxe 1;
  - unknown item stack fact fails closed.
- `minecraft:stone` exact identity:
  - `mine_cobblestone` is never accepted as direct completion for stone;
  - without a usable Silk Touch tool, the plan is cobblestone acquisition -> furnace/fuel -> smelting -> stone;
  - with a usable Silk Touch tool, an explicit exact-stone direct route may be selected.
- inventory and explicitly provided authorized storage are consumed before production;
- an unknown mod item with no authoritative acquisition/production route remains unresolved instead of inventing direct gathering.

RED evidence:
- not recorded as a formal RED run in this chat environment; GitHub connector writes do not expose the user's Windows worktree execution environment.

Automated verification:
- **NOT RUN in this session.**
- GitHub CI does not trigger on this stacked branch push; current workflow triggers only on `main` pushes or PRs targeting `main`.
- do not mark this slice Automated PASS until the user-owned Production worktree runs focused tests, full `npm test`, and `npm run typecheck`.

Live verification:
- **NOT RUN.**
- No Minecraft live mutation was attempted in this slice.

Known issue / uncertainty:
- Mineflayer production execution adapter is not implemented yet; the typed runtime contract and internal module seam are ready for it.
- Crafting runtime must execute the planner-selected recipe rather than choose an arbitrary recipe for the output item.
- Furnace-style processing should use bounded `openFurnace / putInput / putFuel / takeOutput` execution with abort/disconnect cleanup; stonecutting needs its own reviewed adapter/capability rather than being guessed.
- the committed real `1.21.1` knowledge pack/generator is not implemented yet; current fixture is deliberately `test-1.0`.
- direct non-resource acquisition mechanics (for example trading or entity-drop-specific executors) are not implicitly trusted; they require future reviewed capability/runtime contracts and must fail closed until then.
- an early schema draft imposed `stackSize <= 99`; this was removed because authoritative modded stack sizes must not inherit an arbitrary vanilla-ish ceiling.
- because this session wrote the connected GitHub branch, the local worktree may be behind the remote branch. Inspect local status before fast-forwarding; do not overwrite local unpublished changes.

Next exact action:
1. In `D:\\MC_AI_player-worktrees\\production`, verify clean/expected status, fetch the branch, and fast-forward only if safe.
2. Run focused tests:
   - `npm test -- tests/knowledge/contracts.test.ts tests/knowledge/graph.test.ts tests/knowledge/loader.test.ts tests/supply/planner.test.ts tests/skills/production.test.ts tests/modules/production-module.test.ts`
   - `npm run typecheck`
3. Fix any RED/type failures before expanding scope.
4. Add the bounded Mineflayer Production runtime through the existing runtime-extension seam; do not add raw Bot access to skills.
5. Add exact-version knowledge generation and commit the real server `1.21.1` pack from the pinned Mineflayer-compatible `minecraft-data`.
6. Wire high-level item acquisition orchestration to Resource only through explicit exact-output acquisition facts, then live-validate `墨雪幫我採一組石頭`.
7. Only after focused + full suite/typecheck PASS, perform controlled Minecraft live crafting/smelting validation.

PR / merge status:
- **NOT SAFE TO PR/MERGE YET** — implementation slice is incomplete and automated/live verification has not run.

Do not:
- patch `stone`, `iron`, or mod IDs with item-specific control flow;
- reinterpret stone as cobblestone;
- assume one stack is 64;
- edit Resource acquisition internals to make Production easier;
- edit Runtime Reliability or Workspace threat internals;
- expose Production internal leaf skills directly to AI.


#### Handoff 2026-09-22 15:xx +08:00 — Generic item acquisition orchestration / exact processing source

Branch: `feature/skill-production`  
User worktree: `D:\\MC_AI_player-worktrees\\production`  
Remote branch was edited through the connected GitHub repository in this session; the user-owned Windows worktree was not inspected or mutated directly.

Scope boundary preserved:
- Modular M7 was audited and **not** reimplemented;
- Runtime Reliability watchdog / acknowledgement internals were not edited;
- Workspace threat / hostile-tolerance internals were not edited;
- Resource search/gather algorithms were not duplicated or modified;
- Production only added the generic item/supply orchestration layer and typed semantic boundaries.

Audit findings:
- continuity handoff was stale: the branch already contained later Mineflayer Production runtime and 1.21.1-oriented generator work before this session;
- `planItemAcquisition()` already modeled exact item identity, per-item stack size, inventory/storage/tool/workstation/fuel dependencies, but it only attempted the first ranked route for an output;
- high-level item acquisition did not exist;
- calling `SkillExecutor.execute()` recursively from a composite Production skill is invalid because the executor is single-active and would return `executor_busy`;
- knowledge uses canonical IDs such as `minecraft:stone`, while Mineflayer inventory uses runtime names such as `stone`; this namespace boundary must be adapted generically;
- `minecraft-data@3.116.0` 1.21.1 provides items/blocks/crafting data but does not provide the complete furnace/processing graph needed for exact stone -> cobblestone -> smelting -> stone planning;
- generated normal world-drop facts did not previously forbid Silk Touch when Silk would change the observed drop identity.

New Production commits in this session:
- `4f2149d` — `test: require deterministic supply route fallback`
- `e412908` — `fix: backtrack across authoritative supply routes`
- `231bc63` — `feat: execute deterministic supply plans`
- `3186453` — `test: cover exact supply plan execution`
- `39618e4` — `feat: define generic item acquisition arguments`
- `f2052a2` — `feat: export item acquisition goal schema`
- `5a183c9` — `feat: register generic item acquisition contract`
- `b8d5304` — `feat: coordinate generic exact item acquisition`
- `63ebe52` — `test: cover generic item acquisition quantities`
- `ee66719` — `test: include generic item acquisition contract`
- `c3fe1cf` — `feat: allow production module to register item acquisition`
- `0509546` — `fix: preserve planner node budget failure`
- `9cc8de2` — `test: forbid silk touch on changed normal drops`
- `17a98ea` — `fix: keep generated normal drops silk-safe`
- `6ea0d7a` — `feat: bridge canonical supply ids to runtime ports`
- `9e7b673` — `test: cover generic supply runtime boundary`
- `a8266d9` — `test: type supply runtime adapter fakes exactly`
- `0d916ea` — `test: define versioned vanilla processing import`
- `b8de52c` — `feat: import exact vanilla processing recipes`
- `0383321` — `build: accept versioned vanilla recipe summaries`
- `c9ecf9f` — `fix: carry exact world fact into supply execution`
- `faefd32` — `refactor: require exact world fact at resource leaf`
- `51c1634` — `test: pass exact world facts through runtime adapter`
- `c90d85f` — `test: execute world acquisition from authoritative facts`
- `a025709` — `test: back supply execution with exact world facts`

Implemented:
- supply planner now tries deterministic ranked alternatives transactionally:
  - each candidate route runs against cloned inventory/storage/tool/workstation planner state;
  - only a successful candidate commits state/steps;
  - failed candidates cannot leak partial steps/unresolved state;
  - existing depth/node budgets remain shared and bounded;
  - node-budget exhaustion remains authoritative instead of being hidden by an earlier route failure.
- added `src/supply/executor.ts`:
  - refuses unresolved plans before mutation;
  - executes authorized storage withdrawal, tool equip, Resource acquisition leaf, workstation resolution, craft, and process steps;
  - verifies exact world-acquisition output by inventory delta;
  - verifies final requested item identity/count;
  - never silently treats cobblestone as stone.
- added high-level `acquire_item` contract/skill:
  - args are `item + quantity + unit(items|stacks)`;
  - `stacks` resolves through authoritative `ItemFact.stackSize`;
  - tests cover 64-stack stone semantics, 16-stack ender pearl semantics, and 1-stack unstackable tool semantics without a global 64 assumption;
  - unknown item facts fail closed;
  - resolved item count remains bounded.
- `createProductionSkillModule()` can optionally register `AcquireItemSkill`; builtin composition intentionally does **not** register it yet until exact-version knowledge + semantic leaf/resolver dependencies are supplied.
- added `src/supply/runtime-adapter.ts`:
  - canonical vanilla IDs such as `minecraft:stone` map to Mineflayer runtime names such as `stone` only at the semantic boundary;
  - non-vanilla namespaced IDs remain namespaced;
  - Resource acquisition is injected as a narrow leaf capability instead of nested `SkillExecutor` execution;
  - the leaf receives the complete authoritative `WorldAcquisitionFact`, not only a resource string;
  - exact output/tool/enchantment constraints therefore remain available at the mutation boundary; a future shared Resource binding must reject unsupported constraints before block mutation.
  - storage/workstation resolution is authorization-driven and fails closed if no resolver exists.
- generator normal-drop safety:
  - if a block has an item identity and its deterministic ordinary drop is a different item, generated ordinary route now forbids `silk_touch`;
  - this is generic/data-driven, not a stone special case;
  - positive Silk Touch self-drop routes are **not** invented and still require reviewed authoritative facts.
- added versioned vanilla processing import:
  - `normalizeVanillaProcessingRecipes()` converts exact datapack `smelting / blasting / smoking / stonecutting` recipes into Production processing facts;
  - vanilla item tags are recursively expanded into separate exact routes;
  - missing/cyclic tags fail closed;
  - workstation facts for crafting table/furnace/blast furnace/smoker/stonecutter are generated only when those items exist in the exact-version item set;
  - generator CLI now accepts `--vanilla-summary <root>`, expecting versioned summary files:
    - `data/recipe/data.json`
    - `data/tag/item/data.json`
  - reviewed overlay input remains additive and duplicate IDs remain fail-closed.

Version-data source decision:
- for complete vanilla processing recipes, use a versioned build-time datapack/data-generator source rather than item-specific code;
- `misode/mcmeta` was audited as a practical source because its per-version `<version>-summary` / `<version>-data-json` tags are generated from Mojang server/data-generator output;
- 1.21.1 examples verified from that source include:
  - `minecraft:stone`: cobblestone -> stone smelting;
  - raw iron -> iron ingot smelting;
  - versioned smoking/blasting/stonecutting entries;
- this external source is a build-time knowledge input, **not** a runtime network dependency.

Still intentionally unresolved / fail-closed:
- **fuel burn-time facts** are not supplied by the vanilla datapack recipe summary; do not invent them in code. They still require a reviewed exact-version overlay or a future authoritative server capability source.
- a positive Silk Touch acquisition route requires authoritative reviewed knowledge; the generator only prevents the wrong ordinary-drop route from using Silk Touch.
- authorized workstation resolver is not yet supplied by builtin composition; Production executor will return workstation unavailable rather than use arbitrary nearby blocks.
- authorized storage resolver is not yet supplied by builtin composition.
- live tool/enchantment snapshot is not yet exposed as a Production planning-state source; therefore direct Silk Touch selection is not yet live-wired.
- the Resource module currently constructs `AcquireResourceSkill` internally; Production still needs a deliberately shared narrow resource-acquisition semantic port/binding before builtin live registration. Do **not** reimplement Resource search/memory/excavation.
- specifically, the existing Resource execution path may prepare tools from its own `ResourceProfile`; it cannot yet be assumed to preserve a Production-selected required enchantment such as Silk Touch. The shared leaf must prove/guarantee the passed world fact before mutation, or fail closed.
- real generated `game-data/java/1.21.1/*` is not committed yet.
- `acquire_item` is in the trusted contract catalog but is only AI-visible if actually registered; current builtin wiring does not register it yet.

Validation status in this session:
- RED intent was encoded in new focused tests before the corresponding planner/generator changes where practical.
- **Automated tests/typecheck: NOT RUN.**
- reason: this chat session does not have direct access to `D:\\MC_AI_player-worktrees\\production`, and branch pushes do not trigger the repository CI workflow (CI is main-push / PR-to-main).
- **Minecraft live validation: NOT RUN.**
- do not treat these commits as PASS until local focused tests + full suite + typecheck run.

Next exact actions:
1. In `D:\\MC_AI_player-worktrees\\production`, inspect status first, fetch remote, and only fast-forward/rebase if there are no unpublished local changes.
2. Run focused:
   - `npm test -- tests/supply/planner.test.ts tests/supply/executor.test.ts tests/supply/runtime-adapter.test.ts tests/skills/item-acquisition.test.ts tests/scripts/generate-game-knowledge.test.ts tests/contracts/skill-catalog.test.ts tests/modules/production-module.test.ts`
   - `npm run typecheck`
3. Fix all RED/type failures before adding more live wiring.
4. Add a narrow shared Resource acquisition leaf/binding so Production can delegate exact world acquisition without nested executor calls or copied Resource logic.
5. Add Production planning-state source for canonical inventory + owned tools/enchantments + explicitly authorized storage/workstations.
6. Prepare exact 1.21.1 build-time inputs:
   - minecraft-data item/block/crafting facts;
   - versioned vanilla recipe/tag summary for processing;
   - reviewed exact-version fuel facts and any reviewed Silk Touch/world-acquisition overlays.
7. Generate and commit `game-data/java/1.21.1/*`; run loader/reference validation.
8. Only then supply `itemAcquisition` dependencies to builtin Production module so `acquire_item` becomes AI-visible.
9. Controlled live validation:
   - `墨雪幫我採一組石頭`;
   - assert requested quantity = authoritative `minecraft:stone.stackSize`;
   - assert exact final inventory delta is `minecraft:stone`, not cobblestone;
   - test both available legal routes where fixture/environment permits: reviewed Silk Touch route and cobblestone -> legal fuel -> furnace -> stone route.
10. After focused PASS, run full `npm test` + `npm run typecheck` and only then consider PR/merge readiness.

PR / merge status:
- **NOT SAFE TO PR/MERGE YET.**
- generic core is materially further along, but local automated verification, exact 1.21.1 generated pack, shared Resource leaf wiring, authorized workstation/storage state, fuel knowledge, and live validation remain gates.


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
