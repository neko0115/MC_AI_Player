# Decision Contract v1

`DecisionV1` is the only AI-produced object that may enter the gameplay decision gate.

## Security boundary

The runtime never extracts commands or JSON from model free text. A provider response is valid only when the provider adapter presents one final structured object through a schema/function-call channel that is separate from hidden/intermediate reasoning.

These forms are invalid as whole responses:

```text
<think>collect wood</think>{"version":1,"intent":"gather_resource",...}
I should collect wood. {"version":1,"intent":"gather_resource",...}
{"version":1,"intent":"gather_resource",...} done
{"version":1,...}{"version":1,...}
```

Do not strip `<think>` tags, regex-search JSON, substring-search commands, or otherwise infer a final decision from mixed text.

## Envelope

Every accepted object has exactly these top-level fields:

```json
{
  "version": 1,
  "intent": "gather_resource",
  "args": {
    "resource": "oak_log",
    "quantity": 32
  }
}
```

All objects use strict schemas. Unknown fields, including `reason`, `reasoning`, `analysis`, `thought`, `instruction`, `command`, and raw player-facing chat text, are rejected.

## AI intent allowlist

- `follow_player`
- `stay`
- `go_to`
- `return_home`
- `eat`
- `equip`
- `gather_resource`
- `deposit_item`
- `withdraw_item`

The deterministic runtime may contain additional internal skills such as `stop` and `find_resource`; their existence does not automatically make them AI-selectable intents.

## Argument bounds

### follow_player

```json
{"player":"Boss","range":3}
```

`player` is required. Optional `range` is 1..16 blocks.

### stay / return_home / eat

```json
{}
```

No extra arguments are accepted.

### go_to

```json
{"x":10,"y":64,"z":-5,"radius":2}
```

Coordinates must be finite numbers. Optional radius is 0..16.

### equip

```json
{"item":"iron_pickaxe","destination":"hand"}
```

`destination` is optional and, when present, must be one of `hand`, `off-hand`, `head`, `torso`, `legs`, or `feet`.

### gather_resource

```json
{"resource":"oak_log","quantity":32}
```

Quantity is an integer from 1 through 2304. This is a contract bound, not permission to mutate arbitrary blocks; SafetyPolicy and the gathering skill still determine which blocks may be touched.

### deposit_item / withdraw_item

```json
{"item":"oak_log","quantity":32,"storage":"base_wood_chest"}
```

The storage field is a semantic storage identifier. It is not shell text, JavaScript, a Minecraft command, or a raw protocol instruction.

## Translation to goals

After schema validation, DecisionGate maps the accepted intent/args to the corresponding `GoalRequest`. SafetyPolicy must authorize the request before GoalManager receives it.

```text
provider structured final
  -> DecisionV1Schema
  -> intent-to-goal mapping
  -> SafetyPolicy
  -> GoalManager
```

Any validation or authorization failure starts no new AI goal.
