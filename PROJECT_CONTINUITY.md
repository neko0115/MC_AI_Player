# MC_AI_Player Project Continuity Contract

> **MANDATORY:** Every AI assistant, coding conversation, or engineer MUST read this file before changing code in this repository.  
> Do not rely on chat memory alone. Do not assume another worktree or branch is synchronized.  
> Before ending a coding session, update the relevant progress section in this file so the next session can continue without reconstructing context from chat history.

**Last continuity update:** 2026-09-21
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

### WS-RUNTIME-RELIABILITY — Suite PASS / Live validation active

**Branch:** `feature/runtime-reliability`  
**Worktree:** `D:\\MC_AI_player-worktrees\\runtime-reliability`  
**Base branch:** `integration/m7-workstreams`  
**Base SHA:** `766e66cddf5334fb0c9c9f614f2b2ac7ea805104`  
**Implementation HEAD before this handoff update:** `4b0ae3c24f2bf75e02fb1a0ccb6640cd00ff4323`

**Exact goal:**

1. Prevent long-running gameplay work from silently hanging.
2. Reproduce and fix the no-response ingress bug for the exact utterance `墨雪幫我採一組石頭`.
3. Add fail-closed Workspace-scoped controlled-hostile tolerance without any global mob exception.

**Concurrency boundary:**

- do not edit `feature/skill-production` worktree;
- Production owns general item acquisition dependencies/recipes/workstations;
- Runtime Reliability owns runtime progress/visibility and Workspace hostile-tolerance;
- shared contract changes require deliberate integration.

#### Implemented behavior

Diagnostic result for the exact no-response utterance:

- RED reproduced `墨雪幫我採一組石頭` at `TriggerClassifier`;
- root cause was the address parser requiring whitespace/comma/colon after every bot alias, so the CJK direct-prefix form was classified as `state_only` before Workspace routing, task creation, model routing, or gameplay execution;
- fix is script-aware: CJK `墨雪` may directly prefix an instruction, while ASCII aliases still require an explicit boundary so strings such as `moxuehelper` do not trigger the bot.

Runtime reliability changes:

- deterministic Minecraft acknowledgement on accepted addressed work plus bounded terminal completion/failure replies;
- Workspace semantic routing has a finite watchdog and abort release so one hung provider cannot poison the serialized route tail;
- logical decision routing has a finite outer watchdog above normal provider failover;
- provider unavailable with no retry time is terminal instead of leaving a permanent `decision_pending` task;
- bounded replan count prevents endless goal-fail/replan loops;
- non-continuous gameplay goals have a no-progress watchdog; intentional continuous `stay` / `follow_player` goals are exempt;
- skill cancellation cleanup is bounded while preserving the single-active-skill invariant; a non-cooperative old skill is never overlapped by a new gameplay skill;
- watchdog telemetry is best-effort and cannot itself delay the safety action.

Controlled-hostile Workspace policy is data-driven, not a mob special case:

- `constraints.controlledHostiles = [{ kind, maxCount }]`;
- active Workspace + exact canonical hostile kind + bounded count only;
- matching hostile must remain inside the Workspace;
- over-count, outside-region, archived Workspace, stale/unavailable metadata, malformed metadata, world/dimension mismatch, or repository failure all fail closed to normal `ThreatSupervisor`;
- Workspace repository mutation notifications trigger immediate threat re-evaluation, so archive/constraint changes do not wait for the hostile to move;
- Control API maps the contract as `controlled_hostiles: [{ kind, max_count }]`;
- Workspace Gemini semantic tools expose the same bounded contract;
- PvP policy is unchanged.

Focused regression coverage includes:

- exact `墨雪幫我採一組石頭` ingress;
- ASCII alias false-positive boundaries;
- hung Workspace route, hung decision, hung skill cleanup, hung non-continuous goal, and replan exhaustion;
- continuous-goal watchdog exemption;
- one controlled hostile, count overflow, hostile leaving bounds, archived Workspace, stale source, kind mismatch, malformed/bounded constraint validation, repository mutation invalidation, REST mapping, and semantic tool reconstruction.

#### Automated verification — PASS 2026-09-22

Local verification from `D:\\MC_AI_player-worktrees\\runtime-reliability`:

- `npm test`: **561 tests / 557 passed / 0 failed / 4 skipped**;
- `npm run typecheck`: **PASS** (`tsc -p tsconfig.json --noEmit`);
- working tree was clean before this continuity update;
- local branch and remote were aligned at `4b0ae3c`.

Validation level reached: **Suite PASS**.

#### Live startup / environment evidence — PASS 2026-09-22

A new Runtime Reliability worktree did not initially contain local runtime-only configuration. The live startup investigation established:

- `.env` is local/untracked and must be supplied per worktree;
- `data/ai-routing.json` is also required for Gemini routing and was absent in the new worktree;
- do **not** copy the whole `data` directory just to bootstrap a worktree, because it may contain runtime state such as memory/workspace/quota/telemetry SQLite/JSONL files;
- the copied Workspace Planner `.env` used the wrong Minecraft identity for this validation (`MC_USERNAME=Moxue_Test`);
- Runtime Reliability was corrected to use the intended Microsoft Minecraft account setting `MC_USERNAME=moxueneko@gmail.com`, `MC_AUTH=microsoft`.

A separate live configuration defect was also found:

- MoxueBridge HTTP API defaults to TCP `8766`;
- MC_AI_Player Control API also defaults to TCP `8766`;
- running both on the same host causes a deterministic bind collision:
  - MoxueBridge: `java.net.BindException: Address already in use`;
  - MC_AI_Player: `listen EACCES ... 127.0.0.1:8766`;
- the live environment was resolved by keeping MoxueBridge on `8766` and moving MC_AI_Player Control API to a distinct port (current recommended local assignment: `MC_CONTROL_PORT=8768`; Admin remains `8767` when enabled);
- after correcting the local runtime configuration, MC_AI_Player successfully entered the Minecraft server.

This port conflict is a runtime configuration/integration issue; no claim is made that the Runtime Reliability code itself caused the bind failure.

#### Live validation evidence / remaining work

Startup/login is proven. Workspace selection live behavior was also exercised:

- the player successfully completed a MoxueBridge wand selection in-game;
- an immediate Workspace create utterance still returned `missing_selection`;
- after waiting beyond the current MoxueBridge selection polling interval (~30 s), the same utterance succeeded and created the Workspace;
- this confirms a live freshness/UX gap: in-game selection state is available before MC_AI_Player's polled WorkspaceSelectionSource observes it;
- do not treat a ~30 s wait as acceptable final UX. Prefer a dedicated fast/on-demand selection refresh or event-driven selection invalidation/update rather than globally increasing polling load for unrelated capability/resource snapshots.
- a second live integration inconsistency was found while querying the created Workspace: `/v1/status` exposes nearby player UUIDs in hyphenated Minecraft form, while `MinecraftIdentityRegistry.resolveObservedPlayerId()` normalizes Workspace actor principals to lowercase 32-hex UUIDs without hyphens; using the status UUID verbatim as `actor_principal` therefore returns an empty Workspace list even though the Workspace exists. For current live validation, normalize the UUID by removing hyphens before Workspace API calls. This should be treated as an API consistency/ergonomics defect, not as missing Workspace data.

This conversation/worktree is **not FULL PASS yet**. The remaining live responsibility here is the Workspace controlled-hostile / ThreatSupervisor path only.

The exact addressed utterance `墨雪幫我採一組石頭` remains relevant regression coverage in this branch, but its live ingress validation is owned by a separate active conversation/workstream. Do not duplicate that live test here and do not modify Production/item-supply behavior from this worktree.

Controlled-hostile live matrix owned by this worktree:

1. active Workspace + exactly 1 authorized `zombie` inside bounds -> no threat suspend/retreat;
2. second matching zombie inside the Workspace -> normal ThreatSupervisor resumes immediately;
3. authorized zombie leaves Workspace bounds -> normal ThreatSupervisor resumes immediately;
4. Workspace is archived while the zombie remains -> repository mutation causes immediate threat re-evaluation and normal ThreatSupervisor resumes;
5. a non-matching hostile kind (for example `skeleton`) remains a normal threat;
6. after the matrix passes, run a bounded controlled-hostile soak test to confirm no intermittent suspend/resume loop or stale exemption.

#### Known issue / uncertainty

- `npm start` currently executes `tsx src/main.ts` and therefore does not load a local `.env` automatically; live runs that depend on file-based environment configuration must use Node's `--env-file` (or an equivalent deliberate launcher) unless the startup script is separately changed.
- The MoxueBridge/MC_AI_Player default `8766` collision is now documented, but changing global/default port policy is not part of this Runtime Reliability implementation unless separately approved.
- Live ingress validation for `墨雪幫我採一組石頭` is intentionally delegated to another active conversation; this worktree must not duplicate or interfere with that validation.

#### Next exact action

1. Keep Paper + MoxueBridge + MC_AI_Player running with non-conflicting ports and the intended Minecraft bot identity.
2. Create or select an **active Workspace** around the controlled-zombie fixture and set `constraints.controlledHostiles = [{ kind: "zombie", maxCount: 1 }]`.
3. Execute the controlled-hostile live matrix above and capture evidence for each transition.
4. Run a bounded controlled-hostile soak test.
5. Only after those gates pass, mark the controlled-hostile Runtime Reliability portion **FULL PASS / safe to integrate**; do not wait on or duplicate the stone-ingress conversation's separate live gate.

**PR/merge status:** code is **Suite PASS**. This worktree's remaining merge gate is the controlled-hostile live matrix + bounded soak; stone-ingress live validation is tracked separately by another active conversation.

---

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

#### W3 Paper selection bridge + MC_AI transport — FULL PASS

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
- `c7d72e0` — `feat: manage workspace selection source lifecycle`;
- `798a627` — `feat: expose workspace selection sync status`.

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

Live wand evidence:

- normal left-click A + right-click B produced generation 1 with correct overworld/player/coordinates;
- ordinary unnamed stick left the selection id/generation/selected_at unchanged — PASS;
- repeating a new A click after completion exposed a live race in the first implementation: the store combined new A with old B and emitted a new complete generation immediately;
- a subsequent full A+B reselection therefore advanced generation twice (2 -> 4), proving that polling between the two clicks could observe an unintended mixed selection.

Regression fix:

- MoxueBridge `1516105` — `fix: isolate fresh workspace selection cycles`;
- after a completed selection, the next A or B click starts a fresh pending selection;
- previous complete selection is hidden while the new cycle is incomplete;
- repeated same-corner clicks only update the pending corner;
- generation increments exactly once when both fresh corners exist;
- supports either A->B or B->A order without reusing an old corner.

Live wand regression verification PASS after MoxueBridge `1516105`:

- first fresh A+B selection -> generation 1 with correct overworld/player/coordinates;
- starting a new selection with A only -> endpoint `selections = []`;
- ordinary unnamed stick -> endpoint remains `selections = []`;
- new fresh A+B selection -> generation 2, not 3/4, with only the new coordinates;
- this proves old corners are not reused and incomplete pending selections are not externally exposed.

**Paper setting-wand observation LIVE PASS.**

W3 live transport verification PASS:

- fresh Bridge selection:
  - id `1931c7c2-2acc-48be-91ad-8b537d88c435`;
  - generation `3`;
  - dimension `overworld`;
  - A = `(-198,63,253)`;
  - B = `(-190,63,270)`;
- MC_AI_Player `GET /v1/workspace-selection` returned:
  - `sync_state = current`;
  - `last_error_code = null`;
  - identical id / generation / dimension / player / A / B / selected_at;
  - injected MC connection world key `127.0.0.1:25565`;
- this proves Paper -> MoxueBridge -> MC_AI selection source parity end to end.

**W3 LIVE PASS.**

W3 final automated verification PASS:

- full suite: 447 tests total;
- 443 passed;
- 0 failed;
- 4 skipped;
- typecheck PASS;
- working tree clean.

Combined with the controlled live parity evidence above, W3 is now **FULL PASS**.

#### W4 Workspace lifecycle management — implementation in progress

Locked behavior:

- durable status = `active | archived`;
- ordinary user "delete" maps to archive;
- archived workspaces remain queryable for history/dependencies but are excluded from ordinary resolution/execution;
- restore is supported;
- lifecycle mutations append safe audit transactionally;
- hard purge remains a separate dependency-safe maintenance operation;
- selection observation and durable workspace state remain separate.

W4A commits:

- `39dbdb5` — `feat: add audited workspace lifecycle`;
- `0d9d57e` — `fix: clone workspace lifecycle update inputs`.

W4A scope:

- added workspace `active | archived` status;
- ordinary repository search excludes archived rows unless `includeArchived=true`;
- added transactionally persisted audit records;
- create/update/status mutation and corresponding audit are one SQLite transaction;
- added v1 -> v2 workspace SQLite migration preserving existing rows as `active`;
- added `WorkspaceLifecycleService`;
- create workspace from trusted selection;
- rename;
- replace bounds from a newer trusted selection;
- change purpose;
- replace tags;
- change constraints;
- archive;
- restore;
- v1 owner-only mutation is explicit and fail-closed;
- cross-player and cross-world/dimension resize attempts fail closed;
- low-level physical `delete()` remains maintenance-only and is not user-facing lifecycle behavior.

**W4A verification status:** PASS.

Final automated evidence:

- full suite: 452 tests total;
- 448 passed;
- 0 failed;
- 4 skipped;
- typecheck PASS in the requested validation sequence;
- working tree clean.

Regression fixes retained:

- stale W0 geometry fixture now includes required `status`;
- same-millisecond audit events are deterministically ordered by `created_at DESC, rowid DESC`;
- regression test deliberately collides create/archive/restore timestamps.

W4A is complete.

#### W4B deterministic Workspace resolver — implementation in progress

Commits:

- `950ae15` — `feat: resolve workspaces deterministically`;
- `89b9c95` — `fix: fail closed on duplicate selection workspace matches`;
- `4838d1f` — `test: cover duplicate selection workspace ambiguity`.

Resolver precedence:

1. explicit id or exact label;
2. conversation-bound workspace;
3. trusted latest selection exact source match;
4. trusted selection unique spatial intersection;
5. unique nearby workspace;
6. recent authorized workspace;
7. otherwise ambiguous/none.

Safety behavior:

- explicit reference that is missing or unauthorized returns `explicit_not_found`; it does not silently fall back to nearby context;
- duplicate exact labels return `ambiguous`;
- duplicate workspaces created from the same selection return `ambiguous: selection_source`;
- multiple nearby workspaces return `ambiguous`;
- foreign-player/cross-world/cross-dimension selection context is ignored;
- archived workspaces are excluded from ordinary resolution;
- current v1 resolver authorization is owner-only;
- resolver does not mutate workspace state or Minecraft world state.

**W4B verification status:** PASS.

Final automated evidence:

- full suite: 461 tests total;
- 457 passed;
- 0 failed;
- 4 skipped;
- typecheck PASS in the requested validation sequence;
- working tree clean.

W4B is complete.

#### W4C bounded Workspace management entrypoints — implementation in progress

Direction:

- expose deterministic management operations through the authenticated/loopback Control API first;
- do not let API callers bypass lifecycle ownership, archive, scope, or trusted-selection checks;
- do not expose low-level physical purge;
- keep chat binding as a thin semantic layer over the same lifecycle/resolver services;
- no Minecraft world mutation is introduced by Workspace management.

##### W4C1 WorkspaceManagementService — implementation complete, verification pending

Commits:

- `acd23e9` — `feat: add bounded workspace management service`;
- `24d00ae` — `fix: preserve workspace lifecycle management errors`;
- `6f73336` — `test: fail archived resize before selection lookup`.

Behavior:

- create uses only the current trusted selection for the authoritative actor/world/dimension;
- stale, unavailable or missing selection fails closed;
- arbitrary coordinates are not accepted by the management service;
- list/get are fixed to application world + owner scope;
- rename/purpose/tags/constraints delegate to audited lifecycle rules;
- resize uses the current trusted selection, never caller-supplied bounds;
- archived resize fails as `workspace_archived` before consulting the selection source;
- archive/restore remain owner-scoped;
- audit history is owner-scoped;
- foreign-world workspace ids are hidden as not found;
- lifecycle error codes are preserved through the management layer.

**W4C1 verification status:** PASS.

Final automated evidence:

- full suite: 467 tests total;
- 463 passed;
- 0 failed;
- 4 skipped;
- typecheck PASS in the requested validation sequence;
- working tree clean.

W4C1 is complete.

##### W4C2 application bootstrap + bounded Control API — implementation complete, verification pending

Commits:

- `49459c3` — `feat: expose bounded workspace management api`;
- `f6ed0ed` — `fix: normalize workspace api constraints wire format`;
- `085d0e9` — `test: verify workspace constraints wire mapping`;
- `f87a9a5` — `test: wire workspace management through application root`.

Application behavior:

- creates one durable `data/workspaces.sqlite3` repository;
- repository is owned by application lifecycle and closes during shutdown;
- `WorkspaceManagementService` is constructed with the application world key and trusted selection source when available;
- management remains available for list/get/archive history even if MoxueBridge selection observation is disabled, while create/resize fail closed as selection unavailable.

Control API:

- `POST /v1/workspaces`;
- `GET /v1/workspaces`;
- `GET /v1/workspaces/:id`;
- `POST /v1/workspaces/:id/rename`;
- `POST /v1/workspaces/:id/resize`;
- `POST /v1/workspaces/:id/purpose`;
- `POST /v1/workspaces/:id/tags`;
- `POST /v1/workspaces/:id/constraints`;
- `POST /v1/workspaces/:id/archive`;
- `POST /v1/workspaces/:id/restore`;
- `GET /v1/workspaces/:id/audit`.

Safety/API invariants:

- create/resize accept no caller coordinates and therefore cannot bypass trusted setting-wand selection;
- physical purge/delete is intentionally not exposed;
- strict request schemas reject extra fields;
- external wire constraints are snake_case and convert into validated domain constraints;
- workspace management errors map to bounded public HTTP codes without raw internal exceptions;
- application-root test proves Fake MoxueBridge selection -> real management service -> real in-memory SQLite repository -> ControlServer wiring.

**W4C2 verification status:** PASS.

Final automated evidence:

- full suite: 471 tests total;
- 467 passed;
- 0 failed;
- 4 skipped;
- typecheck PASS in the requested validation sequence;
- working tree clean.

W4C2 is complete.

#### W5 natural-language Workspace chat binding — implementation in progress

Hard architecture rule:

> Do not implement Workspace natural language as a finite phrase/regex list.

Human phrasing is open-ended. The raw addressed utterance must be interpreted semantically into a strict bounded Workspace intent. Deterministic code owns reference resolution, ownership, lifecycle mutation, persistence, audit, and all Minecraft execution.

Current accepted flow:

```text
addressed natural language
  -> Workspace semantic interpreter
  -> strict WorkspaceChatIntent schema
  -> deterministic Workspace resolver
  -> WorkspaceManagementService
  -> SQLite + audit

if semantic interpreter returns not_workspace:
  -> existing gameplay AI path
```

The semantic interpreter may understand arbitrary paraphrases such as possessive/private/shared/preferred-use language without enumerating exact Chinese sentences in production code.

##### Workspace Moxue use policy — implementation complete, verification pending

New first-class domain field:

- `owner_only`
  - private/player-owned operational use;
  - Moxue may retain bounded awareness so planning can avoid conflict;
  - Moxue must not harvest/use storage/consume output/perform ordinary workspace mutation there;
- `shared`
  - default for ordinary Workspace declarations;
  - usable subject to purpose-specific rules, storage ACL and SafetyPolicy;
- `moxue_preferred`
  - usable and preferred over equivalent shared candidates;
  - does not imply humans are forbidden;
  - does not bypass storage ACL, Project policy or SafetyPolicy.

Important distinction:

- `ownerPrincipal` = who may manage the Workspace metadata;
- `moxueUsePolicy` = whether/how Moxue may operationally use the Workspace.

Implemented:

- `WorkspaceUsePolicySchema`;
- `WorkspaceRegion.moxueUsePolicy`;
- input default = `shared`;
- search filter by use policy;
- audited `changeUsePolicy()`;
- WorkspaceManagementService create/change support;
- Control API:
  - create accepts optional `moxue_use_policy`;
  - `POST /v1/workspaces/:id/use-policy`;
  - public response includes `moxue_use_policy`;
- SQLite schema v3;
- v1 -> v2 -> v3 migration;
- v2 -> v3 migration;
- legacy rows default to `shared`;
- migration/restart/query/audit/API tests added.

Relevant commits include:

- `ed786bb` — `feat: define workspace moxue use policy`;
- `f310c1e` — `feat: persist workspace moxue use policy`;
- `31e5d1e` — `fix: sequence workspace use policy schema migration`;
- `bb380cc` — `feat: manage workspace moxue use policy`;
- `18ee1ab` — `feat: expose workspace moxue use policy management`;
- `b94ec0b` — `feat: expose workspace moxue use policy api`;
- `e81cf04` — `test: cover workspace moxue use policy api`;
- policy regression coverage commits through `87edcd6`.

##### W5A semantic Workspace chat intent contract — implementation complete, verification pending

Commit:

- `453c559` — `feat: define semantic workspace chat intent contract`.

The contract is operation-based, not phrase-based.

Supported bounded semantic outcomes include:

- `not_workspace`;
- `clarify`;
- `create`;
- `rename`;
- `resize`;
- `change_purpose`;
- `change_use_policy`;
- `replace_tags`;
- `change_constraints`;
- `archive`;
- `restore`;
- `list`;
- `show`.

Reference semantics are also bounded:

- explicit id/name;
- current trusted selection;
- current conversation Workspace;
- nearby Workspace;
- recent Workspace.

The intent schema intentionally rejects:

- raw coordinate bounds;
- physical purge/delete-forever;
- arbitrary mutation authority;
- unknown use policies;
- extra undeclared fields.

The semantic context keeps the original utterance opaque and bounded for the interpreter and supplies only bounded Workspace/selection context. There is no production phrase table such as `message.includes("農田")`.

Natural-language examples are tests/spec examples only, not exhaustive parser rules.

##### Accepted natural-language behavior

Examples that may map to create-from-selection when semantically appropriate include:

- `墨雪 幫我把這邊設定成農田`;
- `墨雪 這裡是農田`;
- `墨雪 這農田`;
- paraphrases not listed here.

Use-policy semantics:

- private/possessive meaning such as "這塊我自己用、你不要拿" -> `owner_only`;
- ordinary shared meaning -> `shared`;
- "這個給你用 / 你優先用" meaning -> `moxue_preferred`.

These are semantic meanings, not exact-string matching requirements.

Safety rules:

- create/resize still require a fresh trusted setting-wand selection;
- without a fresh selection, deictic create/resize must ask for one rather than guess coordinates;
- ambiguous target reference must produce clarification instead of last-write-wins;
- explicit lifecycle verbs/semantics take precedence over accidental create interpretation;
- execution directives such as lighting/building must not be confused with metadata creation;
- AI never receives repository/world-mutation authority.

**Current verification gate:** PASS.

Automated evidence:

- full suite: 477 tests total;
- 473 passed;
- 0 failed;
- 4 skipped;
- typecheck PASS in the requested validation sequence;
- working tree clean.

Workspace use-policy persistence/migrations and the semantic intent contract are now accepted. Production chat interception may begin.

##### W5B semantic router + addressed-chat coordinator seam — implementation complete, verification pending

Relevant commits:

- `5cb92ee` / `95f4ab8` — restore-only archived Workspace resolution;
- `d07accc` — normalize archived resolver option;
- `9c74ead` — `feat: route semantic workspace chat intents`;
- `0cd4c4b` — `feat: route addressed chat through workspace semantics`.

Behavior:

- `WorkspaceChatRouter` receives only structured `WorkspaceChatIntent`; it has no Chinese phrase/keyword table;
- semantic `not_workspace` returns fallback to the existing gameplay AI path;
- create/change-use-policy/rename/resize/purpose/tags/constraints/archive/restore/list/show flow through deterministic resolver + management service;
- create/resize still require trusted current setting-wand selection;
- ambiguous targets produce `clarify` rather than last-write-wins;
- restore explicitly opts into archived resolution while ordinary resolver paths still exclude archived Workspaces;
- conversation/recent Workspace bindings are per authoritative actor UUID;
- DecisionCoordinator uses raw Minecraft player UUID as Workspace actor principal, matching MoxueBridge selection identity;
- addressed chat with an authoritative player id is routed semantically before gameplay AI;
- chat without authoritative player id preserves the legacy gameplay path and cannot mutate Workspace state;
- Workspace semantic calls run on a separate serialized async tail and do not block the coordinator mailbox;
- disconnect/emergency-stop/dispose abort outstanding Workspace semantic calls;
- late results from a previous Minecraft session are discarded;
- interpreter failure falls back to the existing gameplay AI path rather than making ordinary addressed chat disappear.

Application wiring:

- `ApplicationDependencies.workspaceIntentInterpreter` is currently optional;
- when injected, main builds a real `WorkspaceChatRouter` over the same repository/management/selection source;
- when absent, existing gameplay behavior is unchanged.

**Important current limitation:** the production Gemini-backed `WorkspaceIntentInterpreter` is not wired yet. Do not claim live arbitrary-language Workspace chat support until that interpreter and live validation are complete.

**Current verification gate:** PASS.

Automated evidence:

- full suite: 490 tests total;
- 486 passed;
- 0 failed;
- 4 skipped;
- typecheck PASS in the requested validation sequence;
- working tree clean.

W5B semantic router + addressed-chat coordinator seam is accepted.

##### W5C learned Workspace semantic cache — implementation in progress

Goal:

- known, previously validated natural-language Workspace interpretations resolve locally before any provider/API call;
- unseen wording may use the production semantic interpreter;
- successful bounded interpretations become reusable learned records;
- learning never grants mutation authority.

Implemented W5C1:

- `SqliteLearnedWorkspaceIntentCache`;
- HMAC-SHA256 fingerprint lookup over normalized utterance;
- raw utterance text is not stored;
- semantic contract versioning;
- `CacheFirstWorkspaceIntentInterpreter`;
- cache-first lookup before fallback interpreter;
- successful handled Workspace outcomes call optional `learnSuccessful()`;
- fallback / clarification / failed operations are not learned;
- `not_workspace` is not auto-learned;
- `nearby` references are not auto-learned because they are highly context-sensitive;
- conversation/recent mappings only match when the same reference class is available;
- explicit-target mappings are cache-eligible only when the explicit name/id actually appears in the utterance;
- conflicting active mappings for one fingerprint cause a cache miss instead of last-write-wins;
- revocation invalidates all active mappings for one utterance fingerprint;
- different HMAC keys cannot reproduce lookups;
- cache is advisory: read/write failures do not override a successful deterministic Workspace operation.

Relevant commits:

- `2183f1f` — `feat: add learned workspace semantic cache`;
- `1c11ee5` — `feat: allow successful workspace intent learning`;
- `aab3335` — `feat: learn workspace semantics only after handled outcomes`;
- `1cab671` — `test: learn only successful workspace chat outcomes`;
- `96b04fb` — `feat: version workspace semantic intent contract`;
- `b23f202` — `fix: cache only stable explicit workspace references`.

Privacy/sync boundary:

- live learned SQLite state remains local application-owned state;
- GitHub must never receive plaintext chat utterances or the plaintext learned DB;
- GitHub sharing will use a versioned authenticated encrypted export, not the live DB file;
- encryption key must come from a local/environment secret and must never be committed;
- runtime will not automatically push to GitHub.

**W5C1 verification status:** PASS.

Final automated evidence:

- full suite: 497 tests total;
- 493 passed;
- 0 failed;
- 4 skipped;
- typecheck PASS in the requested validation sequence;
- working tree clean.

W5C1 is complete.

##### W5C2 authenticated encrypted export/import — implementation complete, verification pending

Relevant commits:

- `e8fd5bc` — `feat: add encrypted workspace semantic export`;
- `83fe057` — `fix: validate complete learned cache rows and snapshots`;
- `3d7d896` — `fix: validate decrypted workspace semantic snapshots`;
- `14af635` — `test: harden encrypted workspace semantic imports`.

Implemented:

- versioned transfer snapshot for learned semantic records;
- record-level export/import instead of copying the live SQLite file;
- current semantic-contract records only are exported;
- transfer records contain HMAC fingerprint, validated intent, intent hash, applicability, success/revocation metadata and timestamps;
- no raw utterance is present in transfer records;
- import revalidates snapshot schema, intent schema and intent hash;
- incompatible semantic contract records are skipped rather than coerced;
- merge is record-level and preserves learned conflicts instead of selecting a winner;
- same mapping merges created/update/success metadata conservatively;
- revocation tombstones survive export/import;
- AES-256-GCM authenticated encryption;
- 12-byte random nonce and 16-byte auth tag;
- encrypted envelope has a strict version/algorithm schema;
- wrong key or tampered ciphertext fails authentication;
- decrypted plaintext is schema-validated before import;
- encrypted payload is bounded to 16 MiB;
- HKDF-SHA256 derives separate 32-byte keys for:
  - HMAC semantic fingerprints;
  - AES-256-GCM export encryption;
- one master secret therefore does not reuse identical key material across both cryptographic purposes.

Important boundary:

- this implements the portable encrypted format only;
- runtime does not automatically push or pull GitHub;
- the master secret is not stored in the export and must never be committed;
- explicit GitHub transport/sync will be a later layer over this format.

**W5C2 verification status:** PASS.

Final automated evidence:

- full suite: 505 tests total;
- 501 passed;
- 0 failed;
- 4 skipped;
- typecheck PASS after the exact-optional binding fix;
- working tree clean.

W5C2 authenticated encrypted export/import is complete. The next implementation step is the production Gemini-backed WorkspaceIntentInterpreter using the existing ProjectPool/quota/failover infrastructure.

Verification note:

- first local typecheck exposed two `exactOptionalPropertyTypes` errors in `WorkspaceChatRouter.resolveTarget()`;
- `conversationWorkspaceId` and `recentWorkspaceId` were being passed as explicit `undefined`;
- fixed by returning deterministic `none` when the corresponding binding is absent and only supplying the optional property when a concrete string exists;
- regression test now locks missing conversation/recent bindings to `clarify: missing_reference`;
- rerun typecheck and W5C2 validation after `d6b1bd4` / `f100f9d`.

##### W5C3 production Gemini Workspace semantic interpreter — implementation complete, verification pending

Relevant commits:

- `9d46509` — `refactor: share gemini transport normalization helpers`;
- `8c793b6` — `feat: add routed gemini workspace intent interpreter`;
- `46b1e17` — `feat: wire workspace semantics into gemini application stack`;
- `5c32df9` / `779dc85` — trusted observed Minecraft identity seam/tests;
- `994a327` / `94339a6` — require trusted online identity for Workspace chat routing;
- `714d13f` — application test for cache-first Gemini Workspace semantics;
- `0f14a66` — document the optional Workspace semantic learning secret.

Production behavior:

- Gemini stack now exposes both:
  - gameplay `RoutedDecisionExecutor`;
  - `RoutedGeminiWorkspaceIntentInterpreter`;
- Workspace semantic interpretation uses the same `ProjectPool`, `SqliteQuotaLedger`, credential handles, provider error policy, project failover and telemetry path as gameplay routing;
- semantic interpretation uses the routine model with low thinking and no reserve authorization;
- provider output must make exactly one `submit_workspace_intent` function call;
- returned function arguments are parsed by `WorkspaceChatIntentSchema`;
- one malformed generation may repair/retry once;
- credential-fatal failures disable that project for the process and continue through the pool;
- quota/transient/configuration/content-blocked/cancel behavior reuses existing routed error policy;
- provider failure is contained by the Workspace coordinator seam and falls back to the existing gameplay AI path instead of making addressed chat disappear.

Natural-language policy:

- production Gemini system instruction explicitly requires semantic interpretation rather than fixed phrase matching;
- slang, shorthand, paraphrases, multiple languages and imperfect grammar may be interpreted;
- general gameplay actions are kept separate from persistent Workspace metadata/management;
- AI cannot invent coordinates, physical purge, storage authority, permissions or world mutation.

Cache-first production wiring:

- if `MC_WORKSPACE_SEMANTIC_MASTER_SECRET` is absent, Gemini Workspace semantic interpretation still works but does not learn locally;
- if the secret is present and at least 32 UTF-8 bytes, main derives separated HMAC/export keys and opens `data/workspace-semantic-cache.sqlite3`;
- `CacheFirstWorkspaceIntentInterpreter` checks learned semantics before provider calls;
- application owns and closes the learned cache;
- `.env.example` documents the variable name only; no secret is committed.

Identity hardening:

- Workspace actor identity must be online-mode current-session evidence;
- `MinecraftIdentityRegistry.resolveObservedPlayerId()` requires:
  - online identity mode;
  - active current session;
  - observed player name/UUID pair;
  - matching chat UUID;
- Workspace chat mutation does not trust a raw `playerId` field by itself;
- offline / missing / mismatched identity falls through to the existing gameplay path instead of mutating durable Workspace metadata.

Known live-UX limitation before FULL PASS:

- `clarify` results are represented deterministically but there is not yet a typed Minecraft chat reply/output port in this branch;
- before live Workspace chat acceptance, add a bounded reply seam so ambiguity/missing-selection messages are visible to the player;
- do not claim full natural-language live support until this reply seam and live paraphrase tests pass.

**W5C3 verification status:** PASS.

Final automated evidence:

- full suite: 512 tests total;
- 508 passed;
- 0 failed;
- 4 skipped;
- typecheck PASS;
- working tree clean.

W5C3 production Gemini Workspace semantic interpretation is complete. The next required gate is a typed bounded Minecraft chat reply/output seam so clarification and acknowledgement are visible to players before live natural-language acceptance.

##### W5C4 bounded Minecraft chat reply/output seam — implementation complete, verification pending

Relevant commits:

- `d6facc4` — `feat: add bounded minecraft workspace chat replies`;
- `7fe1388` — `feat: register typed minecraft chat output port`;
- `7c70eac` — `feat: provide bounded mineflayer chat output`;
- `8b3bcac` — `feat: reply to workspace chat outcomes`;
- `77fd540` — `test: cover visible workspace chat replies`;
- `d23d459` — `feat: wire minecraft chat output into coordinator`;
- `8d151ae` — `test: cover minecraft chat output runtime port`;
- `c9d42fc` — `test: keep workspace fallback silent`;
- `fca946c` — `test: prove default runtime chat output port`.

Architecture:

- added typed `minecraft.chat_output` runtime port;
- default Mineflayer runtime owns the raw `bot.chat()` call behind `MineflayerChatOutput`;
- Workspace/DecisionCoordinator never receives raw Mineflayer `Bot`;
- legacy/custom runtime bundles without the chat-output port remain supported and simply omit visible replies.

Output safety:

- maximum message length = 256 characters;
- empty messages fail closed;
- CR/LF and control characters fail closed;
- slash-prefixed output fails closed so this port cannot become a Minecraft command-execution channel;
- bot-not-ready and send failures return bounded failure codes;
- Workspace label text is sanitized/truncated before interpolation;
- internal Workspace error codes are not exposed to players.

Workspace UX:

- successful create/rename/resize/purpose/use-policy/archive/restore/show/list operations produce deterministic acknowledgements;
- `owner_only`, `shared` and `moxue_preferred` meaning is surfaced in relevant replies;
- `missing_selection`, `missing_reference`, `ambiguous_reference`, `missing_semantics` and `ambiguous_intent` produce visible clarification prompts;
- ambiguous candidate replies list at most three bounded labels;
- `fallback` remains silent and continues to the existing gameplay AI path without duplicate Workspace chatter;
- reply failure never rolls back an already successful Workspace metadata transition.

Acceptance coverage:

- direct chat-output validation;
- command-like/control/multiline/oversized rejection;
- bot-not-ready fail closed;
- deterministic reply formatting and label sanitization;
- DecisionCoordinator success/clarify visibility;
- `not_workspace` fallback silence;
- default Mineflayer runtime registers the chat-output port while preserving the historical enumerable bundle surface of only `adapter / gathering / inventory`.

**W5C4 verification status:** Automated PASS.

Final automated evidence:

- full suite: 523 tests total;
- 519 passed;
- 0 failed;
- 4 skipped;
- typecheck PASS;
- working tree clean.

Additional regression evidence:

- runtime chat-output acceptance test PASS after isolating its intended registration contract;
- GoalManager terminal-event race regression PASS without increasing scenario timeouts;
- cooperative-session scenario PASS after fixing stale completion ownership;
- Workspace fallback remains silent;
- clarification/success replies remain bounded and deterministic.

W5C4 automated implementation is complete.

##### W5C5 controlled Minecraft live semantic validation — FULL PASS

Controlled create-path evidence:

- live launcher preflight READY:
  - Gemini provider;
  - online identity mode;
  - Microsoft auth;
  - MoxueBridge enabled;
  - routing config present/valid;
  - primary + backup credential envs present;
  - semantic cache enabled with no warnings.
- trusted player UUID observed and canonicalized:
  - wire/Bukkit: `b19a556a-0e50-40ec-88db-4e587dede94c`;
  - MC_AI_Player durable principal: `b19a556a0e5040ec88db4e587dede94c`.
- fresh MoxueBridge selection PASS:
  - generation 9;
  - overworld;
  - canonical player id;
  - selection id `f564fbb0-dee5-4d02-8de5-3f3fd09ada95`;
  - A = (-202, 63, 299);
  - B = (-210, 64, 307).
- natural-language owner-only create utterance PASS.
- Workspace semantic provider evidence:
  - exactly 1 semantic `model_route`;
  - model `gemini-3.5-flash-lite`;
  - project `primary`;
  - thinking `low`;
  - exactly 1 semantic `attempt_result`;
  - result `success`;
  - no safeCode.
- learned semantic cache evidence:
  - cache present;
  - 1 active learned record;
  - 0 revoked records;
  - 0 conflicting fingerprints.
- persistent Workspace row PASS:
  - label `W5C-LiveFarm-A`;
  - purpose `farm`;
  - `moxue_use_policy = owner_only`;
  - status `active`;
  - owner principal canonical hyphenless UUID;
  - source selection id matches generation-9 selection.
- Minecraft visible acknowledgement PASS:
  - Moxue replied that the region was remembered as private and its resources would not be used.

This proves the full live create path:

```text
trusted online UUID
-> fresh Bridge selection
-> cache miss
-> Gemini semantic interpretation
-> strict Workspace intent
-> deterministic management/lifecycle
-> SQLite + audit
-> learned semantic cache
-> bounded Minecraft acknowledgement
```

Repeated non-mutating explicit `show` cache proof — LIVE PASS:

- exact utterance used twice:
  - `墨雪，幫我看一下 W5C-LiveFarm-A 現在是什麼設定？`;
- both requests produced the same visible deterministic Workspace reply:
  - `W5C-LiveFarm-A` reported as a farm;
  - owner-only/private semantics reported;
  - Moxue stated it would not use the region's resources;
- inspector window started before the first `show`;
- across both identical utterances:
  - semanticRouteCount = 1;
  - semanticAttemptCount = 1;
  - activeLearnedRecords = 2;
  - revokedLearnedRecords = 0;
  - conflictingFingerprints = 0;
  - expectation gate PASS;
- this proves:
  1. first `show` was a cache miss and used one Gemini Workspace semantic route/attempt;
  2. successful `show` interpretation was learned locally;
  3. second identical `show` was served from learned semantic cache;
  4. no second Workspace semantic provider call was made.

This directly validates the intended API-saving behavior:

```text
first unseen wording
-> Gemini semantic interpretation
-> deterministic successful Workspace handling
-> learned semantic DB

same wording again
-> local cache hit
-> deterministic Workspace handling
-> 0 additional semantic Gemini calls
```

Non-Workspace gameplay fallback — LIVE PASS:

- addressed utterance: `墨雪，跟我來一下`;
- Workspace semantic classifier ran exactly once:
  - semanticRouteCount = 1;
  - semanticAttemptCount = 1;
  - result = success;
- Workspace interpretation returned `not_workspace`;
- no Workspace acknowledgement or mutation occurred;
- learned Workspace record count remained unchanged at 2;
- coordinator then created an ordinary gameplay task;
- ordinary gameplay Gemini route ran separately and succeeded;
- `decision_accepted` emitted;
- live Minecraft behavior confirmed Moxue followed the player.

This proves the intended fallthrough path:

```text
addressed chat
-> Workspace semantic interpretation
-> not_workspace
-> silent Workspace fallback
-> normal gameplay AI routing
-> accepted gameplay action
```

Representative shared semantics — LIVE PASS:

- fresh trusted selection created for `W5C-SharedFarm`;
- natural-language utterance:
  - `墨雪，這塊叫 W5C-SharedFarm，之後就當一般農田用吧。`;
- Minecraft visible acknowledgement:
  - region remembered;
  - explicitly reported as an ordinary shared region;
- semantic provider evidence over the same test window after completion:
  - semanticRouteCount = 1;
  - semanticAttemptCount = 1;
  - activeLearnedRecords increased 2 -> 3;
  - 0 revoked records;
  - 0 conflicting fingerprints;
- persistent Workspace row:
  - label `W5C-SharedFarm`;
  - purpose `farm`;
  - `moxue_use_policy = shared`;
  - status `active`;
  - canonical hyphenless owner principal;
  - source selection id present.

Operator timing note:

- the first inspector invocation was executed before the asynchronous semantic route had completed and therefore temporarily observed 0 routes / 0 attempts;
- rerunning against the same `sinceMs` after the Minecraft acknowledgement observed the expected 1 route / 1 attempt;
- this was an evidence-collection timing issue, not a product failure.

Representative moxue_preferred semantics — LIVE PASS:

- natural-language utterance:
  - `墨雪，這塊叫 W5C-MoxueFarm，以後主要給你用，你優先從這裡拿東西。`;
- Minecraft visible acknowledgement explicitly reported the region as prioritized for Moxue use;
- semantic provider evidence:
  - semanticRouteCount = 1;
  - semanticAttemptCount = 1;
  - activeLearnedRecords increased 3 -> 4;
  - 0 revoked records;
  - 0 conflicting fingerprints;
- persistent Workspace row:
  - label `W5C-MoxueFarm`;
  - purpose `farm`;
  - `moxue_use_policy = moxue_preferred`;
  - status `active`;
  - canonical hyphenless owner principal;
  - source selection id present.

Observation:

- this Workspace reused the same source selection id as the preceding shared-region live test. That does not weaken the use-policy semantic proof, but ambiguity tests should create distinct fresh selections so candidate regions are physically distinguishable.

Ambiguity clarification — LIVE PASS:

- two distinct active Workspace rows were created with the same label `W5C-AmbigFarm`;
- workspace ids differed;
- source selection ids differed, proving distinct fresh selections/regions;
- explicit show by ambiguous label did not select either candidate;
- Minecraft visible reply reported that more than one possible region was found and asked the player to specify which one;
- no mutation was performed.

Safety requirement is satisfied: ambiguous resolution fails closed rather than using last-write-wins.

UX follow-up observed:

- because both candidates had the exact same label, the current reply formatter de-duplicated the displayed label list and only showed `W5C-AmbigFarm` once;
- this does not weaken ambiguity safety, but it makes the clarification less actionable;
- future hardening should suggest reselecting one region with the setting wand or expose another bounded disambiguator instead of repeating identical labels.

Archive + restore — LIVE PASS:

- unique Workspace `W5C-SharedFarm` was targeted by natural-language archive intent;
- Minecraft visible acknowledgement confirmed the region was archived and would no longer be treated as ordinarily available;
- SQLite status changed:
  - `active -> archived`;
- follow-up natural-language recent-reference utterance:
  - `墨雪，剛剛那個還是恢復好了。`;
- resolver restored the same durable Workspace entity;
- Minecraft visible acknowledgement confirmed restore;
- SQLite status changed:
  - `archived -> active`;
- Workspace id remained unchanged across archive/restore.

W5C5 controlled Minecraft live semantic validation is now FULL PASS.

Final live coverage completed:

1. trusted online-mode current-session UUID identity;
2. fresh MoxueBridge setting-wand selection;
3. Gemini Workspace semantic routing with routine / low thinking;
4. provider request schema compatibility;
5. owner-only natural-language create;
6. shared natural-language create;
7. moxue-preferred natural-language create;
8. deterministic Workspace persistence and audit path;
9. bounded visible Minecraft acknowledgements;
10. repeated exact `show` cache proof:
    - first wording -> Gemini semantic call;
    - second identical wording -> local learned cache;
    - 0 additional semantic Gemini calls;
11. non-Workspace `not_workspace` fallthrough to ordinary gameplay Gemini;
12. live follow-player execution after fallback;
13. ambiguity clarification with no arbitrary candidate selection;
14. archive + recent-reference restore of the same durable Workspace.

Overall W5C architecture validated live:

```text
addressed natural language
-> trusted online identity
-> learned semantic cache
   -> hit: local validated WorkspaceChatIntent
   -> miss: Gemini semantic interpreter via shared ProjectPool/quota/failover
-> strict WorkspaceChatIntent
-> deterministic resolver
-> deterministic WorkspaceManagementService/lifecycle
-> SQLite + audit
-> successful semantics learned locally
-> bounded Minecraft acknowledgement
```

Known non-blocking UX follow-up:

- ambiguity replies for exact duplicate labels de-duplicate the displayed label and are safe but not sufficiently actionable;
- future hardening should offer a bounded disambiguator or explicitly ask the player to select one candidate with the setting wand.

**W5C5 status:** FULL PASS.

##### W5D explicit encrypted learned-semantic Git sync — implementation complete, verification pending

Implemented:

- dedicated remote data branch: `workspace-semantic-cache`;
- encrypted artifact path: `workspace-semantic-cache.enc`;
- explicit operator commands:
  - `npm run sync:workspace-semantic -- pull`;
  - `npm run sync:workspace-semantic -- push`;
- no implicit runtime pull or push;
- no separate GitHub token/API integration: sync reuses the repository's existing authenticated `origin` Git transport;
- current source branch, HEAD, worktree and index are not checked out or modified by sync;
- Git plumbing creates/pushes data-only commits directly to the dedicated branch;
- `pull`:
  - fetches the dedicated branch;
  - reads only the encrypted artifact;
  - authenticates/decrypts AES-256-GCM;
  - validates snapshot/intent/hash contracts;
  - record-merges into local SQLite;
- `push`:
  - fetches and imports latest remote state first;
  - merges remote/local records;
  - compares semantic record content while ignoring export timestamp/random nonce;
  - emits no new encrypted commit when semantic content is unchanged;
  - encrypts and publishes only when records changed;
  - detects concurrent branch updates, refetches/merges and retries boundedly;
- wrong semantic secret fails closed at authenticated decryption;
- raw utterances and plaintext intent records are never written to the Git branch;
- the same master secret must be shared out-of-band across machines that participate in this encrypted cache.

Automated coverage added:

- encrypted first push;
- unchanged second push = no-op;
- two-machine merge without last-write-wins;
- concurrent remote update refetch/merge/retry;
- wrong-key pull fail-closed;
- local bare-Git transport integration proving the dedicated branch can be created/updated without changing current HEAD/worktree/index.

Relevant commits:

- `5396edd` — `feat: add explicit encrypted workspace semantic git sync`;
- `242de29` — `fix: read semantic sync artifact from fetched remote head`;
- `4c1e468` — `feat: expose explicit workspace semantic sync command`;
- `986cc7e` — `docs: document encrypted workspace semantic git sync`.

**W5D verification status:** FULL PASS.

Final live pull proof:

- a fresh empty temporary learned-cache database was created with the same local semantic master secret;
- explicit pull from `origin/workspace-semantic-cache` returned:
  - `kind = pulled`;
  - remote commit `0a1d8bf1448a6529be7250dd35f108a98fde1c4b`;
  - `merged = 8`;
  - `skipped = 0`;
  - `localRecordCount = 8`;
- fresh-cache export immediately after pull contained exactly 8 records;
- source branch safety proof during pull:
  - HEAD unchanged = true;
  - index unchanged = true;
  - worktree unchanged = true;
- temporary proof DB/script were removed after validation.

W5D explicit encrypted learned-semantic Git sync is FULL PASS.

Validated end-to-end sync path:

```text
local learned semantic DB
-> record-level snapshot
-> AES-256-GCM authenticated encryption
-> dedicated Git data branch
-> unchanged second push = no-op
-> fresh empty cache on another machine/context
-> fetch encrypted artifact
-> authenticated decrypt
-> schema / intent / hash validation
-> record merge
-> all learned semantics restored
```

Operational properties now proven:

- no plaintext utterances are uploaded;
- no live SQLite file is uploaded;
- no automatic runtime push/pull exists;
- same master secret is required to decrypt/share the cache;
- wrong secret fails closed;
- concurrent contributors merge instead of last-write-wins;
- source branch/worktree/index remain untouched by explicit sync operations.

##### W5E duplicate-label ambiguity UX hardening — implementation complete, verification pending

Observed live UX issue:

- ambiguity safety already passed live;
- when multiple candidate Workspaces had the exact same label, the reply formatter de-duplicated labels and showed the repeated name only once;
- the result was safe but not actionable for the player.

Implemented:

- distinct-label ambiguity behavior is unchanged;
- when multiple candidates collapse to one unique displayed label, the reply now:
  - reports the candidate count;
  - states that the regions share the same name;
  - instructs the player to use the Moxue setting wand to select one region and then refer to the selected region;
- no resolver, semantic, identity, lifecycle, persistence, or authority behavior changed.

Relevant commits:

- `bcd4bde` — `fix: make duplicate workspace ambiguity actionable`;
- `b852cbc` — `test: cover duplicate-label workspace clarification`.

**W5E verification status:** Automated PASS.

Final automated evidence:

- full suite: 543 tests total;
- 539 passed;
- 0 failed;
- 4 skipped;
- `git diff --check` PASS;
- working tree clean.

W5E duplicate-label ambiguity UX hardening is complete. Distinct-label ambiguity behavior remains unchanged; exact duplicate-label ambiguity now reports the candidate count and gives an actionable setting-wand disambiguation path.

##### Workspace Planner merge / consolidation audit — READY

GitHub branch topology at audit time:

- `feature/modular-extension-core`:
  - HEAD `b75cb487f747a9d2da6da5d747e2b5f935dbe73e`;
  - role: accepted M7 SAFE PARALLELIZATION POINT / common feature baseline.
- `feature/workspace-planner`:
  - HEAD `ec7894644693616c9b9d2058aa84a3ca3d9e1f56`;
  - compare against modular core: ahead 142, behind 0;
  - merge base exactly `b75cb487f747a9d2da6da5d747e2b5f935dbe73e`;
  - no rebase is required.
- `feature/skill-production`:
  - M7 baseline + 1 handoff commit.
- `feature/skill-hostile-combat`:
  - M7 baseline + 1 handoff commit.
- `feature/project-autonomy-construction`:
  - materially diverged history;
  - remains isolated and must be audited before integration.

Integration recommendation:

- keep `feature/modular-extension-core` pinned as the stable M7 baseline;
- do not fast-forward that baseline branch to Workspace Planner;
- create/use a separate integration branch whose first accepted feature state is the fully validated Workspace Planner HEAD;
- merge Production / Combat into that integration branch when their workstreams become ready;
- keep Construction isolated until its existing divergent/local-ahead state is audited;
- keep `workspace-semantic-cache` as a data-only encrypted branch, never as a source-code integration branch.

No merge/reset/rebase was performed by this audit.

**Next exact action:**

1. run focused `tests/workspace/chat-reply.test.ts`;
2. run `npm run typecheck`;
3. run full `npm test`;
4. run `git diff --check`;
5. confirm clean worktree;
6. if green, optionally repeat one live duplicate-label clarification to confirm the improved wording;
7. then decide whether Workspace Planner W5 should be consolidated/merged into the integration branch;
8. keep the dedicated `workspace-semantic-cache` branch as data-only encrypted state.

Automated verification:

- full suite: 542 tests total;
- 538 passed;
- 0 failed;
- 4 skipped;
- typecheck PASS;
- `git diff --check` PASS;
- working tree clean.

Live explicit push evidence:

- first `npm run sync:workspace-semantic -- push` returned:
  - `kind = pushed`;
  - remote commit `0a1d8bf1448a6529be7250dd35f108a98fde1c4b`;
  - `localRecordCount = 8`;
  - `merged = 0`;
  - `skipped = 0`;
- dedicated remote branch exists:
  - `refs/heads/workspace-semantic-cache`;
- source branch HEAD remained exactly unchanged at `d6e9318752727a12bf342d95798b2d81222eae9b`;
- source worktree/index remained unchanged;
- immediate second push with no new learned semantics returned:
  - `kind = no_change`;
  - same remote commit SHA;
  - `localRecordCount = 8`;
  - no additional data-branch commit was created.

Note on second-push `merged = 8`:

- push deliberately imports the latest remote snapshot before comparison;
- the 8 records were validated/upserted into the local cache;
- semantic content then compared equal, producing `no_change`;
- this does not mean 8 duplicate learned records were created.

Remaining W5D live gate before FULL PASS:

1. pull the encrypted data branch into a fresh empty cache using the same semantic master secret;
2. prove the fresh cache receives the expected 8 validated records;
3. prove the source branch/worktree remain unchanged during pull.

**Next exact action:**

1. fast-forward `feature/workspace-planner`;
2. run focused learned-intent Git sync/export/cache tests;
3. run `npm run typecheck`;
4. run full `npm test`;
5. run `git diff --check` and confirm clean worktree;
6. if green, perform first explicit live `push` to create `origin/workspace-semantic-cache`;
7. verify source branch HEAD/status are unchanged by the sync command;
8. run a second `push` without new learned semantics and require `no_change`;
9. optionally prove `pull` on a fresh local cache copy before declaring W5D FULL PASS;
10. duplicate-label ambiguity reply UX hardening remains a separate non-blocking follow-up.

##### W5C5 live startup diagnosis + fail-closed launcher — automated PASS, live retest pending

#### Handoff 2026-09-21 +08:00

**Branch:** `feature/workspace-planner`
**Worktree:** `D:\MC_AI_player-worktrees\workspace-planner`
**Base / current committed HEAD before this uncommitted handoff:** `88cfe6e`
**Goal:** prevent trusted-UUID Workspace live validation from silently starting with the safe fake/offline defaults.

Root-cause evidence:

- the affected live process came from this worktree and was launched through Windows Terminal -> PowerShell -> `npm start` -> npm CLI -> `tsx src/main.ts`;
- the actual `src/main.ts` process had `MC_AI_PROVIDER=fake`, `MC_SERVER_IDENTITY_MODE=online`, and `MC_AUTH=microsoft`;
- `createApplication()` therefore created the fake decision stack, no Gemini Workspace interpreter, and no `WorkspaceChatRouter`;
- the addressed chat reached `task_started` and immediately failed as `fake_response_exhausted`, matching fallback to the gameplay fake provider;
- identity was not the blocking gate: the current session observed the same trusted player name/UUID before chat;
- the MoxueBridge selection matched world `127.0.0.1:25565`, `overworld`, and the same player UUID, and was only about 16 seconds old when chat arrived;
- no product Workspace router, identity gate, provider, or chat-output behavior was changed.

Changed:

- added `scripts/start-workspace-live.ts` with a pure, unit-tested preflight and sanitized report;
- added `npm run start:workspace-live`, using Node 24 native `--env-file=.env` with no dotenv dependency;
- preflight requires Gemini, online identity mode, Microsoft auth, valid enabled MoxueBridge configuration, a present/schema-valid private routing JSON, and every referenced credential environment variable;
- missing semantic master secret remains allowed with warning `semantic_cache_disabled`; a present secret must satisfy the existing minimum 32 UTF-8 byte rule;
- all required failures occur before importing/starting `createApplication()` and before Minecraft connection;
- `.env` and `data/ai-routing.json` remain gitignored/private; tracked examples and README contain no real secret values.

RED evidence:

- focused launcher test initially failed with `ERR_MODULE_NOT_FOUND` because `scripts/start-workspace-live.ts` did not exist.
- a focused error-classification regression then failed because an overlong Gemini routing path was incorrectly reported as `provider_not_gemini`; the launcher now reports `routing_config_invalid`.

Automated verification:

- focused launcher suite: 7 passed, 0 failed;
- `npm run typecheck`: PASS;
- full suite: 532 tests total, 528 passed, 0 failed, 4 skipped;
- sanitized preflight probe against the public routing example reported only check states, credential env names plus booleans, and `semantic_cache_disabled`;
- running `npm run start:workspace-live` without private `.env` stopped immediately in Node's native env loader before application construction.

Live verification:

- pending; no real credential, token, master secret, or private routing config was created or printed during automated verification.

Next exact action:

1. create private gitignored `.env` and `data/ai-routing.json` from the tracked examples;
2. set Gemini/online/Microsoft-auth/MoxueBridge/private credential values;
3. stop the existing fake-provider process and start `npm run start:workspace-live`;
4. capture a fresh trusted selection and validate owner-only create acknowledgement, DB row, semantic `model_route`, semantic `attempt_result`, repeated-show cache proof, and non-Workspace gameplay fallback.

**Merge/readiness:** implementation is automated PASS; do not claim W5C5 FULL PASS until the controlled live checklist passes.

##### W5C5 Gemini Workspace schema compatibility regression — automated PASS, live retest pending

#### Handoff 2026-09-21 +08:00

**Branch:** `feature/workspace-planner`
**Worktree:** `D:\MC_AI_player-worktrees\workspace-planner`
**Base / current committed HEAD:** `38addfb` (`feat: add fail-closed workspace live launcher`)
**Goal:** make the Workspace semantic function declarations compatible with the same Gemini structured-tool subset already used successfully by gameplay routing, without changing Workspace product semantics or trust gates.

Controlled live RED evidence:

- semantic route decision `24c08888-2bc6-4168-a534-a3cd12504d95` reached `gemini-3.5-flash-lite`, low thinking, primary project, with reason `workspace_semantic_interpretation`;
- its correlated `attempt_result` was `configuration_error` with safe code `invalid_request`;
- the gameplay fallback Gemini route succeeded afterward, so credentials, project routing and general Gemini transport were operational;
- the Workspace transport exposed one `submit_workspace_intent` tool whose parameters root was `oneOf`, nested target references also used `oneOf`, and intent discriminators used `const`;
- therefore failure occurred at Gemini request/schema validation before any semantic function call, Workspace mutation, selection resolution, cache learning or chat reply.

RED automated evidence:

- the new Workspace compatibility test expected 13 exact object-root intent tools and failed against the old implementation because it observed only `submit_workspace_intent`;
- tool-name extraction tests failed with `unexpected_function_call`, proving the old transport could not consume the compatible per-intent response shape;
- no production code was changed before these failures were observed.

Changed:

- replaced the single union-shaped tool with 13 exact tools: `workspace_not_workspace`, `workspace_clarify`, `workspace_create`, `workspace_rename`, `workspace_resize`, `workspace_change_purpose`, `workspace_change_use_policy`, `workspace_replace_tags`, `workspace_change_constraints`, `workspace_archive`, `workspace_restore`, `workspace_list`, and `workspace_show`;
- every function parameters root is `type: object` with `additionalProperties: false` and contains no `oneOf`, `anyOf`, `allOf`, or `const` at any depth;
- target references now use one ordinary object with bounded `kind` enum and optional bounded `value`; the existing strict Zod intent schema still requires `value` for `explicit` and rejects it for other reference kinds;
- provider arguments omit `kind`; extraction accepts exactly one advertised function call, maps its name to the intent kind, rejects caller-supplied `kind`, clones arguments, and validates the reconstructed candidate with `WorkspaceChatIntentSchema`;
- existing thought-step handling, unexpected-step/tool failures, generation-error classification and one repair retry remain unchanged;
- no router, persistence, identity, selection, learned-cache, chat-output, product behavior or timeout was changed.

Automated verification:

- Workspace transport focused suite: 8 passed, 0 failed;
- Workspace plus gameplay Gemini schema compatibility suites: 9 passed, 0 failed;
- `npm run typecheck`: PASS;
- full suite: 534 tests total, 530 passed, 0 failed, 4 skipped;
- `git diff --check`: PASS before the continuity update; rerun required for final handoff.

Inspector assessment:

- the current inspector correlates semantic `attempt_result` events by decision id and enforces counts, while raw runtime events retain `result` and `safeCode`;
- adding a summarized attempt breakdown could improve operator ergonomics, but it is not required to correct or validate this request-schema regression and was intentionally left out of this bounded fix.

Live verification:

- not run in this coding session; a controlled live retest is still required before W5C5 can become FULL PASS.

Next exact action:

1. restart only the Workspace live application with `npm run start:workspace-live` so the changed tool declaration is loaded;
2. capture a fresh trusted MoxueBridge selection for the same online current-session UUID;
3. repeat the natural-language owner-only create and require a successful semantic `attempt_result`, visible acknowledgement and durable Workspace row;
4. prove repeated explicit show uses the learned cache without a second semantic provider route;
5. prove an ordinary non-Workspace gameplay utterance still falls through to gameplay routing.

**Merge/readiness:** automated PASS; controlled live validation remains pending. Do not claim W5C5 FULL PASS yet.

##### W5C5 Workspace selection UUID canonicalization — automated PASS, live retest pending

#### Handoff 2026-09-21 +08:00

**Branch:** `feature/workspace-planner`
**Worktree:** `D:\MC_AI_player-worktrees\workspace-planner`
**Base / current committed HEAD:** `cf70c1f` (`fix: make workspace gemini tools schema compatible`)
**Goal:** make Bridge-observed Bukkit UUID selections use the same canonical representation as trusted online Minecraft actor identities without weakening identity trust or moving Minecraft-specific formatting into generic Workspace core.

Controlled live RED evidence:

- Control API reported the selection source `current` with a non-null fresh selection for world `127.0.0.1:25565`, dimension `overworld`, generation 7 and hyphenated player UUID `b19a556a-0e50-40ec-88db-4e587dede94c`;
- the addressed Workspace create produced the visible `missing_selection` clarification;
- `MinecraftIdentityRegistry.resolveObservedPlayerId()` canonicalizes the trusted current-session UUID to hyphenless `b19a556a0e5040ec88db4e587dede94c`;
- `MoxueBridgeWorkspaceSelections` previously preserved the wire UUID verbatim and delegated `latest()` without query canonicalization;
- `WorkspaceSelectionTracker` keys and `WorkspaceLifecycleService` ownership checks are exact, so the representation mismatch prevented lookup before lifecycle mutation.

RED automated evidence:

- the direct Bridge regression failed because a hyphenless trusted-actor query could not find the hyphenated wire selection;
- the Bridge-to-management regression failed with `workspace_selection_missing` before create;
- existing opaque `player-1` behavior and a new blank-ID rejection characterization remained green.

Changed:

- `MoxueBridgeWorkspaceSelections` now reuses `normalizeMinecraftUuid()` at the Minecraft transport boundary;
- wire `selection.player_id` is canonicalized before entering the domain tracker;
- `latest(query)` canonicalizes `query.playerId` through the same helper, so hyphenated and hyphenless UUID queries resolve the same canonical selection;
- non-UUID opaque IDs remain supported after trimming;
- blank wire IDs remain schema-invalid;
- no generic Workspace selection key, lifecycle ownership policy, router semantics, identity trust gate, Paper plugin, freshness logic, chat reply, Gemini interpreter or learned cache behavior changed.

Automated verification:

- MoxueBridge selection focused suite: 6 passed, 0 failed;
- identity + Bridge + management + chat-router focused suites: 27 passed, 0 failed;
- `npm run typecheck`: PASS;
- full suite: 537 tests total, 533 passed, 0 failed, 4 skipped;
- final `git diff --check` and fresh full verification remain required after this continuity update.

Live verification:

- not rerun in this coding session; no real Gemini or Minecraft process was started.

Next exact action:

1. restart only the Workspace live application so the updated Bridge adapter is loaded;
2. confirm Control API returns the current selection with canonical hyphenless `selection.player_id`;
3. send the same natural-language owner-only create as the same online current-session player;
4. require a handled create acknowledgement, one durable owner-only Workspace row, and no `missing_selection` or `workspace_selection_owner_mismatch`;
5. continue the existing repeated-show cache proof and non-Workspace gameplay fallback checks.

**Merge/readiness:** automated PASS only; controlled live retest remains pending. Do not claim W5C5 FULL PASS yet.

Full-suite regression note:

- after the runtime chat-output test isolation fix, full suite reached 522 tests / 517 pass / 1 fail / 4 skipped;
- only `tests/scenarios/cooperative-session.test.ts` failed, timing out while waiting for player `goal-3` (`go_to(BASE)`) to become `succeeded`;
- root cause is a pre-existing GoalManager terminal-event race exposed by full-suite timing:
  1. old goal transitions to terminal status;
  2. `completeGoal()` awaited terminal event publication while still owning `activeGoalId`;
  3. another caller could observe the terminal status and submit/start a replacement goal during that publish;
  4. stale old completion then returned and unconditionally set `activeGoalId = null`, orphaning the replacement running goal;
- `f260efa` fixes the lifecycle by releasing active ownership immediately after terminal transition and before publishing the terminal event;
- `5062a0d` adds a regression test that deliberately blocks `goal_completed` publication, starts a replacement goal during the block, releases the old completion, and proves the replacement remains active;
- cooperative-session timeout budget was not increased and the scenario behavior was not weakened;
- first typecheck of the new race regression exposed a test-only TypeScript narrowing issue: a Promise resolver assigned through a closure was inferred unusably at the later optional call;
- `2201793` replaces that hand-rolled nullable resolver with Node 24 / ES2024 `Promise.withResolvers<void>()`, keeping the same deterministic blocked-publish regression without changing product behavior;
- rerun GoalManager + cooperative-session + W5C4 focused tests, then typecheck/full suite.

Verification note:

- first focused run: 47 tests total, 46 passed, 1 failed;
- only `tests/minecraft/runtime-bundle-chat-output.test.ts` failed at file level without an assertion stack;
- the failing acceptance test was over-coupled to a hand-built fake Mineflayer Bot lifecycle even though its intended contract was only runtime-port registration;
- `feace2a` narrows that test to:
  - default runtime registers `minecraft.chat_output`;
  - enumerable runtime bundle surface remains `adapter / gathering / inventory`;
  - pre-spawn chat output fails closed;
- ready-bot send behavior remains covered independently by `tests/minecraft/chat-output.test.ts`;
- rerun focused W5C4 tests before any new feature work.

**Next exact action:**

1. fast-forward `feature/workspace-planner`;
2. run focused chat-output/chat-reply/runtime-port/coordinator/Gemini semantic tests;
3. run `npm run typecheck`;
4. run full `npm test`;
5. confirm working tree clean;
6. if green, mark W5C4 automated PASS;
7. prepare controlled Minecraft live validation with online trusted UUID identity, MoxueBridge selection, real Gemini semantic interpretation and varied paraphrases;
8. verify first unseen phrasing uses Gemini and successful repeat phrasing is served by learned cache without another semantic provider attempt;
9. verify owner_only/shared/moxue_preferred, ambiguity clarification, archive/restore and non-Workspace fallback;
10. only after live semantic behavior is stable add explicit encrypted GitHub sync transport.

**Next exact action:**

1. fast-forward `feature/workspace-planner`;
2. run focused learned-cache/chat/router/resolver/sqlite/coordinator/main tests;
3. run `npm run typecheck`;
4. run full `npm test`;
5. confirm working tree clean;
6. if green, implement authenticated encrypted export/import (AES-256-GCM with versioned envelope and key separation);
7. after encrypted export is green, add the production Gemini-backed WorkspaceIntentInterpreter using the existing ProjectPool/quota/failover path;
8. optional GitHub sync comes last and must be explicit, never implicit runtime behavior.

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
