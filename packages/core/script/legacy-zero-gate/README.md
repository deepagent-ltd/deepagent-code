# C0-08 legacy-zero inventory gate

A static, script+test-only gate over the C0-01 frozen production caller inventory
(`packages/core/script/caller-inventory/build.ts buildInventory`). It counts the
authority dimensions where the production composition still delegates to legacy, and
never hides a number.

## Counters

- **legacy dims** — `(entry, dimension)` roles still classified as a legacy owner/writer.
- **double-write** — roles that write the same authority onto both the legacy and the V2 channel.
- **legacy-only adapters** — adapter roles that carry execution/producer/writer authority.
- **v2 dims / read-only / unclassified** — informational totals, reported but not zero-targets.
- **selection-bridge usages** — runtime `v2-none` graph-revision fallbacks committed by the V2
  selection bridge (the legacy bridge that copies selection evidence into a V2 turn).

## Modes

```text
bun run script/legacy-zero-gate/run-gate.ts counts          # real numbers, never hidden
bun run script/legacy-zero-gate/run-gate.ts oracle          # counts + byte-stable snapshot
bun run script/legacy-zero-gate/run-gate.ts must-be-zero    # exit 1 while any target > 0
```

| mode | function | behaviour |
|---|---|---|
| counts | `currentTreeCounts()` | returns the real counters (never hides). |
| mustBeZero | `mustBeZero()` | throws `LegacyZeroError` naming every violating entry+dimension and
| | | every selection-bridge site while any zero-target is non-zero; returns the snapshot digest
| | | when the tree is clean (legacy=0, double-write=0, adapter=0, selection-bridge=0). |
| oracle | `redOracle()` | prints the counts and returns the byte-stable snapshot. |

## Current state (red oracle on base 27287aed9 (freeze successor))

| counter | value |
|---|---|
| legacy dims | 903 |
| double-write | 1 (`event.v2-bridge :: event_producer_consumer`) |
| legacy-only adapters | 3 (`event.legacy-canonicalizer-daemon`, `provider.aisdk-stream-bridge`, `recovery.provider-owner-runtime`) |
| v2 dims | 25 |
| read-only dims | 1721 |
| unclassified dims | 0 |
| selection-bridge usages | 4 (`packages/core/src/session/runner/canonical-turn.ts:37`) |

`mustBeZero()` is therefore **RED** on the current tree — that is the honest oracle. Green
arrives only when the migration closures below remove every legacy-authority leak. The snapshot
digest is byte-stable over the stable identity (base commit + counters + violations + bridge
sites), independent of host-local state.

## Green condition (green comes with C1B / C2-C5)

- **C3-05 / C3-08** — every V2 provider attempt binds a real four-graph selection/validation;
  `v2-none` is no longer a legal selection value and the selection bridge is removed (selection
  bridge usages → 0).
- **C1B-01** — `SessionProviderRecovery` is the single provider writer; legacy is only a
  read-only adapter (legacy-only adapter authority → 0).
- **C5-09 / C5-12** — IM/event standard entry switches to a single V2 admission and removes the
  legacy double-write (double-write → 0).
- **C1A-11 / C0-01** — the inventory's `legacy` owner/writer dims are reclassified to their V2
  authority as the legacy entry paths are removed (legacy dims → 0).

## Discipline

The gate is never imported by production `src` (zero overhead when unused). Its tests verify the
counter implementation against both a small fixture inventory and the real `buildInventory()`
output, and assert the actual frozen numbers (903 / 0 / 26 / 3) read from the C0-01 report —
never a guessed value.
