# MC_AI_Player Project Autonomy and Construction Design Specification

**Date:** 2026-09-13  
**Repository:** `neko0115/MC_AI_Player`  
**Base dependency:** `feature/gemini-multi-model-routing` at `c2a61c554eadaf4ea93c4afda47ecaaa8b8aa57d`  
**Design branch:** `feature/project-autonomy-construction`  
**Status:** Design approved in conversation; implementation not started  
**Scope boundary:** This specification extends MC_AI_Player with durable multi-step projects, construction, survival-aware execution, user/project autonomy, collaboration, storage ACLs, and versioned Minecraft gameplay knowledge. It does not merge or bypass the existing routing, identity, Goal/Skill, SafetyPolicy, quota, or memory boundaries.

## 1. Goal

Extend MC_AI_Player from safe one-command/one-goal behavior into a durable project-oriented agent that can execute long-running survival-mode tasks such as:

- build a house or base from a conversational request;
- ask only the missing questions needed to clarify the build;
- design a constrained but creative structure;
- derive an exact blueprint and bill of materials;
- gather, craft, smelt, stonecut, equip tools, use authorized storage, prepare terrain, scaffold, build, fight hostile mobs, recover from interruptions, and clean up;
- persist project state across MC_AI_Player, Paper, or host restarts;
- continue already-approved work while the owning player is offline, within the approved autonomy and safety envelope;
- support multiple users with different autonomy preferences and strict project ownership/collaboration boundaries;
- surface concise Minecraft chat feedback for accepted work, questions, meaningful blockers, safety pauses, and completion.

The central authority rule is:

> AI understands ambiguous human intent and makes creative/high-level planning choices. Deterministic systems own Minecraft mechanics, permissions, recipes, tool use, resource accounting, world mutation, safety, recovery, and execution.

AI must never directly call Mineflayer world-mutation APIs.

## 2. Existing architecture preserved

This design builds on the existing production principles:

- addressed Minecraft chat creates bounded AI tasks;
- routine and complex Gemini routes remain quota-aware and deterministic;
- Gemini returns schema-constrained output rather than executing gameplay directly;
- `DecisionGate -> SafetyPolicy -> GoalManager -> SkillExecutor` remains authoritative for current single-goal actions;
- generic navigation cannot dig or place blocks;
- PvP remains disabled by hard policy;
- Minecraft memory remains separate from quota state;
- online-mode UUID identity is required for trusted persistent player identity;
- provider reasoning, raw prompts, API keys, and internal secrets are not exposed to telemetry or Minecraft chat.

The existing one-action pipeline remains appropriate for actions such as `stay`, `follow_player`, `go_to`, `equip`, and simple `gather_resource`. Project orchestration is a new layer above it, not a replacement for it.

## 3. Non-goals

The first implementation does not promise:

- WorldEdit-like remote block placement;
- unrestricted model-generated coordinate lists;
- bypassing SafetyPolicy under `fully_autonomous` mode;
- trusting usernames as persistent identity on offline-mode servers;
- automatically using arbitrary nearby player containers;
- destroying suspected player structures merely because they obstruct a plan;
- unlimited retries, unlimited model calls, unlimited travel, or unlimited terrain mutation;
- perfect architectural aesthetics for arbitrary free-form prompts;
- PvP or retaliation against players;
- concurrent control of more than one Minecraft bot body;
- treating the committed knowledge pack as a replacement for the live Minecraft world state;
- storing chain-of-thought or private provider reasoning;
- placing world-specific project state, player UUID preferences, storage coordinates, or private server state in GitHub.

## 4. Architectural layers

```text
Minecraft chat / player action
          |
          v
Identity + Project Resolver
          |
          v
Conversation Resolver ---------> User Preferences
          |                     Project ACL
          v                     Storage ACL
BuildIntentDraft
          |
          | ambiguous semantics only
          v
Semantic Interpreter (AI, when needed)
          |
          v
Project Planner (AI for creative/high-level decisions)
          |
          v
ArchitecturalPlan
          |
          v
Deterministic Blueprint Compiler
          |
          +----> Exact Blueprint + BOM
          |
          v
Knowledge / Supply Planner
          |
          v
Durable Project Task Graph
          |
          v
Deterministic Executors
  navigation / gathering / tools / crafting / smelting /
  storage / terrain / scaffolding / construction / combat
          |
          v
Survival Supervisor + SafetyPolicy
          |
          v
Minecraft world
```

The Project layer coordinates durable work. Existing Goal/Skill execution remains the bounded actuator path beneath it.

## 5. Conversational requirement collection

### 5.1 One missing question at a time

A new build request creates a durable `BuildIntentDraft`. The system asks one short question at a time only for material information that is not already known.

Example:

```text
Player: 墨雪幫我蓋個房子
Moxue: 好呀～要蓋在哪？
Player: 就這裡

Moxue: 材料有指定嗎？還是附近好取得的就好？
Player: 木頭、玻璃、原木、地毯

Moxue: 大概要多大？
Player: 兩個人住，不要太大

Moxue: 想要什麼風格？
Player: 山裡溫馨一點，你自己決定細節
```

The system must not present a questionnaire containing all missing slots at once.

### 5.2 Deterministic parsing before AI

Common answers must be handled without model calls where possible:

- `就在這裡` -> current player position;
- explicit dimensions such as `10x8，高6格` -> numeric parsing;
- known material identifiers -> material constraints;
- `附近好取得的就好` -> delegated material sourcing policy;
- a registered storage alias -> Storage resolver;
- `安全模式` -> autonomy value;
- `你自己決定` -> mark the active slot as delegated;
- yes/no answers -> current pending question;
- looked-at block/container/structure -> deterministic raycast/spatial resolver.

AI is reserved for genuinely ambiguous semantic interpretation, for example `兩個人住舒服一點，不要太大` or `做得像北歐森林裡的小屋`.

### 5.3 Draft slot states

Each draft field carries one of:

```text
unknown
explicit
inferred
delegated
```

`delegated` means the player intentionally asked Moxue to choose. The conversation must not re-ask that slot later.

### 5.4 Question budget

Small projects should normally need only a few high-value questions. If the player repeatedly delegates choices, the system should converge quickly instead of forcing every optional field to be answered.

### 5.5 Durable drafts

Incomplete drafts survive process restarts. On restart, the system continues from the next unresolved important slot rather than starting the interview over.

## 6. Project identity and resolution

### 6.1 UUID is authoritative

In online-mode servers, persistent project identity is keyed by normalized Minecraft UUID. Player names are display snapshots only. A name change must not orphan projects or preferences.

Offline-mode identity is not trusted for persistent privilege-sensitive project ownership unless a future explicit identity design is approved.

### 6.2 Project selection

When a player does not explicitly name a project, resolve in this order:

1. explicit project name or alias;
2. conversation-bound project;
3. nearby projects for which the player is an authorized member;
4. recent authorized project if unique;
5. if more than one plausible candidate remains, ask one short disambiguation question.

ACL filtering occurs before distance/recency ranking. A project the player cannot operate must not be considered merely because it is nearby.

## 7. User autonomy, project autonomy, and approval

### 7.1 User-specific default

Each player may have a per-world/server default autonomy mode:

```text
safe
aggressive
fully_autonomous
```

Different players may use different defaults on the same server.

A new project copies the owner's current default into `project.autonomy_mode`. Changing the user's default later does not silently upgrade or downgrade existing projects.

### 7.2 Project override

The owner can explicitly override autonomy for an individual project. Project mode applies to all collaborators operating that project; a collaborator's personal default does not override the project's policy.

### 7.3 Authority stack

Autonomous actions resolve under this precedence:

```text
Hard Safety
  > Server Policy Ceiling
  > Project Approval Envelope
  > Project Autonomy Mode
  > Current Task Permit
```

`fully_autonomous` never means `bypass_safety`.

### 7.4 Mode semantics

`safe`:

- ordinary gathering, crafting, tool use, temporary scaffolding, small terrain preparation, and local blueprint adjustments may be autonomous;
- visually meaningful material substitutions, large terrain changes, suspected player-content mutation, or scope expansion normally require the owner.

`aggressive`:

- may make broader low-risk terrain changes, larger ordinary-resource acquisitions, and non-critical blueprint adjustments within the approved scope;
- still cannot bypass protected content, storage ACLs, server ceilings, or hard safety.

`fully_autonomous`:

- may replan substantially within the approved envelope, substitute permitted materials, move a build locally if allowed, and create/remove temporary project infrastructure;
- still cannot bypass hard safety, protected zones, ACLs, anti-loop budgets, or explicit project restrictions.

### 7.5 Small versus destructive work

The default approval model is:

- small, ordinary projects inside the normal autonomy envelope may proceed after conversational requirements are sufficiently resolved;
- large, destructive, unusually expensive, protected-area-adjacent, or materially scope-changing projects require an explicit owner approval before the destructive plan begins.

Approval is for the plan/envelope, not every subtask. Once approved, routine subtasks should not repeatedly ask for permission.

## 8. Project ownership and collaboration ACL

### 8.1 Roles

Each project has exactly one owner and optional collaborators:

```text
owner
manager
helper
```

Owner:

- full project control;
- change project autonomy;
- approve high-risk scope;
- manage managers/helpers;
- transfer ownership;
- cancel project.

Manager:

- modify ordinary design/material choices within the owner's approved envelope;
- reorder work;
- pause/resume the project;
- add/remove helpers;
- operate existing approved task branches;
- cannot transfer ownership, add managers, bypass hard safety, or raise autonomy beyond the owner-approved project setting.

Helper:

- execute existing approved work;
- gather resources;
- craft/smelt/build according to the current plan;
- inspect progress;
- pause their current work;
- cannot change blueprint, autonomy, ACL, or approve destructive expansion.

Only the owner may change project autonomy.

### 8.2 Conflict policy

Authority ordering is:

```text
owner > manager > helper
```

A higher-role instruction may supersede a lower-role instruction when it is valid and within hard safety.

Conflicting instructions from the same role do not use "last message wins". The affected task branch becomes `blocked_by_conflict` and waits for the owner. Unaffected task branches continue if dependencies permit.

Conflicts are durable and survive restart.

## 9. Existing-world mutation policy

The default world-content policy is:

> Natural terrain may be modified according to an approved terrain plan. Suspected player-built content is conservatively protected unless the project owner has explicitly authorized the relevant mutation.

Examples of normally protected/ambiguous existing content include:

- containers;
- redstone components;
- beds and functional stations;
- doors, glass, stairs, decorative patterns, or obvious walls;
- valuable or unusual blocks;
- known protected areas;
- structures attributed to another project/player.

Natural terrain classification, project provenance, protection records, and live world observations all inform the policy. Block type alone is not sufficient to prove ownership.

## 10. Storage registry and access control

### 10.1 Explicit authorization only

Moxue may automatically withdraw from a container only if it is explicitly registered and authorized for the player/project/server policy.

Nearby containers are not free resources merely because they are accessible.

### 10.2 Registration flow

Storage registration prefers:

1. the container the player is currently looking at;
2. a unique nearby candidate;
3. if ambiguous, one short clarification question.

No coordinate entry is required when deterministic spatial resolution is sufficient.

### 10.3 Storage subjects

Storage ACLs may grant use to:

```text
player
project
server_public
```

Project-created temporary storage is automatically registered to that project and tracked by provenance.

## 11. Planner and constrained creative design

### 11.1 Hybrid design model

The selected design mode is constrained creativity:

- AI may decide style, layout, room arrangement, roof type, palette intent, and other creative choices;
- AI does not emit arbitrary hundreds/thousands of raw block coordinates as the primary plan;
- AI produces a schema-constrained `ArchitecturalPlan` built from bounded primitives and constraints;
- a deterministic compiler produces the exact block blueprint.

### 11.2 Architectural primitives

Typical primitives include:

```text
foundation
floor
wall
opening
window
door
pillar
beam
roof
stairs
interior_zone
workstation_zone
storage_zone
```

The compiler owns legal Minecraft placement details such as stair direction, slab half, support requirements, two-block objects, gravity, and replaceability.

### 11.3 Exact BOM

The bill of materials is computed from the compiled exact blueprint. The model does not guess final material counts.

## 12. Versioned Minecraft Game Knowledge Pack

### 12.1 Public source-of-truth data

Minecraft gameplay facts required for deterministic planning should be stored as human-reviewable versioned source data in the repository, for example:

```text
game-data/java/<version>/
  blocks.json
  items.json
  recipes.json
  smelting.json
  stonecutting.json
  fuels.json
  tools.json
  combat.json
  workstations.json
```

Generated runtime indexes or SQLite caches may be produced from these sources, but opaque binary databases are not the only committed source of truth.

### 12.2 Minecraft facts versus Moxue policy

Separate objective game facts from behavioral policy.

Game facts include:

- recipes and processing routes;
- furnace/stonecutter/workstation requirements;
- fuel values;
- block hardness and harvest requirements;
- tool effectiveness, durability, attack damage/speed;
- stack sizes, drops, gravity, replaceability, food values.

Moxue policy includes:

- scaffold suitability;
- tool preservation thresholds;
- rarity penalties;
- combat preference;
- terrain-mutation risk;
- temporary infrastructure cleanup policy.

### 12.3 Recipe graph

Resource planning recursively resolves a requested output through available production routes. Intermediate items, workstations, furnaces, fuel, and raw materials become explicit dependencies.

Example concept:

```text
requested decorative stone
  -> stonecutting/crafting intermediate
  -> smelting intermediate
  -> smelting raw material
  -> raw resource + fuel + furnace capacity
```

The implementation must derive the chain from data rather than hard-code special cases for individual blocks.

### 12.4 Workstation capacity

Workstations are resources. If processing demand exceeds existing authorized infrastructure, the planner may create temporary capacity, for example additional furnaces, then clean up or promote useful workstations to persistent project infrastructure.

## 13. Supply planning and material reservations

Supply planning chooses among:

- authorized storage;
- current inventory;
- nearby legal natural resources;
- crafting/smelting/stonecutting routes;
- permitted material substitutions.

Cost may consider:

```text
travel
collection time
processing time
tool wear
fuel
rarity
risk
```

The planner must never use "cheapest source" as permission to destroy protected player content.

Shared sources require material reservations so parallel task branches do not double-count the same container stock.

## 14. Automatic tool selection

Gathering and construction must automatically select/equip appropriate tools without an AI call for each block.

Tool selection considers:

- effectiveness against target block;
- required harvest tier;
- durability remaining;
- player/project preservation policy;
- enchantment value when available;
- replacement availability.

If a useful axe exists, gathering logs should not default to bare-hand mining. A nearly broken valuable tool may be preserved in favor of a suitable alternative.

If all adequate tools are unavailable, the Task Graph may create tool-crafting/resource subtasks.

## 15. Terrain preparation

Terrain preparation supports deterministic operations:

```text
CUT   - remove approved natural terrain
FILL  - fill approved low areas
SHAPE - preserve/adapt to useful natural contours
```

The player may specify preferred fill material. Otherwise the supply planner chooses safe, legal, low-cost material under the project policy.

Terrain preparation remains bounded by the approval envelope and existing-player-content protection.

## 16. Construction Engine

### 16.1 Site survey before mutation

Before construction begins or resumes, compare the approved plan with current world state and classify relevant positions, for example:

```text
air
replaceable
natural_terrain
liquid
known_project_block
temporary_project_block
suspected_player_content
protected
unknown
```

Unexpected player/unknown content is not overwritten automatically merely because the plan expects air.

### 16.2 Construction DAG

Placement order follows dependencies rather than a blind coordinate scan. Structural supports, floors, walls, openings, roof sections, attached blocks, and decoration become task dependencies.

Independent branches may progress separately even when another branch is blocked.

### 16.3 Reachability

Construction is survival-valid. Every placement/break operation must have a reachable legal working position. The agent may not act like WorldEdit.

The reachability planner may create temporary access tasks such as scaffolds, walkways, or work platforms.

### 16.4 Scaffolding policy

Temporary scaffold material is selected deterministically.

Priority:

1. user-specified scaffold material;
2. suitable reusable low-value project material;
3. renewable/safe temporary materials;
4. other permitted disposable blocks.

Leaves are a preferred candidate when:

- no user scaffold material was specified;
- shears are available;
- leaves can be legally obtained without damaging protected/player content;
- the material is suitable for the current access plan.

All temporary access blocks are tracked with provenance and cleanup requirements.

### 16.5 Local recovery

Placement failures first use deterministic recovery:

- re-observe target;
- verify material/equipment;
- select another standing position;
- recompute look/placement face;
- re-path;
- rebuild a damaged scaffold stage;
- mark already-correct world state as complete.

Only structural/semantic plan problems escalate to an AI replan.

### 16.6 Cleanup and final verification

Project completion requires more than placing the final planned structural block. Cleanup includes:

- remove temporary scaffolds/bridges/platforms;
- collect reusable/dropped materials;
- resolve temporary storage/workstations;
- promote useful stations to project infrastructure when appropriate;
- verify required structural and functional conditions;
- ensure required access/entrances remain usable.

Optional decorative divergence or accepted user changes must not force destructive correction when the project remains valid.

## 17. Project infrastructure lifecycle

Project-created infrastructure has lifecycle metadata:

```text
temporary
project_persistent
shared
```

Temporary construction artifacts are removed at cleanup. Useful furnaces, crafting tables, stonecutters, storage, beds, or similar facilities may be retained and registered as persistent infrastructure so future plans can reuse them.

## 18. Survival Supervisor

### 18.1 Preemption is suspension, not loss of work

Long-running project work may be suspended by survival needs, then resumed from a durable checkpoint after revalidation.

Priority order is conceptually:

```text
Emergency survival
  > Survival critical
  > Maintenance
  > Project work
```

### 18.2 Hunger and health

Hunger maintenance should normally be deterministic and silent. Low-health recovery may require retreat, food, waiting for regeneration, and a higher resume threshold for high-altitude work or combat.

### 18.3 Night and environmental risk

Night does not automatically stop work. Risk assessment considers lighting, equipment, hostile entities, work type, and project autonomy. Safe mode may pause sooner; aggressive/full may prepare lighting or clear ordinary hostile threats when safe.

### 18.4 Inventory pressure

When inventory approaches capacity:

- use authorized project storage if available;
- otherwise create temporary project storage if policy allows;
- never dump important/player-owned resources merely to free slots without policy.

## 19. Combat policy

### 19.1 Deterministic hostile-mob response

Normal combat does not require a model call. Threat assessment considers entity type, distance, targeting, hostile count, health, armor, weapon/ammo, terrain, escape route, and explosion/projectile risk.

Possible actions include:

```text
ENGAGE
EVADE
RETREAT_TO_SAFE_POINT
REPOSITION
PAUSE_PROJECT
```

### 19.2 Weapon selection

Weapon choice considers effective DPS, range, available ammunition, durability, enemy type, and current distance. A bow without arrows is not considered a usable ranged weapon. If no dedicated weapon exists, an allowed effective tool such as an axe may be selected.

### 19.3 PvP hard boundary

Players are not combat targets. Player aggression against Moxue may cause retreat, project pause, or notification, but never autonomous PvP retaliation under this design.

### 19.4 Creeper/explosion recovery

Explosion-prone threats should be kept away from construction where possible. If an explosion alters a project area, stop affected branches, reconcile blueprint/provenance/world state, and repair only within authorized project scope.

## 20. Death and recovery

Bot death interrupts active executors and marks affected project work as interrupted, not silently running.

After respawn:

1. re-observe position, health, inventory, equipment, and world state;
2. decide whether dropped inventory is safely recoverable;
3. recover if permitted and reasonable;
4. reconcile affected project state;
5. resume or pause.

A repeated-death circuit breaker prevents infinite corpse-recovery loops. Autonomy mode may change tolerance, but hard retry caps remain.

## 21. Durable Project Task Graph

A project is not a single giant `build_house` skill. It is a durable DAG of bounded tasks, for example:

```text
Project: mountain base
  |- survey site
  |- generate/approve plan
  |- resolve BOM
  |- acquire wood
  |- acquire stone
  |- acquire fuel
  |- ensure furnace capacity
  |- smelt/process materials
  |- prepare terrain
  |- build foundation
  |- build walls
  |- build roof
  |- interior/storage
  |- cleanup
  `- verify
```

Each node has durable status, progress, attempts, recovery count, and dependencies.

Typical statuses include:

```text
pending
runnable
running
suspended
blocked_by_conflict
dependency_blocked
paused_waiting_player
paused_safety
completed
failed
cancelled
```

Blocking one branch must not freeze unrelated runnable work.

## 22. Restart persistence and world reconciliation

Long-running projects survive MC_AI_Player, Paper, or host restart.

On startup, projects do not blindly continue from remembered coordinates. They enter `recovering`:

```text
load durable state
  -> re-observe relevant world regions
  -> validate current plan version
  -> compare inventory/storage/infrastructure
  -> reconcile recorded mutations with actual world
  -> detect external player changes
  -> rebuild runnable task set
  -> resume only authorized work
```

The world is the final physical truth. Persistence records intent, provenance, and prior observations, not an authoritative clone of the Minecraft world.

## 23. Offline-owner continuation

Already-approved work may continue when the project owner disconnects if:

- the task is within the project approval envelope;
- current autonomy permits it;
- no new conflict/approval/safety boundary is reached;
- storage/resource rights remain valid.

If a decision requires owner authority, affected branches pause as `paused_waiting_player` while independent approved branches may continue.

## 24. Project state database

Create a dedicated local state database, conceptually `data/project-state.sqlite3`, separate from `mc_memory.sqlite3` and `ai-quota.sqlite3`.

### 24.1 Core entities

Conceptual tables include:

```text
players
player_preferences
projects
project_members
project_audit_log
build_drafts
project_plan_versions
project_tasks
project_task_dependencies
project_conflicts
project_conflict_options
storages
storage_access
project_infrastructure
resource_reservations
block_mutations
project_checkpoints
```

Exact SQL is implementation-plan work, but the relational boundaries are normative.

### 24.2 Audit

Important project mutations store actor UUID, actor role, safe action summary, project ID, and timestamp. Raw chain-of-thought is never stored.

### 24.3 Provenance journal

World mutations made by project executors record enough metadata to distinguish project build blocks, terrain changes, scaffolds, temporary bridges/platforms, and temporary lighting.

The journal is evidence, not authority. If a recorded scaffold position now contains a chest, cleanup must not blindly break it.

### 24.4 Retention

Long-term retain:

- projects and ownership;
- current/important historical plans;
- user preferences;
- ACLs;
- registered storage/infrastructure;
- important audit summaries.

Active-project retain:

- detailed task graph;
- reservations;
- block-mutation journal;
- checkpoints.

After verified completion, detailed low-value execution records may be compacted while preserving project identity, important provenance, infrastructure, and summary history.

## 25. AI planning and routing

### 25.1 Separate Project Planning contract

Do not overload the current exact action-tool DecisionOutcome contract with large project design schemas.

Introduce a separate Project Planning pipeline that reuses the existing model routing, quota ledger, project pool, and credential boundaries while exposing planning-specific schemas.

### 25.2 AI usage levels

```text
Level 0 - no AI
  deterministic parsing, ACL, project resolution, recipes, tools,
  pathfinding, resource math, crafting, smelting, combat,
  terrain, scaffolding, placement, recovery, persistence

Level 1 - routine semantic interpretation
  ambiguous but small conversational slot interpretation

Level 2 - architectural planning
  creative layout/style/material intent and meaningful redesign

Level 3 - deep replan
  repeated structural planning failure or explicitly trusted deep review
```

### 25.3 Default model effort

- simple semantic slot interpretation -> routine model / low;
- first architectural plan -> complex model / medium;
- ordinary structural replan -> complex / medium;
- repeated structural replan or trusted critical/manual deep context -> existing high-thinking policy.

Large physical build size alone is not a reason for high thinking.

### 25.4 Replan hierarchy

`Local Recovery` - no AI.  
`Supply Replan` - normally no AI.  
`Structural Replan` - AI may be required.

Structural replan prompts receive bounded summaries of affected regions/constraints instead of entire event logs or full historical block lists.

### 25.5 Per-project AI soft budget

In addition to provider quota, each Project has bounded semantic/planning/replan soft budgets. Exhaustion first drives deterministic fallback; if a real design decision remains unresolved, the relevant branch pauses rather than burning unbounded quota.

## 26. General execution budgets and circuit breakers

Each long project is governed by bounded envelopes such as:

```text
resource budget
world-mutation budget
travel budget
risk budget
retry budget
replan budget
AI-call budget
```

`fully_autonomous` expands decision freedom inside the approved envelope; it does not create infinite budgets.

Repeated identical failures, repeated placement failure, repeated structural replans, and repeated deaths trigger circuit breakers and safe pause states.

## 27. Chat feedback strategy

### 27.1 Wire the existing ChatRenderer boundary

The existing renderer already models concise started/completed/failed messages. The production Minecraft runtime should connect project/action lifecycle events to a bounded chat-output port.

### 27.2 Event-driven chat, not thought narration

Chat categories:

```text
ACK
QUESTION
IMPORTANT_PROGRESS
WAITING
SAFETY
COMPLETE
FAILURE
```

Examples:

```text
好，我先看看這附近。
材料差一些木頭，我去準備。
屋頂有兩種不同指示，我先停這部分。
那邊現在太危險，我先撤回來了。
蓋好了～鷹架也收乾淨了。
```

Routine details stay silent: tool swaps, eating, refueling furnaces, killing ordinary mobs, retrying pathfinding, moving items, or removing each scaffold block do not need a chat line.

### 27.3 Chat should not consume an extra model call by default

Most messages are deterministic templates generated from safe structured events. Model-generated prose is not required for routine acknowledgements or completion.

Provider errors, raw prompts, API keys, chain-of-thought, or internal policy details are never forwarded to Minecraft chat.

## 28. Failure taxonomy

Project/executor failures use machine-readable classes, for example:

```text
recoverable_local
resource_shortage
permission_denied
approval_required
world_divergence
conflict
safety_pause
planner_exhausted
provider_unavailable
hard_failure
```

Minecraft chat presents a short safe user-facing explanation rather than internal codes or provider details.

If the AI provider is unavailable but an approved plan/task graph is already executable, deterministic work may continue. Only new semantic/planning decisions must pause for AI recovery.

## 29. Concurrency and locks

The bot has one physical Minecraft body even when the Project DAG has parallel-ready branches.

Runtime coordination therefore requires explicit locks/reservations such as:

```text
movement lock
inventory lock
container lock
world-region mutation lock
workstation reservation
material reservation
```

Planning may exploit parallelism such as smelting while gathering, but physical bot actions are scheduled safely and shared resources cannot be double-counted.

## 30. Safety invariants

The implementation must preserve these invariants:

1. generic navigation cannot dig or build;
2. world mutation requires a purpose-specific validated permit;
3. AI cannot call Mineflayer world mutation directly;
4. hard PvP deny remains authoritative;
5. suspected player content defaults to protection;
6. storage requires explicit ACL authorization;
7. project identity/ACL is UUID-bound in trusted online-mode identity;
8. collaborator personal defaults cannot override project autonomy;
9. `fully_autonomous` cannot bypass hard safety, server ceilings, project approval envelope, ACL, or circuit breakers;
10. restart recovery validates the live world before continuing;
11. temporary block cleanup uses provenance plus live verification, never provenance alone;
12. no raw model reasoning/secrets in persistent project state or Minecraft chat.

## 31. Implementation decomposition

Implementation should be staged rather than landed as one monolithic change. The future implementation plan should separate at least these bounded milestones:

1. Chat output port and existing ChatRenderer production wiring;
2. automatic tool selection for existing gathering;
3. Project DB + player preferences + ownership/ACL + resolver;
4. durable conversational drafts;
5. versioned game knowledge pack + validation tooling;
6. recipe/supply/workstation planner;
7. crafting/smelting/stonecutting adapters and skills;
8. blueprint schema/compiler;
9. terrain/construction/scaffold runtime with permits;
10. survival supervisor + combat/death recovery;
11. durable Project Task Graph orchestration/recovery;
12. Project Planning Gemini contract/routing and constrained architectural planner;
13. multiplayer conflict handling, storage registration/ACL, infrastructure lifecycle;
14. live private-server validation, restart recovery, offline-owner continuation, and soak testing.

The detailed RED -> GREEN sequencing belongs in the implementation plan after this design is reviewed.

## 32. Testing strategy

Automated tests must include:

- per-user autonomy isolation;
- project override versus user default;
- hard safety/server ceiling precedence;
- owner/manager/helper permission matrix;
- same-role conflict branch blocking and owner resolution;
- project resolver ambiguity and ACL filtering;
- draft slot persistence and `delegated` semantics;
- storage registration and unauthorized-container denial;
- recipe graph expansion, workstation/fuel dependencies, cycle protection;
- material reservations and stock divergence;
- automatic tool selection and durability preservation;
- terrain classification and suspected-player-content protection;
- scaffold selection including leaves+shears conditions;
- temporary provenance cleanup safety;
- construction dependency/reachability/retry behavior;
- low food/low health suspension and resume;
- hostile-mob combat/retreat selection with PvP denial;
- death-loop circuit breaker;
- provider unavailable while deterministic approved work continues;
- restart recovery and world divergence reconciliation;
- unaffected DAG branches continuing while another branch is blocked;
- chat feedback deduplication/noise limits;
- no secrets/reasoning leakage.

Live validation must cover at minimum:

- a small house from short conversational requirements;
- automatic use of an appropriate tool supplied by the player;
- resource acquisition with crafting/smelting/workstation dependencies;
- terrain preparation and high-place scaffold construction;
- hostile-mob interruption and resumption;
- process restart mid-build;
- player offline while approved work continues;
- external world modification during downtime;
- two-player project ACL and same-role conflict behavior;
- temporary scaffold/workstation cleanup and persistent infrastructure promotion.

## 33. Acceptance criteria

The first complete release of this architecture is acceptable when all of the following hold:

- a player can say a high-level request such as `幫我蓋個房子` and receive short one-at-a-time clarification only when needed;
- the resulting project is owned by the correct player UUID and uses that player's default autonomy unless the project overrides it;
- a constrained AI plan becomes a deterministic blueprint/BOM;
- resource/workstation/tool/crafting/smelting chains are derived without per-step AI calls;
- gathering uses appropriate tools automatically;
- construction can legally reach high placements using tracked temporary access;
- natural terrain may be prepared while suspected player structures remain protected by default;
- hostile mobs, hunger, low health, full inventory, tool wear, and death are handled without losing project progress;
- the project survives restart and reconciles against the live world before resuming;
- approved work can continue while the owner is offline and pauses only when owner authority is newly required;
- owner/manager/helper permissions and same-role conflict behavior are enforced;
- unauthorized containers are never treated as material sources;
- temporary construction artifacts are cleaned up safely and useful infrastructure may persist;
- AI usage remains concentrated on semantic ambiguity and creative/structural planning rather than Minecraft mechanics;
- Minecraft chat provides concise lifecycle visibility without becoming a per-action log;
- all existing routing, quota, reasoning-isolation, identity, and SafetyPolicy invariants remain intact.
