# Workspace / Area Planner Design

**Date:** 2026-09-20  
**Branch:** `feature/workspace-planner`  
**Base:** `b75cb48` (SAFE PARALLELIZATION POINT)  
**Status:** Active design / implementation

## 1. Goal

Add a durable workspace-planning system that lets a trusted player select a Minecraft region with a dedicated setting wand, describe what the region is for, and ask Moxue to perform bounded work inside it later.

The system must support both persistent semantic regions and executable directives without hard-coding one branch per use case.

Examples:

- select a 5 x 10 x 10 cuboid and say “這裡是快速熔爐”;
- select a 9 x 9 surface and say “這裡是農田”;
- select a very large region spanning many chunks and say “把這區點亮”;
- specify “每隔 5 格放一個火把”;
- if the requested spacing cannot guarantee the configured spawn-light safety target, Moxue must ask for confirmation or propose a safer spacing before executing.

## 2. Architectural boundary

### 2.1 MC_AI_Player owns

- workspace/region domain model;
- durable workspace repository;
- semantic labels, purpose, tags and constraints;
- selection-to-workspace binding;
- lighting/building/production planning;
- risk analysis and confirmation state;
- deterministic task decomposition;
- mutation permits and execution.

### 2.2 Paper observation bridge owns

Mineflayer cannot reliably observe another player clicking arbitrary blocks with a stick.

A Paper-side observation adapter is therefore required for the setting wand. It should observe trusted player interactions and expose bounded semantic selection events to MC_AI_Player.

It must not grant arbitrary world mutation authority.

Preferred wand identity:

- visible display name: `墨雪設定棍`;
- internal persistent marker/version, e.g. `moxue:workspace_wand=v1`, when the Paper plugin can provide it;
- exact material: `minecraft:stick`.

The visible name is for the user; the persistent marker is the authoritative identity when available.

## 3. Selection interaction

Default interaction model:

- first wand click on a block sets point A;
- second wand click sets point B;
- the two points define an inclusive axis-aligned cuboid;
- repeating starts/replaces the pending selection;
- the bridge reports player identity, world/dimension, both points and timestamps.

Alternative left/right-click UX may be implemented by the Paper adapter, but MC_AI_Player receives the same semantic `WorkspaceSelection`.

A complete selection has deterministic geometry:

```text
min = component-wise min(A, B)
max = component-wise max(A, B)

sizeX = max.x - min.x + 1
sizeY = max.y - min.y + 1
sizeZ = max.z - min.z + 1
volume = sizeX * sizeY * sizeZ
```

Selections may cross chunk boundaries. Chunk coverage is derived, never manually enumerated by the user.

## 4. Persistent workspace model

```ts
WorkspaceRegion {
  id
  worldKey
  dimension
  bounds
  label
  purpose
  moxueUsePolicy
  tags
  constraints
  ownerPrincipal
  sourceSelection
  createdAt
  updatedAt
}
```

A region separates human naming from machine semantics.

Examples:

- `label = "快速熔爐"`
- `purpose = "production"`
- `tags = ["smelting", "high-throughput"]`

or:

- `label = "東側農田"`
- `purpose = "farm"`
- `tags = ["crop"]`

Unknown/custom labels remain valid metadata and do not require new control-flow code.

## 5. Region purpose

Initial generic purpose vocabulary should remain small:

- `production`
- `farm`
- `storage`
- `construction`
- `lighting`
- `protected`
- `transit`
- `custom`

Purpose is planning metadata, not an executor switch.

Detailed meaning belongs in tags, constraints, project/task data, or versioned knowledge.

## 6. Workspace constraints

A workspace may carry reviewed constraints such as:

- allowed block mutation classes;
- preserve-existing-structures;
- allowed vertical range;
- lighting target;
- requested placement spacing;
- temporary/scaffolding allowance;
- access/storage hints;
- do-not-build / protected semantics.

Constraints are data and must be validated.

## 7. Workspace directives

Persistent region metadata and work requests are separate.

Examples:

- “這裡是農田” -> create/update region metadata;
- “把這區點亮” -> create a lighting directive referencing the region;
- “這裡蓋快速熔爐” -> future project/construction directive referencing the region;
- “每隔 5 格放火把” -> lighting directive with requested spacing = 5.

This avoids turning every region label into an immediate mutation command.

## 8. Workspace lifecycle management

A completed wand selection is temporary observation state. A durable workspace is a separate managed entity.

Workspace lifecycle must follow the same durable-state principles as Project Autonomy:

```text
temporary selection
  -> create durable workspace
  -> resolve workspace deterministically
  -> authorize actor
  -> update/archive/restore
  -> append audit
  -> later directives reference workspace id
```

### 8.1 Status

Workspace status is explicit:

- `active`
- `archived`

Ordinary user "delete" maps to `archived`, not physical row deletion.

Archived workspaces:

- are excluded from ordinary resolver/search results;
- retain geometry, semantics, owner, provenance and audit history;
- cannot receive new execution directives;
- may be restored by an authorized owner/manager policy;
- remain available for dependency/history inspection.

Physical purge is a separate maintenance operation and must be dependency-safe once Projects/Lighting/Production can reference workspace IDs.

### 8.2 Managed mutations

The lifecycle service owns bounded operations:

- create from a current trusted selection;
- rename;
- replace bounds from a new trusted selection;
- change purpose;
- replace/add/remove tags;
- change reviewed constraints;
- archive;
- restore.

Each operation writes one audit entry transactionally with the state mutation.

### 8.3 Audit

Audit records contain safe structured provenance:

```text
workspace id
actor principal
action
safe summary
timestamp
source selection id when relevant
```

Do not store raw model reasoning or arbitrary chat history in audit rows.

### 8.4 Resolver

Workspace resolution is deterministic and ACL-filtered before semantic ranking.

Preferred precedence:

1. explicit workspace id/name;
2. conversation-bound workspace;
3. workspace matching the latest trusted selection/intersection;
4. unique nearby authorized workspace;
5. unique recent authorized workspace;
6. otherwise ambiguous/none.

Same-name ambiguity must not use last-write-wins. Ask one short disambiguation question.

### 8.5 Ownership

Initial Workspace v1 uses one authoritative owner principal. Persistent identity should converge on the same trusted UUID/session identity used by Project Autonomy.

Selection player name is descriptive only; player id/UUID is the authority key.

Ownership controls Workspace management authority. It is distinct from `moxueUsePolicy`, which controls whether Moxue may use the region operationally.

### 8.6 Moxue use policy

Workspace ownership and Moxue usage permission are separate concepts.

`ownerPrincipal` answers who may manage the Workspace metadata. It must not be overloaded to decide whether Moxue may consume/use resources inside that Workspace.

Initial use-policy vocabulary:

- `owner_only`
  - represents private/player-owned use;
  - Moxue may know the region exists so planning can avoid conflicting use;
  - Moxue must not harvest crops, withdraw/deposit storage contents, consume production output, or perform ordinary workspace mutation there;
  - simple path traversal is not automatically forbidden unless a separate protected/no-entry constraint says so.

- `shared`
  - ordinary default for statements such as "這是倉庫" or "這是農田";
  - Moxue may use the Workspace when purpose-specific rules, storage ACLs and SafetyPolicy permit it.

- `moxue_preferred`
  - for statements such as "這是你專用的農田/倉庫" or "這個給你用";
  - Moxue may use it and should prefer it over equivalent `shared` candidates during deterministic planning;
  - "專用" in this v1 policy means preferred for Moxue, not a claim that humans are forbidden from using it;
  - if a future user explicitly says "只有你能用", that stronger exclusivity should be modeled separately rather than inferred silently.

Default policy for newly defined ordinary Workspaces is `shared`.

Natural-language examples:

```text
"墨雪 這是我的私人倉庫"
"墨雪 這是我自己的農田"
"墨雪 這是我的倉庫"
-> moxueUsePolicy = owner_only

"墨雪 這是你專用的農田"
"墨雪 這個倉庫給你用"
"墨雪 這是墨雪專用倉庫"
-> moxueUsePolicy = moxue_preferred

"墨雪 這是倉庫"
"墨雪 這是農田"
-> moxueUsePolicy = shared
```

Use policy is metadata/authorization input. It does not by itself grant block mutation, container access, or bypass storage/project/SafetyPolicy checks.

### 8.7 Management versus execution

Workspace lifecycle operations change metadata only.

They do not:

- place/break blocks;
- authorize mutation;
- start lighting/building automatically;
- bypass Project/SafetyPolicy permits.

Execution directives reference active workspace IDs after lifecycle resolution.

## 9. Lighting planner

Lighting must be deterministic and terrain-aware.

Inputs:

- workspace bounds;
- requested spacing, if supplied;
- placement surface constraints;
- configured spawn-safety target;
- current observed terrain/light state;
- available torch-like light source capability.

Planner output:

- candidate placements;
- covered chunk/cell batches;
- predicted/verified dark cells;
- risk classification;
- suggested safer spacing when needed.

### 8.1 Safety behavior

For Minecraft 1.21.x hostile-spawn prevention, the implementation should not rely only on a hand-wavy spacing formula.

The executor should verify actual block-light / spawnable-cell observations when available.

If a user explicitly requests a spacing that leaves possible spawnable dark cells:

```text
requested spacing: 12
planner result: cannot guarantee target
suggested spacing: 6
status: requires_confirmation
```

Moxue should ask a bounded question such as:

> 這個間距可能留下可生怪的暗區。建議改成每 6 格；要調整，還是維持每 12 格？

No placement occurs until the confirmation policy allows it.

If the user accepts the risk explicitly, record that override in the directive provenance.

## 10. Large regions

Large regions, including areas spanning 12+ chunks, are valid.

Do not execute them as one giant unbounded mutation.

Split into deterministic batches, preferably by chunk or bounded cell windows:

```text
WorkspaceDirective
  -> plan
  -> chunk/cell batches
  -> checkpoint
  -> bounded placement/mutation
  -> verify
  -> next batch
```

This allows pause/resume, threat interruption and durable project integration.

## 11. Overlap

Regions may overlap.

Examples:

- a farm inside a protected base;
- a lighting zone covering several production/storage regions.

The repository must support containment/intersection queries.

Conflicting hard constraints fail closed or require explicit resolution.

## 12. Conversational resolution

Decision context should expose bounded summaries of:

- the current player's latest complete selection;
- nearby/named workspaces relevant to the instruction;
- active pending confirmation, if any.

Examples:

```text
Player selects a 9 x 1 x 9 area
Player: 墨雪，這裡是農田
-> define/update workspace from latest selection

Player: 把剛才那區每隔 5 格點亮
-> resolve latest workspace/selection
-> build LightingDirective(spacing=5)
-> deterministic preflight
```

The AI resolves reference and intent. Deterministic code owns geometry, risk calculation, placement plan and mutation.

## 13. No-X-ray / safety rules

- selection coordinates are user-provided observation, not hidden-world knowledge;
- selection does not authorize arbitrary mutation by itself;
- world mutation still requires purpose-specific SafetyPolicy permits;
- protected/player-built content constraints remain authoritative;
- raw Mineflayer Bot is never exposed to AI;
- unknown mod content does not become mutation-authoritative;
- all region execution is bounded/checkpointed.

## 14. Suggested module boundaries

```text
workspace/
  contracts.ts
  geometry.ts
  repository.ts
  sqlite-repository.ts
  selection-source.ts
  planner.ts

modules/
  workspace-module.ts

minecraft/
  moxuebridge-workspace-selections.ts
  lighting-runtime.ts            (later)
  workspace-placement-runtime.ts (later)
```

## 15. Phased implementation

### W0 — contracts and geometry

- bounds normalization;
- dimensions/volume/chunk coverage;
- intersection/containment;
- bounded schemas.

### W1 — durable workspace repository

- SQLite persistence;
- create/update/delete/query;
- world/dimension isolation;
- owner/provenance.

### W2 — selection observation adapter

- semantic selection source interface;
- MoxueBridge HTTP/event client contract;
- stale/unavailable fail-closed behavior;
- Paper-side plugin contract documented separately if plugin source is not in this repo.

### W3 — Paper/Bridge selection transport

- Paper setting-wand observation;
- authenticated read-only Bridge endpoint;
- MC_AI selection source lifecycle;
- live source probe.

### W4 — workspace lifecycle management

- active/archived status;
- create/update/archive/restore service;
- deterministic resolver;
- transactionally appended audit log;
- ordinary delete maps to archive;
- dependency-safe physical purge remains maintenance-only.

### W5 — chat/context binding

- expose latest trusted selection and authorized workspace summaries;
- resolve "這裡 / 剛才那區 / <workspace name>";
- bind natural-language management requests to deterministic lifecycle operations;
- do not execute build/light mutations merely because metadata changes.

### W6 — lighting planner

- requested spacing;
- chunk-batched placement plan;
- dark/spawnable-cell risk analysis;
- safer-spacing suggestion;
- `requires_confirmation` state.

### W7 — lighting execution

- typed lighting/placement runtime port;
- scoped `place_blocks` SafetyPolicy permit;
- torch inventory/supply dependency;
- bounded place/verify/checkpoint loop.

### W8 — project integration

- durable directives;
- pause/resume;
- integrate Production / Construction project DAG.

## 16. Acceptance examples

1. Select 5 x 10 x 10 -> “這裡是快速熔爐”
   - exact bounds persisted;
   - label/purpose retrievable after restart.

2. Select 9 x 1 x 9 -> “這裡是農田”
   - purpose = farm;
   - no per-farm special-case code required.

3. Select region spanning 12 chunks -> “點亮”
   - accepted selection;
   - plan split into bounded batches;
   - no giant one-shot mutation.

4. “每隔 5 格點亮”
   - spacing preserved when safety target can be met.

5. Unsafe requested spacing
   - no placement;
   - bounded confirmation prompt with recommended safer spacing.

6. Unknown custom purpose
   - stored as custom label/tags;
   - no invented mutation authority.
