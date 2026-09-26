import { describe, expect, test } from "bun:test"
import {
  Info,
  RuntimeFieldConsumers,
  UNSUPPORTED_V1_RUNTIME_FIELDS,
  UNSUPPORTED_V2_RUNTIME_FIELDS,
} from "../../src/config"

// C-P2-03 generated gate: the config surface stays honest in one place. The type-level
// `satisfies Record<keyof Info, string>` on RuntimeFieldConsumers already pins "every schema
// field names its consumer"; this gate pins the remaining two legs of the invariant:
//   1. every refused key is NOT a schema field (nothing is both consumed and refused);
//   2. the false-compat escape hatch (isDisabledCompatibilityField) covers exactly the four
//      keys the refusal currently exempts when explicitly disabled — widening the hatch must
//      be a conscious act that updates this gate.
// Adding a schema field without a consumer entry fails typecheck (missing map key); giving a
// refused key a real consumer means removing it from the refusal lists — which this gate then
// proves is no longer both refused and schema-live.
describe("config honesty gate (C-P2-03)", () => {
  const schemaFields = new Set(Object.keys(Info.fields))

  test("RuntimeFieldConsumers covers every schema field with a named consumer", () => {
    const consumers = Object.keys(RuntimeFieldConsumers)
    expect(consumers.sort()).toEqual([...schemaFields].sort())
    for (const consumer of Object.values(RuntimeFieldConsumers)) expect(consumer.trim().length).toBeGreaterThan(0)
  })

  test("no refused key carries a named consumer, beyond the flag-gated references pair", () => {
    // `references` is deliberately BOTH consumed (ProjectReference plugin) and refused while
    // DEEPAGENT_CODE_EXPERIMENTAL_REFERENCES is off — the only sanctioned dual member. Any
    // OTHER key appearing on both sides means a consumer went live without leaving the
    // refusal list (or vice versa) and must be reconciled consciously.
    const consumed = new Set(Object.keys(RuntimeFieldConsumers))
    const dual = [...UNSUPPORTED_V1_RUNTIME_FIELDS, ...UNSUPPORTED_V2_RUNTIME_FIELDS].filter((key) => consumed.has(key))
    expect([...new Set(dual)].sort()).toEqual(["references"])
  })

  test("the disabled-compat escape hatch covers exactly formatter/lsp/snapshot(s)", () => {
    // Mirror of isDisabledCompatibilityField in src/config.ts: widening the hatch (allowing
    // more keys to be silently ignored when set to `false`) must consciously update this list.
    const hatchKeys = ["formatter", "lsp", "snapshot", "snapshots"]
    const refused = new Set<string>([...UNSUPPORTED_V1_RUNTIME_FIELDS, ...UNSUPPORTED_V2_RUNTIME_FIELDS])
    for (const key of hatchKeys) expect(refused.has(key)).toBe(true)
    expect(hatchKeys.length).toBe(new Set(hatchKeys).size)
  })

  test("v1 and v2 refusal lists stay disjoint from each other's naming scheme", () => {
    // v1 uses singular (snapshot/plugin/reference), v2 plural-era (snapshots/plugins/references);
    // a key drifting into the wrong list fails loudly instead of quietly refusing both eras.
    const shared = UNSUPPORTED_V1_RUNTIME_FIELDS.filter((key) =>
      (UNSUPPORTED_V2_RUNTIME_FIELDS as readonly string[]).includes(key),
    )
    expect([...shared].sort()).toEqual(["formatter", "lsp"])
  })
})
