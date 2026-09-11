# Raspberry Pi / Linux ARM64 Deployment and Profiling Guide

## Scope

This document defines the Task 16 deployment and measurement procedure for headless Linux ARM64 hosts, with Raspberry Pi 3 Model B as the constrained minimum-hardware experiment target.

It is an execution procedure, not evidence that the hardware gate has already passed. Record real measurements from the target device; do not copy example values into release evidence.

## Hardware and OS baseline

Target experiment platform:

```text
Raspberry Pi 3 Model B
Raspberry Pi OS 64-bit / ARM64 userspace
RAM: 1 GB
headless runtime; no Minecraft GUI or Launcher required
```

Use a stable power supply for release measurements. For Pi 3B, 5 V / >=2.5 A is the minimum experiment baseline; 5 V / 3 A is preferred when available.

Before accepting benchmark evidence, check throttling/undervoltage:

```bash
vcgencmd get_throttled
```

For a clean benchmark, capture `0x0` before and after the run. If the board reports active or historical undervoltage/throttling, mark the benchmark invalid and repeat with power integrity fixed.

## Verify Node 24 ARM64

```bash
node --version
node -p "process.arch"
node -p "process.platform"
```

Required for this v1 line:

```text
Node major: 24
architecture: arm64
platform: linux
```

Then verify the locked runtime:

```bash
npm ci
npm run probe
npm test
npm run typecheck
```

Do not silently change Mineflayer, pathfinder, SQLite, or Node versions to make an ARM64 failure disappear. Treat incompatibility as evidence to review.

## Runtime environment

Keep deployment secrets outside the repository. One example location is:

```text
/etc/mc-ai-player/env
```

Restrict it to the service account/root as appropriate, for example:

```bash
sudo chmod 600 /etc/mc-ai-player/env
```

Required Minecraft settings:

```text
MC_HOST=...
MC_PORT=25565
MC_USERNAME=...
MC_AUTH=microsoft
```

Keep the Control API on loopback unless remote access is explicitly required:

```text
MC_CONTROL_HOST=127.0.0.1
MC_CONTROL_PORT=8766
```

If `MC_CONTROL_HOST` is changed to a non-loopback interface, `MC_CONTROL_TOKEN` is mandatory. Never place a real token or Minecraft credential in this document or Git.

The safe AI baseline remains:

```text
MC_AI_PROVIDER=fake
```

Do not switch production gameplay to Gemini until the separate real-provider compatibility gate passes.

## systemd outline

Create a dedicated unprivileged service user and adapt paths to the actual install location.

```ini
[Unit]
Description=MC AI Player
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mc-ai-player
WorkingDirectory=/opt/mc-ai-player
EnvironmentFile=/etc/mc-ai-player/env
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

After installing the unit:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mc-ai-player
sudo systemctl status mc-ai-player
```

Logs:

```bash
journalctl -u mc-ai-player -f
journalctl -u mc-ai-player --since "1 hour ago"
```

## Resource telemetry harness

`scripts/soak.ts` samples process RSS, heap use, and event-loop lag. Runtime-specific metrics are supplied through `ResourceTelemetryProbe` callbacks:

```text
pathfinder planning duration
active goal age
event queue depth
memory row count
AI decision latency
```

If a runtime metric is not connected, the sample records `null` and lists it in `missingMetrics`. An incomplete sample must not be presented as full deployment evidence.

The standalone CLI can be used as a process-level smoke check:

```bash
MC_SOAK_DURATION_MS=60000 MC_SOAK_INTERVAL_MS=5000 npx tsx scripts/soak.ts > soak-smoke.json
```

Because the standalone CLI has no live application probe attached, runtime-specific metrics remain missing and `evidenceComplete` is expected to be `false`. Release soak evidence requires the harness to be connected to the running runtime's measured probe data.

## Hardware baseline procedure

Run the same controlled scenarios on the intended mini PC and Pi/ARM64 target:

```text
connected idle
follow player
32-block navigation
64-block navigation
bounded resource search
gather resource
return/home-equivalent route
inventory or chest operation
remote AI decision request (only after provider gate)
SQLite memory read/write
reconnect
sustained cooperative session
```

For each scenario record p50 / p95 / max where meaningful:

```text
RSS / heap
event-loop lag
path planning duration
AI decision latency
reconnect time
```

Also record:

```text
CPU utilization
path replan count
GC pauses when observable
network latency
swap activity
vcgencmd get_throttled before/after
memory growth per hour
```

Do not invent target-host measurements from CI x64 results.

## Soak gate

The release soak is 4–8 hours. Capture at minimum:

```text
start RSS
end RSS
max RSS
max heap used
event-loop lag p50/p95/max
goals succeeded/failed/cancelled
reconnect count
stuck count
AI rejected decision count
reasoning leakage count
uncaught exception count
memory row growth
```

Pass criteria are evidence-based:

- no sustained memory growth after warm-up;
- no event-loop starvation that causes gameplay timeouts;
- pathfinder remains within its configured search/time budgets;
- reasoning leakage count remains zero;
- uncaught exception count remains zero;
- CPU/RSS results are recorded for both intended hardware classes.

## Chaos gate

`scripts/chaos.ts` defines these required injections:

```text
server_disconnect
server_restart
pathfinder_stuck
target_disappears
inventory_full
bot_dies
ai_timeout
ai_invalid_mixed_reasoning
memory_repository_unavailable
sse_client_disconnect_storm
```

Every injection must converge before its timeout to one of the defined safe states:

```text
recovered
failed_safe
disconnected
stopped
```

A hanging case, reasoning leakage, or uncaught exception fails the chaos gate.

## Rollback

Before deployment, record the known-good Git commit and back up the Minecraft memory database if it contains valuable world knowledge.

Example procedure:

```bash
git rev-parse HEAD
cp data/mc_memory.sqlite3 data/mc_memory.sqlite3.backup
```

Rollback should use an explicitly reviewed known-good commit/tag, then reinstall exactly from its lockfile:

```bash
git checkout <known-good-commit-or-tag>
npm ci
npm test
npm run typecheck
sudo systemctl restart mc-ai-player
```

Do not roll back by copying old `node_modules` directories between architectures.

## Evidence record

For each real hardware run retain:

```text
Git commit SHA
OS version / kernel
Node version
process.arch
hardware model / RAM
power supply used
vcgencmd get_throttled before/after
scenario start/end timestamps
soak/telemetry JSON
relevant journal excerpt
PASS / FAIL / BLOCKED decision with reason
```

Until those records exist, Linux ARM64, Pi 3B, mini-PC, and 4–8 hour soak remain **PENDING**, regardless of x64 CI status.
