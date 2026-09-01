import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { EVENT_V2_ADMISSION_ENV, isEventV2AdmissionEnabled } from "../../src/deepagent/event-admission"
import { IM_SINGLE_WRITE_ENV, isEventV2ImSingleWriteEnabled } from "../../src/deepagent/im-single-write"

// C7-05 contract: the V2 admission + IM single-write authorities ship ON through the PRODUCTION
// runtime entrypoint (packages/deepagent-code/src/index.ts applies the shared runtime defaults —
// `applyRuntimeDefaults()` — which sets both envs for the process); the switches themselves stay
// explicit-env so isolated test/daemon contexts keep their own behavior, and `=false`/`=0`
// restores the legacy authorities. The shared flag table is `core/deepagent/flip-flag`
// (`flipFlagValueOn`): for every DEFINED value both sides agree exactly (trim+lowercase;
// ""/"false"/"0" → OFF; any other → ON); only `undefined` differs by context (entry: ON,
// gate: OFF). The runtime double-write=0 proof lives in the flag-gated suites (event-v2-bridge
// emit counter 0 under ON, IM caller gate skip under ON).

const withEnv = (name: string, value: string | undefined, fn: () => void) => {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    fn()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

describe("C7-05 flip contract (production-entry ON + explicit kill-switch)", () => {
  test("the switches are explicit-env: unset ⇒ legacy (OFF), =true ⇒ V2 (ON)", () => {
    withEnv(EVENT_V2_ADMISSION_ENV, undefined, () => expect(isEventV2AdmissionEnabled()).toBe(false))
    withEnv(EVENT_V2_ADMISSION_ENV, "true", () => expect(isEventV2AdmissionEnabled()).toBe(true))
    withEnv(EVENT_V2_ADMISSION_ENV, "1", () => expect(isEventV2AdmissionEnabled()).toBe(true))
    withEnv(IM_SINGLE_WRITE_ENV, undefined, () => expect(isEventV2ImSingleWriteEnabled()).toBe(false))
    withEnv(IM_SINGLE_WRITE_ENV, "true", () => expect(isEventV2ImSingleWriteEnabled()).toBe(true))
  })

  test("defined values follow the shared flip-flag table (W0.1 semantic convergence)", () => {
    // table: trim+lowercase; ""/"false"/"0" → OFF; any other defined value → ON (== runtime defaults)
    withEnv(EVENT_V2_ADMISSION_ENV, "", () => expect(isEventV2AdmissionEnabled()).toBe(false))
    withEnv(EVENT_V2_ADMISSION_ENV, " 0 ", () => expect(isEventV2AdmissionEnabled()).toBe(false))
    withEnv(EVENT_V2_ADMISSION_ENV, "FALSE", () => expect(isEventV2AdmissionEnabled()).toBe(false))
    withEnv(EVENT_V2_ADMISSION_ENV, " true", () => expect(isEventV2AdmissionEnabled()).toBe(true))
    withEnv(EVENT_V2_ADMISSION_ENV, "yes", () => expect(isEventV2AdmissionEnabled()).toBe(true))
    withEnv(EVENT_V2_ADMISSION_ENV, "2", () => expect(isEventV2AdmissionEnabled()).toBe(true))
    // W0.5 (audit 9): only /^(false|0)$/ (plus "") are OFF by the table — "off"/"no" are NOT off
    // values and must stay ON; do not "fix" them into OFF.
    withEnv(EVENT_V2_ADMISSION_ENV, "off", () => expect(isEventV2AdmissionEnabled()).toBe(true))
    withEnv(EVENT_V2_ADMISSION_ENV, "no", () => expect(isEventV2AdmissionEnabled()).toBe(true))
    withEnv(IM_SINGLE_WRITE_ENV, "", () => expect(isEventV2ImSingleWriteEnabled()).toBe(false))
    withEnv(IM_SINGLE_WRITE_ENV, "false ", () => expect(isEventV2ImSingleWriteEnabled()).toBe(false))
    withEnv(IM_SINGLE_WRITE_ENV, "yes", () => expect(isEventV2ImSingleWriteEnabled()).toBe(true))
    withEnv(IM_SINGLE_WRITE_ENV, "off", () => expect(isEventV2ImSingleWriteEnabled()).toBe(true))
    withEnv(IM_SINGLE_WRITE_ENV, "no", () => expect(isEventV2ImSingleWriteEnabled()).toBe(true))
  })

  test("kill-switch =false / =0 restores the legacy authority", () => {
    withEnv(EVENT_V2_ADMISSION_ENV, "false", () => expect(isEventV2AdmissionEnabled()).toBe(false))
    withEnv(EVENT_V2_ADMISSION_ENV, "0", () => expect(isEventV2AdmissionEnabled()).toBe(false))
    withEnv(IM_SINGLE_WRITE_ENV, "false", () => expect(isEventV2ImSingleWriteEnabled()).toBe(false))
    withEnv(IM_SINGLE_WRITE_ENV, "0", () => expect(isEventV2ImSingleWriteEnabled()).toBe(false))
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
    // W0.1: both production entrypoints apply the single runtime-defaults source; the CI entry
    // must still ship the IM single-write suppression together with the V2 event-driven IM path
    // (otherwise @mention work is silently dropped — the G7i authority review P1).
    expect(entry).toContain("applyRuntimeDefaults(")
    expect(node).toContain("applyRuntimeDefaults(")
    expect(entry).toContain('process.env.DEEPAGENT_CODE_V4_EVENT_DRIVEN_IM ??= "true"')
    // both authorities' env constants are covered by the default-ON runtime defaults
    expect(defaults).toContain('= "DEEPAGENT_CODE_EVENT_V2_ADMISSION"')
    expect(defaults).toContain('= "DEEPAGENT_CODE_EVENT_V2_IM_SINGLE_WRITE"')
  })

  test("the two switches are independent", () => {
    withEnv(EVENT_V2_ADMISSION_ENV, "false", () => {
      withEnv(IM_SINGLE_WRITE_ENV, "true", () => {
        expect(isEventV2AdmissionEnabled()).toBe(false)
        expect(isEventV2ImSingleWriteEnabled()).toBe(true)
      })
    })
  })
})
