# MC_AI_Player

Headless Minecraft Java cooperative-agent runtime for the Moxue project.

`MC_AI_Player` runs without the Minecraft Launcher or a rendered game client. Mineflayer performs deterministic gameplay behind structured goal, safety, memory, quota, routing, and telemetry boundaries. The repository is still pre-release: automated behavior and production wiring are separated from release gates that still need live evidence.

## What it does today

- observes players, chat, health, inventory, identity evidence, and bounded self-position changes;
- executes allowlisted navigation, follow, survival, inventory, and scoped gather skills;
- stores world-scoped SQLite memory and emits validated runtime telemetry;
- exposes a Control API and SSE stream for deterministic external orchestration;
- optionally consumes authenticated read-only server capabilities from MoxueBridge;
- runs a production mailbox-style AI Decision Coordinator for addressed Minecraft instructions;
- routes routine work to Gemini Flash-Lite and complex work to Gemini Flash through a quota-aware Project pool;
- persists Gemini quota/accounting state separately from Minecraft memory;
- supports one-shot trusted manual deep-think and a separate loopback-only Admin API;
- includes deterministic replay, regression, routing E2E, live-server, soak-contract, and chaos-harness tests.

## Safety model

- model output is parsed into strict structured `DecisionOutcomeV2` values before gameplay execution;
- raw model text and hidden reasoning have no direct actuator path;
- AI chooses only allowlisted high-level actions; deterministic code performs Minecraft movement and mutation;
- every action is checked against registered production skills, latest world state, and `SafetyPolicy` before Goal submission;
- navigation defaults to `canDig=false`, and block mutation is limited to scoped gather flows;
- PvP is disabled by policy;
- provider safety/content blocking is terminal and is never bypassed by changing model or Google Project;
- automatic routing cannot consume the reserved 30% Flash budget;
- non-loopback Control API binding requires bearer-token authentication;
- the AI Admin API is hard-bound to IPv4 loopback and uses a dedicated token.

## Development status

The routing implementation and real Gemini compatibility gate are complete on the feature branch, but this repository is not yet a completed v1 release. Anything under **Gates that are still pending** remains explicitly unvalidated until separate evidence exists.

The design and implementation-plan documents are architecture/execution records. Historical wording or unchecked task boxes are not the authoritative source of runtime completion state; use this README together with concrete CI/live-validation evidence.

## Architecture / project boundary

- `MC_AI_Player` owns Minecraft connectivity, deterministic gameplay, safety, Minecraft-specific memory, Gemini routing/quota accounting, telemetry, Control/Admin APIs, and replay fixtures.
- MoxueBridge is an optional read-only capability-discovery boundary; it describes server/plugin semantics but does not become a gameplay actuator.
- The Discord-side Moxue runtime is outside this repository; DC_BOT integration remains a separate trust-boundary project.
- Normal gameplay is headless: no Minecraft Launcher, rendered Java client, OCR, screenshot loop, or GUI is required on the runtime host.
- AI task state and manual grants are intentionally volatile; quota/accounting state is durable.
- Raw API keys remain environment-only. Routing config stores only environment-variable names and anonymous Project identities.

## Runtime baseline

Exact versions are locked in `package-lock.json`:

- Node.js: `24.x` LTS (`>=24 <25`)
- TypeScript: `7.0.2`
- tsx: `4.23.13`
- Zod: `4.5.4`
- Mineflayer: `4.39.0`
- mineflayer-pathfinder: `2.4.5`
- better-sqlite3: `12.11.1`
- `@google/genai`: `2.21.0`

## Quick validation

```bash
npm ci
npm run probe
npm test
npm run typecheck
```

`npm run probe` loads Mineflayer and mineflayer-pathfinder without opening a Minecraft connection and reports host runtime information.

## Runtime configuration

Minecraft connection settings are explicit:

```text
MC_HOST
MC_PORT
MC_USERNAME
MC_AUTH=offline|microsoft
MC_VERSION              optional
MC_LOG_LEVEL            optional
MC_SERVER_IDENTITY_MODE=offline|online
```

`MC_SERVER_IDENTITY_MODE` is a separate trust anchor from the bot login method. Missing or invalid values fail closed to `offline`; usernames alone never grant privileged Minecraft AI controls.

The safe AI default is:

```text
MC_AI_PROVIDER=fake
```

Fake mode requires no Gemini routing file, Google credential, Admin token, or production quota DB.


### MoxueBridge capability discovery

MoxueBridge integration is optional and disabled when `MC_MOXUEBRIDGE_BASE_URL` is empty:

```text
MC_MOXUEBRIDGE_BASE_URL=http://127.0.0.1:8766
MC_MOXUEBRIDGE_TOKEN=<secret>
MC_MOXUEBRIDGE_TIMEOUT_MS=800
MC_MOXUEBRIDGE_REFRESH_INTERVAL_MS=30000
```

MC_AI_Player reads only `GET /api/v1/capabilities` with bearer authentication. Valid available capabilities are cached with bounded schema/response-size checks. A later network failure retains the last-known-good snapshot for diagnostics and marks it `stale`; startup without any successful snapshot reports `unavailable`.

Only `current` capability snapshots may enter AI decision context or influence deterministic multi-block execution. Stale snapshots remain visible only through sanitized status diagnostics until a fresh Bridge response succeeds again. Only stable capability semantics are included in AI decision context; plugin name/version/provenance are intentionally omitted.

Deterministic gathering may use capability hints such as correct-tool preparation and sneak-while-breaking, but `SafetyPolicy` and scoped `ResourceMutationPermit` remain authoritative. Multi-block acceleration fails closed unless the capability advertises both a finite `max_chain` that fits inside the remaining gather quantity and `same_block_only=true`. This prevents a mixed VeinMiner group from turning a single-resource goal into collateral block destruction.

For the current same-host integration layout, avoid the historical port collision by using:

```text
MoxueBridge HTTP       8766
MC_AI_Player Admin     8767
MC_AI_Player Control   8768   (set MC_CONTROL_PORT=8768)
```

### Gemini multi-model mode

Gemini mode uses a private routing file rather than `MC_AI_MODEL` / `MC_AI_API_KEY`:

```text
MC_AI_PROVIDER=gemini
MC_AI_ROUTING_CONFIG=data/ai-routing.json
MC_AI_KEY_PRIMARY=<secret>
MC_AI_KEY_BACKUP=<secret>   optional if referenced by the routing file
```

`MC_AI_MODEL` and `MC_AI_API_KEY` are deprecated and ignored as routing authority.

Copy `config/ai-routing.example.json` to a private gitignored deployment file and replace the illustrative quota limits with the active limits for the relevant Google AI Studio Projects. Each configured `apiKeyEnv` must exist in the process environment or Gemini startup fails closed.

Current routing roles are:

```text
routine  -> gemini-3.5-flash-lite / low
complex  -> gemini-3.8-flash      / medium
high     -> gemini-3.8-flash      / high
```

High thinking is restricted to trusted manual deep-think, repeated replanning, or trusted deterministic critical context. Complexity scoring never grants reserve access by itself.

Flash admission is per configured Google Project:

```text
0% .. 70%   normal automatic/manual budget
70% .. 100% reserve, privileged manual deep-think only
```

A reserve-authorized request still scans every Project's normal region before any reserve region.

Quota/accounting state lives in:

```text
data/ai-quota.sqlite3
```

It is separate from Minecraft memory. Reservations are durably committed before HTTP dispatch; actual Gemini usage settles the reservation when available, and ambiguous crash/network cases are conservatively accounted.

## Real Gemini compatibility validator

The real provider gate is explicit opt-in. With the flag unset or `0`, the command performs no Google call.

PowerShell:

```powershell
$env:MC_AI_PROVIDER='gemini'
$env:MC_AI_LIVE_VALIDATION='1'
$env:MC_AI_ROUTING_CONFIG='data/ai-routing.json'
$env:MC_AI_KEY_PRIMARY='<secret>'
# Set every additional key referenced by data/ai-routing.json.
npm run validate:gemini-live
```

The validator performs three structured provider-compatibility decisions without executing Minecraft gameplay:

- routine route: configured routine model with `low` thinking;
- complex route: configured complex model with `medium` thinking;
- trusted local-admin deep route: configured complex model with `high` thinking and reserve authorization.

It requires a valid `DecisionOutcomeV2`, observes anonymous `model_route` telemetry, forbids actual reserve consumption during validation, and requires each successful provider call to settle in `data/ai-quota.sqlite3` with `usage_quality='actual'`. Output contains only anonymous Project labels, model/thinking, PASS/FAIL, and token counts.

### Captured real-provider evidence

On 2026-09-12, the full opt-in gate passed against real Google Gemini projects on code HEAD `2d4e5746e2c20fd75e57eb4a264cffaae38deec2` immediately before this documentation update:

```text
routine     gemini-3.5-flash-lite / low    primary  PASS  input=723 output=20 thought=0   tool=0 total=743
complex     gemini-3.8-flash      / medium primary  PASS  input=728 output=31 thought=273 tool=0 total=1032
admin_deep  gemini-3.8-flash      / high   backup-1 PASS  input=734 output=31 thought=759 tool=0 total=1524
```

All three cases returned structured `DecisionOutcomeV2` output and actual usage settlement. The admin-deep route was reserve-authorized but completed in normal capacity; the validator rejects any run that actually consumes reserve. No raw API key, prompt, real Google Project ID, UUID allowlist, provider body, or thought text is included in the evidence.

## Control API

The Control API defaults to loopback. Binding to a non-loopback interface requires a bearer token at startup.

```text
MC_CONTROL_HOST=127.0.0.1
MC_CONTROL_PORT=8766
MC_CONTROL_TOKEN=        required for non-loopback bind
MC_CONTROL_MAX_BODY_BYTES=16384
```

Surface:

```text
GET  /health
GET  /v1/status
POST /v1/goals
POST /v1/stop
GET  /v1/memory/search
GET  /v1/events          SSE
```

`POST /v1/goals` is deterministic direct control and does not invoke Gemini. Long-running goals return an accepted `goal_id`; HTTP requests do not remain open for gameplay completion. SSE carries validated `RuntimeEvent` objects only.

When MoxueBridge discovery is enabled, `/v1/status` also adds `server_capabilities` with only a sanitized `sync_state` (`current`, `stale`, or `unavailable`) and bounded semantic capability IDs. It does not expose Bridge credentials, plugin identity/version, or raw integration errors.

When Gemini mode is active, `/v1/status` adds only coarse AI state: routine/complex model names, availability, anonymous active Project label, automatic Flash usage percentage, manual-deep availability, active task/goal kind, pending task count, and in-flight state. It does not expose prompts, UUID allowlists, raw errors, API keys, or internal Project identities.

## AI Admin API

The Admin API is disabled unless a dedicated token is configured:

```text
MC_ADMIN_PORT=8767
MC_ADMIN_TOKEN=<secret>
```

It always binds `127.0.0.1`; there is no configuration for LAN exposure.

Surface:

```text
GET  /v1/admin/ai-quota
POST /v1/admin/ai-routing/reload
POST /v1/admin/ai/deep-think
```

Admin deep-think requires an `Idempotency-Key`. The Admin API may authorize high/reserve routing, but it cannot select a raw API key or bypass `SafetyPolicy`.

## Minecraft manual deep-think

On `MC_SERVER_IDENTITY_MODE=online`, a current-session UUID matching `manualAccess.ownerUuid` or `operatorAllowlistUuids` may use the explicit commands:

```text
!moxue deep <instruction>
!moxue deep current [directive]
```

Offline-mode Minecraft identities can still submit ordinary addressed instructions and complexity hints, but they cannot gain reserve authority from chat.

## Current automated validation coverage

The automated suite covers, among other areas:

- strict decision / goal / event contracts and reasoning isolation;
- deterministic complexity scoring and immutable RoutePlans;
- online/offline UUID trust and one-shot ManualRouteGrant behavior;
- quota reservations, actual settlement, LA provider-day accounting, crash recovery, 70/30 normal/reserve admission, credential health, and cooldowns;
- ordered Project failover and primary recovery;
- one-attempt Gemini transport with SDK retries disabled;
- 401/403/429/5xx/content-block/generation-error routing taxonomy;
- bounded RoutedDecisionExecutor retries/failover;
- mailbox Decision Coordinator single-flight, stale-response protection, multi-step continuation, causal replan coalescing, repeated-replan high thinking, task queueing, reconnect recovery, and direct-control takeover;
- loopback Admin authentication, quota/status sanitization, routing reload, idempotent deep-think, and bounded cache behavior;
- production composition-root ownership for Gemini routing, quota DB, Admin lifecycle, and safe Control API AI status;
- cross-layer Gemini routing E2E with fake transport: Lite/low, Flash/medium, high replanning, privileged reserve, failover, terminal content block, and latest-state recovery;
- opt-in live-validator contract coverage for routine/complex/admin-deep routes, actual-usage settlement, and secret-safe reporting without making a real API call in normal CI;
- replay-backed cooperative acceptance and zero raw-text reasoning actuator reachability;
- soak telemetry contracts and chaos-harness convergence behavior.

The cooperative acceptance fixture is `fixtures/replay/cooperative-session.jsonl`. Its deterministic scenario lives in `tests/scenarios/cooperative-session.test.ts`; the routed Gemini E2E scenario lives in `tests/scenarios/gemini-routing-coordinator.test.ts`.

Deployment and real-hardware measurement procedure is documented under `docs/operations/`. Missing runtime probes must remain explicit rather than being replaced with invented measurements.

## Gates that are still pending

Do not treat the following as validated yet:

- **30-minute private-server cooperative session:** still requires a real Minecraft server and human multiplayer validation.
- **Production wiring for `return_home`, `deposit_item`, and `withdraw_item`:** the underlying schemas/skills exist, but the current production composition root does not yet register the complete storage/home workflow. This remains a release blocker.
- **Real deployment evidence:** Linux ARM64 runtime measurements, Raspberry Pi 3B benchmark, intended mini-PC benchmark, runtime-probe evidence, and the required 4–8 hour soak have not yet been captured.
- **DC_BOT integration:** separate authenticated integration/trust-boundary work remains pending and is not part of this routing implementation.

For the 30-minute private-server gate, required evidence remains:

```text
uncommanded block destruction: 0
PVP attempts: 0
raw-text decisions executed: 0
reasoning leakage: 0
stuck loops > retry budget: 0
emergency stop failures: 0
goal lifecycle inconsistencies: 0
```

For real deployment evidence, retain the Git SHA, hardware/OS/Node details, power/throttling state, measured p50/p95/max values where applicable, soak summary, and PASS/FAIL/BLOCKED decision. Do not copy CI x64 values into ARM64/Pi evidence.

## Supported validation targets

- Windows x64: primary development and interactive E2E target.
- Linux x64: CI/release validation target.
- Linux ARM64: required release validation target.
- Raspberry Pi 3 Model B / 1 GB: constrained minimum-hardware experiment target; validation occurs separately and does not require Minecraft GUI rendering.

## Operations / design references

- Architecture spec: `docs/superpowers/specs/2026-09-12-gemini-multi-model-routing-design.md`
- Implementation plan: `docs/superpowers/plans/2026-09-12-gemini-multi-model-routing.md`
- Routing example: `config/ai-routing.example.json`
- Deployment/validation procedures: `docs/operations/`

## License

MIT — see [`LICENSE`](LICENSE).
