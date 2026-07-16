import { Schema } from "effect"

// V4.0.1 P1 (§3.3/§3.4) — the World State layer. Its ONE job is the responsibility separation the
// compaction summary can NOT do well: the summary records "思路 + 待办" (progress / decisions /
// constraints / next steps / data references), while World State records the VOLATILE structured facts
// (open files, git, diagnostics, environment) as their LATEST value — re-injected as a TAIL user block
// (never the byte-stable system prefix, per the cache-hit regression lesson). Because it is a
// snapshot-diff over the LATEST value (覆盖式, not accumulative), a stale summary line about a file's
// contents is always overwritten by the current World State value the model sees at the tail.
//
// snapshot-diff (§3.3): `upsertSlot` bumps a slot's `version` ONLY when the rendered value actually
// changes. That is what keeps `renderWorldState` byte-stable across ticks when nothing changed — the
// near-end tail stays cache-friendly, and only the one changed slot's segment moves when a value moves.

export const WorldStateSlotKind = Schema.Literals([
  "open_files", // key files' path + short summary (NOT full contents)
  "vcs", // git branch / dirty / recent commit
  "diagnostics", // most recent build/test/lint result summary
  "env", // platform, tool versions, other key environment facts
])
export type WorldStateSlotKind = Schema.Schema.Type<typeof WorldStateSlotKind>

export const WorldStateSlot = Schema.Struct({
  kind: WorldStateSlotKind,
  version: Schema.Int, // snapshot-diff: +1 ONLY when the rendered value changes
  updatedAt: Schema.Number,
  value: Schema.String, // the rendered latest value (覆盖式, only the latest is kept)
}).annotate({ identifier: "WorldStateSlot" })
export type WorldStateSlot = Schema.Schema.Type<typeof WorldStateSlot>

export const WorldState = Schema.Struct({
  projectId: Schema.String,
  slots: Schema.Array(WorldStateSlot),
}).annotate({ identifier: "WorldState" })
export type WorldState = Schema.Schema.Type<typeof WorldState>

// A FIXED render/storage order so the tail block is deterministic (byte-stable) regardless of the order
// slots were upserted in. Also the header label for each kind.
const KIND_ORDER: readonly WorldStateSlotKind[] = ["open_files", "vcs", "diagnostics", "env"]
const KIND_LABEL: Record<WorldStateSlotKind, string> = {
  open_files: "Open Files",
  vcs: "Version Control",
  diagnostics: "Diagnostics",
  env: "Environment",
}

const orderOf = (kind: WorldStateSlotKind): number => {
  const i = KIND_ORDER.indexOf(kind)
  return i < 0 ? KIND_ORDER.length : i
}

// Keep slots in KIND_ORDER so persistence + rendering are order-independent of upsert history.
const sortSlots = (slots: readonly WorldStateSlot[]): WorldStateSlot[] =>
  [...slots].sort((a, b) => orderOf(a.kind) - orderOf(b.kind))

export const emptyWorldState = (projectId: string): WorldState => ({ projectId, slots: [] })

// Overwrite-style update: replace the slot's value with the latest render, but bump `version` +
// `updatedAt` ONLY when the value differs from what is already stored (snapshot-diff, §3.3). An
// unchanged value returns a byte-identical slot (same version/updatedAt) so the rendered tail does not
// churn the prompt cache. A brand-new slot starts at version 1.
export const upsertSlot = (
  ws: WorldState,
  kind: WorldStateSlotKind,
  value: string,
  now: number = Date.now(),
): WorldState => {
  const existing = ws.slots.find((s) => s.kind === kind)
  if (existing && existing.value === value) return ws // no change ⇒ no version bump, byte-stable
  const nextSlot: WorldStateSlot = {
    kind,
    value,
    version: existing ? existing.version + 1 : 1,
    updatedAt: now,
  }
  const others = ws.slots.filter((s) => s.kind !== kind)
  return { projectId: ws.projectId, slots: sortSlots([...others, nextSlot]) }
}

// Merge a batch of freshly-collected slot values into the World State (each entry snapshot-diffed via
// upsertSlot). An omitted kind (undefined) or an empty string is a NON-collection this round — the
// prior slot value is preserved (a tick that could not cheaply recompute diagnostics keeps the last
// known diagnostics rather than blanking it). This is the pure merge; callers do the (bounded) IO to
// obtain the rendered values, keeping this module free of collectors.
export const collectSlots = (
  ws: WorldState,
  facts: Partial<Record<WorldStateSlotKind, string | undefined>>,
  now: number = Date.now(),
): WorldState => {
  let next = ws
  for (const kind of KIND_ORDER) {
    const value = facts[kind]
    if (value == null || value.trim().length === 0) continue // non-collection ⇒ keep prior slot
    next = upsertSlot(next, kind, value.trim(), now)
  }
  return next
}

// Render the World State as a TAIL user block fragment (never the static prefix). Deterministic slot
// order + no version/timestamp in the output ⇒ byte-stable when the slot VALUES are unchanged (so a
// multi-tick run with unchanged files keeps the near-end cache warm). Empty string when there is
// nothing to inject (⇒ the caller skips injection entirely).
export const renderWorldState = (ws: WorldState): string => {
  const present = sortSlots(ws.slots).filter((s) => s.value.trim().length > 0)
  if (present.length === 0) return ""
  const sections = present.map((s) => `## ${KIND_LABEL[s.kind]}\n${s.value.trim()}`)
  return [
    "<world-state>",
    "Current environment / file / diagnostics facts (latest values, re-injected — trust these over any",
    "older values mentioned in the summary above):",
    "",
    ...sections,
    "</world-state>",
  ].join("\n")
}
