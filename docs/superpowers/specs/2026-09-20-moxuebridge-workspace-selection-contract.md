# MoxueBridge Workspace Selection Observation Contract

**Status:** Proposed contract for Paper-side implementation  
**Consumer:** MC_AI_Player `feature/workspace-planner`

## Purpose

Expose setting-wand selections as read-only semantic observations.

The bridge does not authorize block placement, breaking, commands, or project execution.

## Setting wand identity

Preferred user-facing item:

- material: `minecraft:stick`
- display name: `墨雪設定棍`

Preferred authoritative marker:

- persistent key: `moxue:workspace_wand`
- version/value: `v1`

Display name alone should not be the long-term authoritative identity when a persistent marker is available.

## Selection behavior

Paper observes trusted player block interaction.

A completed selection contains two block coordinates:

- point A
- point B

MC_AI_Player normalizes them into an inclusive cuboid.

The Paper implementation may use first/second click or left/right click UX, but the consumer contract is the same.

## Semantic snapshot

Transport endpoint/path is deliberately not fixed by this document yet.

The response body consumed by MC_AI_Player should map to:

```json
{
  "version": 1,
  "generatedAt": 1234567890,
  "selections": [
    {
      "id": "selection-id",
      "generation": 7,
      "worldKey": "server:survival",
      "dimension": "overworld",
      "playerId": "trusted-player-uuid",
      "playerName": "Boss",
      "pointA": { "x": 10, "y": 64, "z": 20 },
      "pointB": { "x": 18, "y": 64, "z": 28 },
      "selectedAt": 1234567800
    }
  ]
}
```

## Required rules

- max 256 selections per snapshot;
- one current selection per world + dimension + player identity;
- player UUID/id is authoritative; display name is descriptive;
- no raw ItemStack/NBT dump is needed by MC_AI_Player;
- no raw PlayerInteractEvent serialization;
- no arbitrary command text;
- coordinates are integer block coordinates;
- malformed or ambiguous snapshots fail closed;
- old selection snapshots must not overwrite a newer accepted selection;
- a source sync failure may retain last-known-good data internally, but MC_AI_Player must not expose it for new workspace actions while source state is stale.

## Security boundary

This API is observation-only.

Selection means:

> the trusted player indicated this geometric area.

It does not mean:

> any mutation inside this area is automatically authorized.

All later mutation still requires a specific deterministic skill/directive and SafetyPolicy permit.
