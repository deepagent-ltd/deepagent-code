import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { EVENT_V2_ADMISSION_ENV, isEventV2AdmissionEnabled } from "../../src/deepagent/event-admission"
import { IM_SINGLE_WRITE_ENV, isEventV2ImSingleWriteEnabled } from "../../src/deepagent/im-single-write"
import { createRuntimeFeatureRegistry } from "../../src/flag/runtime-features"

// C7-05 contract: the V2 admission + IM single-write authorities ship ON through the PRODUCTION
// runtime entrypoint and in direct server/embedded compositions. `applyRuntimeDefaults()` makes the
// effective values observable in the process environment, while the gates themselves use the same
// default. `=false`/`=0` remains the explicit kill switch. The shared flag table is `core/deepagent/flip-flag`
// (`flipFlagValueOn`): for every DEFINED value both sides agree exactly (trim+lowercase;
// ""/"false"/"0" → OFF; any other → ON), including identical `undefined` behavior. The runtime
// double-write=0 proof lives in the flag-gated suites (event-v2-bridge
// emit counter 0 under ON, IM caller gate skip under ON).

const features = (env: Readonly<Record<string, string | undefined>>) =>
  createRuntimeFeatureRegistry(undefined, env)

describe("C7-05 flip contract (production-entry ON + explicit kill-switch)", () => {
  test("the switches are entrypoint-independent: unset and =true both select V2", () => {
    expect(isEventV2AdmissionEnabled(features({}))).toBe(true)
    expect(isEventV2AdmissionEnabled(features({ [EVENT_V2_ADMISSION_ENV]: "true" }))).toBe(true)
    expect(isEventV2AdmissionEnabled(features({ [EVENT_V2_ADMISSION_ENV]: "1" }))).toBe(true)
    expect(isEventV2ImSingleWriteEnabled(features({}))).toBe(true)
    expect(isEventV2ImSingleWriteEnabled(features({ [IM_SINGLE_WRITE_ENV]: "true" }))).toBe(true)
  })

  test("defined values follow the shared flip-flag table (W0.1 semantic convergence)", () => {
    // table: trim+lowercase; ""/"false"/"0" → OFF; any other defined value → ON (== runtime defaults)
    for (const value of ["", " 0 ", "FALSE"])
      expect(isEventV2AdmissionEnabled(features({ [EVENT_V2_ADMISSION_ENV]: value }))).toBe(false)
    for (const value of [" true", "yes", "2", "off", "no"])
      expect(isEventV2AdmissionEnabled(features({ [EVENT_V2_ADMISSION_ENV]: value }))).toBe(true)
    // W0.5 (audit 9): only /^(false|0)$/ (plus "") are OFF by the table — "off"/"no" are NOT off
    // values and must stay ON; do not "fix" them into OFF.
    for (const value of ["", "false "])
      expect(isEventV2ImSingleWriteEnabled(features({ [IM_SINGLE_WRITE_ENV]: value }))).toBe(false)
    for (const value of ["yes", "off", "no"])
      expect(isEventV2ImSingleWriteEnabled(features({ [IM_SINGLE_WRITE_ENV]: value }))).toBe(true)
  })

  test("kill-switch =false / =0 restores the legacy authority", () => {
    expect(isEventV2AdmissionEnabled(features({ [EVENT_V2_ADMISSION_ENV]: "false" }))).toBe(false)
    expect(isEventV2AdmissionEnabled(features({ [EVENT_V2_ADMISSION_ENV]: "0" }))).toBe(false)
    expect(isEventV2ImSingleWriteEnabled(features({ [IM_SINGLE_WRITE_ENV]: "false" }))).toBe(false)
    expect(isEventV2ImSingleWriteEnabled(features({ [IM_SINGLE_WRITE_ENV]: "0" }))).toBe(false)
  })

  test("the production entrypoints enable both authorities via runtime-defaults", () => {
    const entry = readFileSync(
      fileURLToPath(new URL("../../../deepagent-code/src/index.ts", import.meta.url)),
      "utf8",
    )
    const node = readFileSync(
      fileURLToPath(new URL("../../../deepagent-code/src/node.ts", import.meta.url)),
      "utf8",
    )
    const defaults = readFileSync(
      fileURLToPath(new URL("../../../deepagent-code/src/runtime-defaults.ts", import.meta.url)),
      "utf8",
    )
    // W0.1: both production entrypoints apply the single runtime-defaults source. The former
    // DEEPAGENT_CODE_V4_EVENT_DRIVEN_IM pairing default is gone with the V2 IM durable-only
    // migration: @mentions are admitted synchronously as durable SessionV2 work by the IM
    // handler (no bus-mediated IM path to pair with), and the v4EventDrivenIm flag itself is
    // deleted — @mention work can no longer be silently dropped via a missing pairing.
    expect(entry).toContain("applyRuntimeDefaults(")
    expect(node).toContain("applyRuntimeDefaults(")
    // both authorities' env constants are covered by the default-ON runtime defaults
    expect(defaults).toContain('= "DEEPAGENT_CODE_EVENT_V2_ADMISSION"')
    expect(defaults).toContain('= "DEEPAGENT_CODE_EVENT_V2_IM_SINGLE_WRITE"')
  })

  test("the two switches are independent", () => {
    const snapshot = features({ [EVENT_V2_ADMISSION_ENV]: "false", [IM_SINGLE_WRITE_ENV]: "true" })
    expect(isEventV2AdmissionEnabled(snapshot)).toBe(false)
    expect(isEventV2ImSingleWriteEnabled(snapshot)).toBe(true)
  })
})
