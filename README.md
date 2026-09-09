# MC_AI_Player

Standalone Minecraft Java cooperative-player runtime for Moxue experiments.

## Project boundary

- `MC_AI_Player` owns Minecraft connectivity, deterministic gameplay, safety, Minecraft-specific memory, telemetry, and AI decision-provider adapters.
- `neko0115/DC_BOT` is read-only until the standalone integration gate passes.
- Normal gameplay is headless: no Minecraft Launcher, rendered Java client, OCR, or screenshot loop is required on the runtime host.
- AI will make high-level decisions only. Deterministic runtime code will execute gameplay.

## Phase 0 runtime baseline

Candidate versions locked for the bootstrap compatibility probe:

- Node.js: `24.x` LTS (`>=24 <25`)
- TypeScript: `7.0.2`
- tsx: `4.23.13`
- Zod: `4.5.4`
- Mineflayer: `4.39.0`
- mineflayer-pathfinder: `2.4.5`

The exact dependency graph is frozen by `package-lock.json` after the cross-platform lockfile check.

## Supported validation targets

- Windows x64: primary development and interactive E2E target.
- Linux x64: CI/release validation target.
- Linux ARM64: required release validation target.
- Raspberry Pi 3 Model B / 1 GB: constrained minimum-hardware experiment target; validation occurs later and does not require Minecraft GUI rendering.

## Bootstrap commands

```bash
npm ci
npm run probe
npm test
npm run typecheck
```

`npm run probe` loads Mineflayer and mineflayer-pathfinder without starting a Minecraft connection and reports the host runtime information.

## Current implementation scope

Phase 0 Task 1 contains only the toolchain/platform probe. It intentionally does not connect to Minecraft, issue movement, invoke an AI provider, or touch DC_BOT.

Architecture and implementation plans live under `docs/superpowers/`.
