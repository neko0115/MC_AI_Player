# MC_AI_Player Gemini Multi-Model Routing Design Specification

**Date:** 2026-09-12  
**Repository:** `neko0115/MC_AI_Player`  
**Base:** `main` at `4afc0fbc2b39205659f5439e363c4a338fe22e2c`  
**Status:** Architecture approved; written specification pending user review  
**Scope boundary:** This document specifies MC_AI_Player only. DC_BOT integration remains a later, separate trust-boundary change.

> Process gate: implementation must not begin from this document alone. After the user reviews and approves this written specification, the next step is a separate `writing-plans` pass followed by RED -> GREEN TDD on this feature branch and a pull request into protected `main`.

## 1. Goal

Replace the current single-model Gemini decision path with a deterministic, quota-aware multi-model routing subsystem that:

- uses `gemini-3.5-flash-lite` with low thinking for routine decisions;
- uses `gemini-3.8-flash` with medium thinking for ordinary complex decisions;
- uses `gemini-3.8-flash` with high thinking only for trusted manual deep-think, repeated replanning, or trusted deterministic critical context;
- supports an ordered pool of independent Google Projects and credentials;
- preserves a 70% automatic / 30% emergency-reserve Flash budget per Project;
- persists quota/accounting state across restarts without sharing the Minecraft memory database;
- introduces a production event-driven decision coordinator without turning runtime events into LLM-per-event calls;
- keeps SafetyPolicy authoritative over all model, routing, reserve, and operator choices;
- fails closed when quota, identity, configuration, or authorization information is insufficient.

The architecture must remain compatible with the existing principle that AI chooses bounded high-level actions while deterministic code owns movement, gathering, inventory mutation, cancellation, and safety.

## 2. Non-goals

V1 does not implement:

- concurrent autonomous AI tasks;
- speculative parallel Gemini calls;
- model-controlled escalation, Project selection, quota policy, or reserve access;
- Minecraft-chat passwords or secret commands;
- trust of usernames on offline-mode servers;
- Bungee/Velocity forwarded-identity or other trusted-proxy topologies;
- persistent replay of AI tasks, manual deep-think grants, or in-flight decisions after process restart;
- server-side Gemini conversation state;
- arbitrary hot-reloadable complexity weights;
- LAN exposure of the Admin API;
- DC_BOT remote-admin authentication or integration transport;
- storing model reasoning text or thinking summaries.

## 3. Architectural layers and authority

The system is divided into four responsibility layers:

```text
Minecraft/Admin/runtime input
          |
          v
Decision Coordinator            WHEN is a new AI decision needed?
          |
          v
Identity + Complexity Policy    WHO may request what quality?
          |
          v
Model Router + Project Pool     WHERE may this decision run?
+ Quota Ledger
          |
          v
Routed Decision Executor        HOW is the Gemini attempt executed,
+ Gemini Transport              retried, failed over, and accounted?
          |
          v
Outcome Gate -> SafetyPolicy -> GoalManager -> SkillExecutor
```

Authority is intentionally one-way:

- the Coordinator may request a logical decision but may not choose a Google Project;
- complexity policy may select Flash/high but may not grant reserve access;
- identity/capability may authorize reserve use but may not bypass SafetyPolicy;
- the Project Pool may choose a credential but may not modify task meaning or prompt content;
- Gemini may propose an action but may not execute gameplay directly;
- SafetyPolicy has final veto authority.

## 4. Model roles and deterministic complexity policy

### 4.1 Model roles

| Route class | Model | Thinking |
| --- | --- | --- |
| routine | `gemini-3.5-flash-lite` | `low` |
| complex | `gemini-3.8-flash` | `medium` |
| high override | `gemini-3.8-flash` | `high` |

A complex task may route directly to Flash. The runtime must not spend a Lite request merely to ask Lite whether escalation is necessary.

### 4.2 `balanced-v1`

The first routing policy is versioned program behavior named `balanced-v1`. Its weights are not deployment-configurable in V1.

The deterministic score is the sum of unique bounded signals:

| Signal | Score |
| --- | ---: |
| `multi_step` | 3 |
| `multi_skill` | 2 |
| `open_ended_method` | 4 |
| `cross_context_reasoning` | 2 |
| `goal_failed` | 2 |
| `stuck` | 2 |
| `manual_complexity_hint` | 2 |
| `risk_context` | 3 |

Routing threshold:

```text
score < 4  -> routine / Lite / low
score >= 4 -> complex / Flash / medium
```

The score decides Lite versus Flash only. A high numerical score does not automatically select high thinking.

### 4.3 High-thinking overrides

High thinking is selected only for:

1. a valid trusted ManualRouteGrant;
2. `consecutive_replan_count >= 2`;
3. a trusted deterministic `critical_context` signal.

Automatic Flash-high still has no reserve capability.

### 4.4 Signal restrictions

The following are not complexity signals by themselves:

- prompt length;
- repeated punctuation or repeated phrases such as “think harder”;
- number of inventory entries;
- memory database size;
- number of nearby players;
- a model request to escalate itself.

`cross_context_reasoning` requires deterministic evidence that the task actually depends on multiple state domains; merely including memory, inventory, world state, and player state in DecisionContext is not enough.

A same-goal causal chain such as `stuck -> skill_failed -> goal_failed` must not count the same failure multiple times. `skill_failed` is evidence; authoritative replanning begins at a real `goal_failed` boundary.

## 5. Project Pool and quota domains

### 5.1 Ordered pool

The routing configuration contains an arbitrary-length ordered Project pool. Selection is primary-first and health-aware, not round-robin. If the primary becomes healthy and admissible again, later attempts return to it.

Every Project has a stable anonymous `projectKey`, such as `pool-a`. Ordered roles such as `primary` and `backup-1` are transient positions, not accounting identities.

### 5.2 Identity domains

Credential-health domain:

```text
projectKey
```

Quota domain:

```text
projectKey + model
```

A 401/403 disables that Project credential for the current process, affecting both Lite and Flash. A Flash quota failure does not imply that Lite quota for the same Project is exhausted.

### 5.3 Credential references

Routing configuration stores only environment-variable names such as `apiKeyEnv`. Raw API keys are resolved by a credential registry at runtime and remain inside the credential/transport boundary.

Raw keys must never appear in:

- routing telemetry;
- AttemptLease serialization;
- `ai-quota.sqlite3`;
- `/v1/status`;
- `/v1/admin/ai-quota`;
- runtime event logs.

## 6. Flash normal and emergency-reserve budgets

Each Project's Flash budget is divided into:

```text
0-70%   normal automatic/manual region
70-100% emergency reserve
```

This is an MC_AI_Player admission policy, not a claim that Google exposes separate physical quota buckets.

Automatic complex routing scans only the normal region across the ordered Project pool. Once all Projects' normal regions are inadmissible, automatic escalation stops.

Trusted manual deep-think first scans every Project's normal region. Only after all normal regions are inadmissible may it scan reserve capacity.

An attempt is admitted wholly as either:

```text
budget_class = normal
```

or:

```text
budget_class = reserve
```

Tokens from one attempt are never split retroactively between the two classes.

`reserve_authorized` and `reserve_used` are distinct. `reserve_used` is true exactly when `budget_class == reserve`.

## 7. Provider limits and internal budget limits

Deployment configuration distinguishes provider-reported limits from operator policy:

- provider limits: RPM, input TPM, RPD, and any other active AI Studio limits required by the configured model;
- Flash budget limits: daily request budget and daily total-token budget used for the 70/30 admission policy.

Provider limits must be injected from the deployment's active AI Studio limits. The runtime must not hard-code or infer production quota values.

If an admission-critical limit is missing, the affected route fails closed rather than pretending that quota remains.

RPD and V1 daily Flash budgets use an `America/Los_Angeles` provider-day key. Rolling RPM and TPM use the previous 60 seconds.

Google-provider TPM admission is based on input tokens. The internal Flash total-token budget uses total tokens, including thought/output/tool-use tokens when reported.

## 8. Lite exhaustion

Flash is not a general backup battery for routine Lite traffic.

A routine decision tries the same Lite model through the ordered Project pool. If all Lite domains are unavailable, the routine decision becomes unavailable and waits/degrades safely.

A task already classified as complex may still use Flash according to the Flash policy even when all Lite Projects are unavailable.

## 9. Identity and capability model

Authentication determines a principal; the principal determines capabilities; capabilities authorize a route request but never bypass SafetyPolicy, quota, health, or availability checks.

Principals:

| Principal | Meaning |
| --- | --- |
| `system_router` | deterministic automatic routing |
| `minecraft_untrusted` | offline mode, missing/invalid UUID, or non-allowlisted player |
| `minecraft_operator` | trusted online-session UUID in operator allowlist |
| `minecraft_owner` | trusted online-session UUID equal to configured owner UUID |
| `local_admin` | authenticated loopback Admin API |

Capabilities of interest:

- `manual_deep_think`;
- `flash_reserve_access`;
- `admin_ai_config` / detailed quota access.

Minecraft owner/operator may receive the first two. Only local admin receives the Admin API capability.

## 10. Minecraft identity trust

### 10.1 Startup trust anchor

A startup-only environment setting defines the server identity trust model:

```text
MC_SERVER_IDENTITY_MODE=online|offline
```

Missing or invalid configuration is treated as `offline`/untrusted. The runtime must not infer server online-mode from the bot's own `MC_AUTH` value.

### 10.2 Online mode

`online` means the operator asserts that the connected Minecraft server authenticates player identity. MC_AI_Player trusts the current session's player UUID evidence supplied by that authenticated server; it does not attempt to prove live possession merely by querying a public username/UUID profile API.

UUID allowlist comparison uses normalized lowercase 32-hex UUID representation. Missing, malformed, or unavailable UUID evidence fails closed to `minecraft_untrusted`; username is never a privileged fallback credential.

### 10.3 Session scope

Trusted player identity is volatile and scoped to the current Minecraft connection/session. The identity registry is cleared on reconnect, application restart, player departure, or identity mismatch.

Privileged chat handling should use UUID evidence associated with the current chat/session when available rather than treating an old username-to-UUID observation as permanent authorization.

### 10.4 Offline mode

In `offline` mode all Minecraft-chat principals remain `minecraft_untrusted`, even if a username or UUID-looking value matches the owner/allowlist configuration.

Natural language such as “think harder” or “use the big model” may add `manual_complexity_hint` but can never authorize reserve use.

## 11. Manual Deep Think

### 11.1 New-task command

Canonical privileged Minecraft command:

```text
!moxue deep <instruction>
```

For a trusted principal it creates a new AI task with:

```text
minimum model class = complex
thinking = high
reserve_authorized = true
```

The command is not a password; knowing its syntax does not grant capability.

### 11.2 Current-task command

Canonical current-task form:

```text
!moxue deep current
!moxue deep current <ephemeral directive>
```

It grants high thinking/reserve authorization to the active AI task's next safe-boundary decision only. If there is no active AI task, the request fails with `no_active_ai_task`; it must never arm an unspecified future task.

An optional directive affects only that next decision and does not rewrite the persistent AiTask objective.

### 11.3 ManualRouteGrant

Manual authorization is represented by a one-shot volatile grant bound to a specific request/task generation, never by a process-global `deepThink=true` flag.

A grant is `pending`, then either `consumed` or `invalidated`. It is invalidated by relevant Minecraft session loss, allowlist/policy reload, task supersession/completion, application shutdown, or other loss of its authorization context.

Grants are never persisted or replayed after restart.

## 12. Admin API trust boundary

Admin operations use a separate HTTP listener that is physically loopback-only and also requires a dedicated `MC_ADMIN_TOKEN`. The V1 admin host is not LAN-configurable. The admin port is deployment configuration.

The ordinary Control API may remain LAN-bound under its existing `MC_CONTROL_TOKEN`, but possession of that token never grants Admin API capability.

If `MC_ADMIN_TOKEN` is absent, the Admin listener is disabled without preventing ordinary MC_AI_Player startup.

Admin endpoints:

```text
GET  /v1/admin/ai-quota
POST /v1/admin/ai-routing/reload
POST /v1/admin/ai/deep-think
```

The local-admin deep-think endpoint creates a privileged deep-think task but does not permit callers to choose a raw API key, Project, or budget class.

DC_BOT integration must later receive a separate authenticated integration principal; this design does not expose the Admin listener to a remote DC_BOT host.

## 13. Routing configuration and atomic reload

The existing provider switch remains authoritative at the top level:

```text
MC_AI_PROVIDER=fake|gemini
```

For `fake`, no real Gemini routing file or Google credential is required; the fake path remains the deterministic CI/test seam and must not accidentally consume production quota state unless a quota-ledger test wires that behavior explicitly.

For `gemini`, a valid multi-model routing configuration and all referenced credential environment variables required by the active Project pool are mandatory. Missing or invalid routing configuration fails Gemini startup closed rather than falling back to the legacy single-model path.

Public repository configuration contains only:

```text
config/ai-routing.example.json
```

Deployment configuration lives at:

```text
data/ai-routing.json
```

and is gitignored. `MC_AI_ROUTING_CONFIG` may override the path.

The private routing configuration owns:

- routine and complex model names;
- ordered Projects and stable `projectKey` values;
- `apiKeyEnv` references;
- provider quota limits;
- Flash request/token budgets and conservative admission allowances;
- owner UUID and operator UUID allowlist.

The routing configuration never stores raw API keys.

Reload flow:

```text
read candidate
-> parse
-> complete schema validation
-> quota/budget sanity checks
-> authorization-policy validation
-> allocate new config generation
-> atomic swap
```

A failed reload leaves the previous configuration fully active. A successful authorization-policy reload invalidates pending Minecraft privileged grants.

When `MC_AI_PROVIDER=gemini`, legacy `MC_AI_MODEL` and `MC_AI_API_KEY` values are tolerated for deployment migration but ignored as routing authority. They must never override or fill gaps in the validated multi-model routing configuration. The public environment example should mark them deprecated once the new path is implemented.

## 14. Config generation and reload races

`ai-quota.sqlite3` stores a globally monotonic config generation counter. Every successful startup activation and hot reload allocates a new generation; process restart does not reset the counter to 1.

Each dispatched attempt permanently records the concrete generation, `projectKey`, model, thinking level, and budget class used for that attempt.

An in-flight attempt settles against its own recorded generation/project/model even if a later reload removes or reorders that Project. A subsequent retry/failover attempt may use the new active generation while remaining part of the same immutable logical RoutePlan.

## 15. Runtime event admission and coalescing

Runtime events never directly invoke Gemini. They first pass through a deterministic Trigger Classifier.

State-only observations such as position, player sightings, inventory, health, connection state, memory writes, and cooperative pickup update world/context state only.

For one goal causal chain, `stuck`, `skill_failed`, and `goal_failed` are coalesced into at most one replan demand. The first two are evidence; `goal_failed` is the authoritative replan boundary.

Provider retry/failover errors are not new decision triggers. A provider timeout or 429 remains part of the current logical decision.

Different explicit player/admin instructions are never merged merely because they arrived inside a debounce interval. Correctness is causal, not timer-based.

## 16. Cancellation semantics in runtime events

The runtime event contract must distinguish true failures from normal cancellation:

```text
goal_completed
goal_failed
goal_cancelled

skill_completed
skill_failed
skill_cancelled
```

Player preemption, task supersession, operator stop, and other normal cancellation paths do not increment replanning counters or trigger automatic escalation.

## 17. AiTask and DecisionContext

An AI-directed instruction creates a volatile `AiTask` that owns at least:

- `task_id`;
- original objective;
- source/principal metadata needed by the coordinator;
- task generation/state;
- active goal ID when present;
- base complexity evidence;
- consecutive and total replan counts;
- an applicable one-shot ManualRouteGrant when present.

The objective becomes an explicit bounded DecisionContext field. Multi-step continuation must not reconstruct the original task by guessing from recent chat events.

AiTask, pending task queue, DecisionDemand, and ManualRouteGrant are volatile. Process restart does not restore or replay them.

## 18. Decision outcome contract

The production coordinator uses a new structured outcome contract with three possibilities:

```text
action
complete
blocked
```

`action` contains one allowlisted gameplay intent plus validated arguments. `complete` terminates the AiTask without creating a Goal. `blocked` terminates the task with a bounded reason such as `no_safe_action`, `missing_information`, or `capability_unavailable`.

The existing action-only DecisionV1 contract must not remain the authoritative production coordinator output after this migration; otherwise multi-step tasks have no explicit terminal result.

Model output still travels through the reasoning-isolation boundary: exactly one structured function/schema result, no reasoning text in arguments, no free-text command parsing.

## 19. Production skill availability

DecisionContext advertises only skills that are actually registered and production-ready. Schema presence alone does not make a capability available.

Before Goal submission, an action is checked against:

1. current production skill availability;
2. latest WorldState;
3. SafetyPolicy.

This is required while `return_home`, `deposit_item`, and `withdraw_item` remain release gates.

## 20. Decision Coordinator

### 20.1 Mailbox/actor semantics

The production coordinator is a serialized mailbox/actor. RuntimeEvent listeners enqueue bounded messages and return; they never await a Gemini network request inside `RuntimeEventBus.publish()`.

Gemini completion returns to the coordinator as a mailbox message. This allows stop/takeover/session-invalidating events to invalidate an in-flight decision before a late provider response can create a goal.

### 20.2 Orthogonal state dimensions

The coordinator tracks orthogonal dimensions rather than one combinatorial enum:

- coordinator: `running | stopped`;
- AI task: `none | active | suspended`;
- execution: `idle | decision_pending | decision_in_flight | goal_running`;
- AI availability: `available | unavailable`;
- Minecraft: `ready | unavailable`.

`stopped` is reserved for application shutdown.

### 20.3 `/v1/stop`

`POST /v1/stop` is an operator reset, not a permanent coordinator stop. It cancels the current deterministic goal, clears active/pending AI tasks, invalidates pending grants/in-flight decision generation, and returns the coordinator to `running + idle` so new work can be accepted.

## 21. Task concurrency, queue, and takeover

V1 permits:

```text
<= 1 active AiTask
<= 1 AI decision in flight
<= 1 deterministic SkillExecutor action
```

Up to eight additional explicit AI tasks may wait in a FIFO queue. When the queue is full, the newest request is rejected with `task_queue_full`; a rejected manual-deep request does not create a ManualRouteGrant.

A newly addressed instruction does not normally interrupt a bounded running deterministic skill. Continuous goals such as `follow_player` and `stay` may be safely superseded at their AbortSignal boundary by a newer explicit task; that supersession is cancellation, not failure.

Direct Control API goals remain deterministic and authoritative. A direct-control takeover supersedes the active autonomous AiTask and invalidates any in-flight AI result for that task, while pending queued AI tasks remain queued. `/v1/stop` is the explicit mechanism to clear the entire AI queue.

## 22. Stale decision protection

Every logical AI decision is bound to at least:

- `decision_id`;
- `task_id`;
- task generation;
- Minecraft session generation when relevant.

Hard invalidators include task supersession, direct-control takeover, stop/emergency stop, application shutdown, and loss of session-sensitive manual authorization.

Ordinary world-state changes do not automatically stale an in-flight decision; otherwise movement/inventory events would continuously invalidate valid work. However, before action submission the runtime rechecks skill availability and SafetyPolicy against the latest WorldState.

## 23. Multi-step continuation and replanning

A successful Goal does not imply task completion. For an active multi-step AiTask:

```text
Goal succeeds
-> continuation DecisionDemand
-> fresh latest context
-> action | complete | blocked
```

A true `goal_failed` increments both `consecutive_replan_count` and `total_replan_count`. A successful action resets the consecutive count only. Normal cancel/supersede does not increment either count.

The third planning cycle after two consecutive failed plans uses Flash-high through the repeated-replanning high override, but still has no reserve authorization unless a trusted manual grant also exists.

## 24. AI unavailable and recovery semantics

An already-started deterministic skill continues to its safe completion boundary if AI later becomes unavailable.

While AI is unavailable, runtime events continue to update latest state/evidence and coalesce unresolved decision demand, but no new provider decision is created.

If the routed subsystem can compute a future recovery time, the coordinator schedules one recovery wake-up. On recovery it creates one fresh logical decision from current state; it does not replay old prompts or one decision per accumulated event.

If every credential is disabled for the current process and there is no timed recovery, `retry_at` is null and the coordinator does not poll. Recovery then requires an explicit configuration/availability change or process restart.

On Minecraft disconnect, ordinary active AiTask state is suspended and in-flight AI work becomes stale. After reconnect/spawn, an unresolved ordinary task may make one fresh decision from current state. Session-bound ManualRouteGrant authorization is invalidated and is not silently downgraded.

## 25. RoutePlan

For every logical decision, deterministic routing produces one immutable RoutePlan containing:

- `decision_id`;
- model class (`routine | complex`);
- thinking level (`low | medium | high`);
- `reserve_authorized`;
- deterministic reason set;
- high-override reason when present.

RoutePlan does not contain a concrete Project, API key, reservation, or budget class.

Provider retries/failover for the same logical decision do not rerun complexity scoring or alter RoutePlan semantics.

## 26. Just-in-time AttemptLease

Immediately before each actual Gemini API attempt, the Project Pool and Quota Ledger evaluate the current active configuration, Project health, cooldowns, rolling provider limits, normal/reserve budget capacity, and conservative token estimate.

A successful admission returns one AttemptLease containing at least:

- `attempt_id` and `decision_id`;
- config generation;
- stable `projectKey`;
- concrete model and thinking level;
- `budget_class` (`normal | reserve`);
- reservation ID;
- opaque credential handle.

A fixed A->B->C attempt sequence is never precomputed. After a failure, the next lease is selected from the state that exists at that time. Attempts for one logical decision are sequential; speculative parallel calls are forbidden.

## 27. RoutedDecisionExecutor versus Coordinator

Retry, provider backoff, Project failover, quota-domain cooldown, and AttemptLease acquisition are entirely inside `RoutedDecisionExecutor`.

The Coordinator submits one logical decision and eventually receives one normalized LogicalDecisionResult. It does not implement 429/503/backoff logic or know which Google Project was used.

Cancellation flows through an AbortSignal to the routed executor and transport. Local cancellation terminates the logical decision without Project-health penalty. An abort after dispatch is not assumed to have zero provider usage.

## 28. Gemini transport contract

Gemini transport is stateless with respect to gameplay conversations. Every request uses bounded fresh DecisionContext and keeps provider-side storage disabled.

Prompt/task payload and infrastructure routing are separate inputs. Selecting a different Project may change credential/model execution parameters but must not change task meaning, tool schema, Safety constraints, or objective.

Thinking summaries/reasoning text remain disabled and are never persisted. Thought-token counts may be recorded from provider usage for accounting.

SDK-level automatic retry must be explicitly disabled so one AttemptLease corresponds to one actual API attempt. All retry authority belongs to RoutedDecisionExecutor.

## 29. Provider result and error taxonomy

Gemini transport normalizes facts; RoutedDecisionExecutor applies policy.

| Normalized result | Policy |
| --- | --- |
| 401 authentication | disable Project credential for current process; fail over |
| 403 permission denied | disable Project credential for current process; fail over |
| 429 `quota_exceeded` | mark `projectKey + model` quota unavailable; fail over |
| 429 rate/burst/too-many-requests | transient model-domain cooldown; fail over or wait |
| unknown 429 | conservative transient cooldown |
| timeout / HTTP 408 / transient network | transient cooldown |
| 409 aborted | transient when provider semantics identify abort |
| 500/502/503/504 | transient cooldown |
| 400 invalid request/parameter | configuration/provider-client error; stop logical execution |
| 404 model not found | model/configuration error; stop logical execution |
| explicit `content_blocked` | safety terminal; never fail over to bypass |
| malformed/invalid structured generation | one clean generation-repair retry maximum |
| local AbortSignal | cancelled; no retry and no Project-health penalty |

Explicit safety/content classification takes precedence over generic HTTP-family classification.

Provider safety rejection is never converted into a model or Project failover strategy.

### 29.1 Backoff

Transient failure counter is maintained per `projectKey + model`:

```text
5s -> 15s -> 30s -> 60s
```

One successful attempt resets that domain's transient counter. A trustworthy provider `Retry-After` extends the effective cooldown when it is longer than the local backoff.

A healthy alternate Project may be used immediately rather than waiting for a primary cooldown.

### 29.2 Generation repair

A malformed structured result may receive at most one clean retry for the logical decision. The retry does not raise thinking, change model class, grant reserve, or rewrite the task to coax a different answer. A second invalid structured result returns `invalid_response` and blocks the task.

### 29.3 Attempt bound

Actual API attempts for one logical decision are bounded by:

```text
configured_project_count + 4
```

Projects skipped during local admission do not count because no API request was sent.

## 30. LogicalDecisionResult

RoutedDecisionExecutor exposes only these coordinator-facing categories:

```text
success
safety_blocked
unavailable
invalid_response
configuration_error
cancelled
```

`unavailable` may include `retry_at`. If no timed recovery is possible, `retry_at = null`.

Coordinator logic must not depend on raw provider HTTP status or Google error text.

## 31. Quota database

Quota/accounting data lives only in:

```text
data/ai-quota.sqlite3
```

It is independent from `data/mc_memory.sqlite3`.

V1 needs three logical data groups/tables:

1. `quota_attempts` — reservation, dispatch, actual/conservative usage, and result settlement;
2. `quota_domain_state` — cooldown, transient counter, quota-unavailable/reset data, and last safe error metadata;
3. `quota_meta` — schema version and monotonic config-generation state.

Credential process-health state may be a small dedicated table or a clearly separated portion of domain state, but it must include `process_instance_id` so a previous process's 401/403 disable is not treated as a permanent ban.

The database never stores prompts, objectives, chat text, API keys, real Google Project IDs, model reasoning, or raw provider error bodies.

## 32. Durable attempt lifecycle

Every actual network attempt has one durable lifecycle:

```text
reserved -> dispatched -> settled
reserved -> released
dispatched -> uncertain    # crash recovery terminal state
```

Quota admission and reservation creation occur in one SQLite transaction that reads current accounted usage plus active reservations, validates all relevant provider/internal limits, and inserts the reservation atomically.

Durability ordering is mandatory:

```text
1. reservation durable
2. dispatched state durable
3. send Gemini HTTP request
4. receive/normalize result
5. settlement durable
```

The system intentionally prefers conservative under-use over quota oversell.

## 33. Crash recovery

At startup:

- a leftover `reserved` attempt is safe to release because the transport send was ordered after durable `dispatched`;
- a leftover `dispatched` attempt is changed to `uncertain` and receives conservative quota accounting because the provider may have processed it;
- settled and released rows remain historical truth.

No AI task/decision is replayed merely because an uncertain provider attempt exists.

## 34. Reservation and actual usage settlement

Admission reserves conservative input and total-token bounds before dispatch. The estimate covers system instruction, serialized DecisionContext/input, function/tool schema, and configured generation/thinking allowance.

The normal path does not perform an extra provider `countTokens` network request for every decision.

When Gemini returns usage, actual values replace the temporary reservation for accounting. Reservation and actual values are never added together.

At minimum the ledger retains provider-reported input, output, thought, tool-use, and total token counts when available.

### 34.1 Missing usage

For a dispatched request with no provider usage:

- known pre-inference/client rejection classes such as 400/401/403/404/429 conservatively account one request plus reserved input tokens as total token charge;
- ambiguous execution classes such as timeout, network loss, 5xx, local abort after dispatch, crash, safety block without usage, or malformed final response without usage conservatively account one request plus the full reserved input and total-token bounds.

This conservative accounting is persisted with a usage-quality classification.

### 34.2 Overrun

If actual usage exceeds the conservative reservation, actual usage is authoritative. A normal attempt that accidentally crosses the 70% boundary remains `budget_class=normal`, records `budget_overrun=true`, and stops further automatic Flash admission for that domain until reset. The overrun is never relabeled as intentional reserve use.

## 35. Rolling and daily accounting

Every dispatched attempt counts as one local request for admission/accounting purposes.

Rolling RPM and input TPM are calculated from durable attempt timestamps in the previous 60 seconds; no periodic reset job is required.

Each dispatch stores an `America/Los_Angeles` provider-day key. RPD and daily Flash request/token budgets query that day key rather than relying on a midnight timer, preserving correct behavior across restart and DST changes.

## 36. AI availability derivation

The Project Pool/Quota Ledger derives availability and the earliest recoverable time from all configured domains.

Examples:

- a short TPM cooldown returns its end time;
- a daily quota exhaustion returns its provider-day reset time;
- a mix returns the earliest actually admissible future time;
- all credentials disabled for the process returns no timed recovery.

This derived `retry_at` is the only timer input needed by the Coordinator's AI-recovery behavior.

## 37. Safety invariants

The following are hard requirements:

- SafetyPolicy rejection is not a provider-failover signal.
- Provider `content_blocked` is terminal for the logical decision.
- High thinking gives no additional gameplay permission.
- Reserve authorization gives no additional gameplay permission.
- Automatic routing can never consume reserve.
- Offline Minecraft chat can never authorize reserve.
- Changing Project/model cannot be used to retry around a safety rejection.

## 38. Telemetry and status surfaces

Telemetry may record safe metadata such as:

```text
complexity_assessment
model_route
attempt_result
task_started
task_completed
task_blocked
task_superseded
ai_availability_changed
```

A model route records model, thinking, anonymous Project role/key as appropriate, deterministic reasons, and separate `reserve_authorized` / `reserve_used` flags.

It must not record prompts, full chat/objective text, API keys, owner/operator UUIDs, real Google Project IDs, raw provider bodies, or thought text.

### 38.1 `/v1/status`

The ordinary status surface exposes only low-sensitivity summaries, including routine/complex model names, coarse AI availability/quota state, active anonymous Project, coordinator/task state, active goal kind, queue depth, and whether a decision is in flight.

### 38.2 `/v1/admin/ai-quota`

Authenticated loopback admin may inspect detailed anonymous Project/model quota, cooldown, health, RPM/TPM/RPD, normal/reserve percentage, and last safe error category. It still never exposes secrets, real Google Project IDs, UUID allowlists, prompts, or raw error bodies.

## 39. Required configuration behavior

Implementation must preserve the following configuration rules:

- `MC_AI_PROVIDER=fake|gemini` remains the provider switch;
- `fake` requires no real Gemini routing config and remains suitable for deterministic CI;
- `gemini` requires a complete validated routing file plus referenced Project credentials and fails startup closed if they are missing or invalid;
- Gemini routing uses `MC_AI_ROUTING_CONFIG` or `data/ai-routing.json`;
- the public repository commits only `config/ai-routing.example.json`;
- the real routing file is gitignored;
- API keys are environment variables referenced by `apiKeyEnv`;
- legacy `MC_AI_MODEL` and `MC_AI_API_KEY` are non-authoritative and ignored by the multi-model Gemini path;
- `MC_SERVER_IDENTITY_MODE` is startup-only and defaults/fails closed to offline trust;
- `MC_ADMIN_TOKEN` controls whether the loopback Admin listener exists;
- quota numbers are supplied from active deployment limits/operator policy and are never guessed;
- configuration reload validates the entire candidate before atomic activation.

## 40. Test requirements

Implementation is RED -> GREEN TDD. At minimum, tests cover:

### Configuration

- provider-mode split: fake succeeds without production routing credentials; Gemini fails closed without a valid routing file/credentials;
- legacy single-model env values cannot override or fill gaps in Gemini routing;
- schema validation and fail-closed missing quota;
- stable `projectKey` behavior across reorder;
- atomic reload and monotonically increasing generation;
- old-generation in-flight settlement after reload.

### Identity and authorization

- online versus offline server identity mode;
- UUID normalization and username non-authority;
- owner/operator allowlist;
- reconnect/player-leave/reload grant invalidation;
- `!moxue deep` and `!moxue deep current` targeting;
- Admin listener loopback/token separation.

### Complexity

- every `balanced-v1` signal and threshold boundary;
- duplicate signal suppression;
- repeated replanning high override;
- offline manual hint cannot authorize reserve;
- provider/model output cannot self-escalate.

### Coordinator

- runtime event coalescing;
- failure versus cancellation semantics;
- mailbox non-blocking behavior;
- one active task / one in-flight decision;
- bounded FIFO queue and queue-full rejection;
- bounded versus continuous-goal supersession;
- direct Control API takeover and stale-result rejection;
- multi-step action -> action -> complete;
- AI unavailable/recovery single fresh decision;
- disconnect suspend/reconnect behavior;
- no task replay after process restart.

### Routing and errors

- Lite Project failover without Flash substitution;
- primary-first health-aware selection;
- 70/30 normal/reserve ordering across Projects;
- automatic high still cannot use reserve;
- 401/403 credential disable;
- quota versus transient 429;
- 5xx/timeout/network backoff and alternate-Project failover;
- content-block terminal behavior;
- one generation-repair retry;
- SDK retries disabled;
- total API-attempt bound.

### Ledger and crash consistency

- atomic admission/reservation;
- reservation replacement by actual usage;
- RPM/input-TPM rolling windows;
- Los Angeles provider-day RPD/reset behavior including DST boundary tests;
- reserved crash release;
- dispatched crash -> uncertain conservative charge;
- missing-usage conservative settlement;
- normal-budget overrun handling;
- process-lifetime credential health versus persistent history.

### Security and observability

- no raw key/prompt/UUID/real Project ID in database, status, or telemetry;
- Control token cannot access Admin operations;
- safety rejection cannot cause Project/model failover.

### Integration/live validation

- deterministic fake transport for CI;
- real Gemini Interactions call validating structured outcome and actual usage accounting;
- Windows and Linux CI remain required;
- Linux ARM64 native + SQLite validation remains required.

## 41. Release gates

This architecture does not waive existing release gates. Before the resulting system is considered production-ready, evidence must still cover:

- real Gemini live validation;
- the production event-driven coordinator;
- a 30-minute complete human multiplayer cooperation session;
- Pi/mini-PC resource measurements;
- a 4-8 hour soak;
- production wiring and validation for `return_home`, `deposit_item`, and `withdraw_item`;
- later DC_BOT integration through a separately designed trust boundary.

## 42. Acceptance invariants

The implementation is conformant only if all of the following are true:

1. A logical decision is not counted as multiple replans because of provider retries.
2. Automatic routing can never consume the 30% Flash reserve.
3. Offline Minecraft identity can never obtain privileged reserve access.
4. A successful config reload cannot corrupt accounting for already-dispatched attempts.
5. A process crash cannot create quota oversell by treating a possibly-sent request as unused.
6. A process restart cannot replay an old AiTask or ManualRouteGrant.
7. Provider/model safety blocking cannot be bypassed by failover.
8. Multi-step tasks have an explicit terminal `complete`/`blocked` outcome rather than looping on action-only decisions.
9. AI outage does not abort an already-running deterministic skill solely because the model is unavailable.
10. AI recovery produces at most one fresh decision for unresolved work, using latest world state.
11. Production action submission always rechecks currently registered capability and SafetyPolicy.
12. Public/admin observability never leaks credentials, prompts, privileged UUIDs, or real Google Project identity.
