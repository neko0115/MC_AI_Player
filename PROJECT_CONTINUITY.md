# MC_AI_Player Project Continuity Contract

> **MANDATORY:** Every AI assistant, coding conversation, or engineer MUST read this file before changing code in this repository.  
> Do not rely on chat memory alone. Do not assume another worktree or branch is synchronized.  
> Before ending a coding session, update the relevant progress section in this file so the next session can continue without reconstructing context from chat history.

**Last continuity update:** 2026-09-20  
**Current canonical development branch for this copy:** `feature/moxuebridge-capabilities`  
**Current HEAD after this document lands:** see the branch log; the code baseline immediately before this document was `014d684`.

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

#### M1 skill composition seam — implementation in progress

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

**Verification status:** GitHub CI/local verification pending for `0eb0236`.

**Next exact action:**

1. create/check out a local worktree for `feature/modular-extension-core`;
2. run focused module/main tests + typecheck;
3. run full `npm test`;
4. fix only wiring/type regressions, if any;
5. after M1 is green, begin M2 trusted skill/action metadata catalog.

**Do not:**

- start Combat/Production/Construction implementation yet;
- relax Skill/Goal/Decision schemas yet;
- change SafetyPolicy authority in M1;
- merge/reset the existing project-autonomy worktree.

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

#### CURRENT LIVE GATE — not yet completed

Restart/deploy MC_AI_Player at `014d684` or later and rerun the controlled memory recall scenario.

PASS requires:

1. start away from the remembered area;
2. `visible -> memory`;
3. navigate sufficiently near the remembered anchor;
4. normal visible/LOS rescan rediscovers a still-existing nearby backup ore;
5. gather it;
6. target inventory delta for the run is `>= requested quantity`;
7. `skill_completed`;
8. `goal_completed`;
9. over-collection by a bounded vein-mining chain is valid.

If this still fails, inspect geometry/LOS and actual arrival coordinates before widening any scan or adding new behavior. Preserve the no-X-ray rule.

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
