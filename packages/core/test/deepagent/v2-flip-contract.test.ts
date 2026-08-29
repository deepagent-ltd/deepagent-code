import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { EVENT_V2_ADMISSION_ENV, isEventV2AdmissionEnabled } from "../../src/deepagent/event-admission"
import { IM_SINGLE_WRITE_ENV, isEventV2ImSingleWriteEnabled } from "../../src/deepagent/im-single-write"

// C7-05 contract: the V2 admission + IM single-write authorities ship ON through the PRODUCTION
// runtime entrypoint (packages/deepagent-code/src/index.ts middleware sets both envs); the
// switches themselves stay explicit-env so isolated test/daemon contexts keep their own behavior,
// and `=false`/`=0` restores the legacy authorities. The runtime double-write=0 proof lives in the
// flag-gated suites (event-v2-bridge emit counter 0 under ON, IM caller gate skip under ON).

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

  test("kill-switch =false / =0 restores the legacy authority", () => {
    withEnv(EVENT_V2_ADMISSION_ENV, "false", () => expect(isEventV2AdmissionEnabled()).toBe(false))
    withEnv(EVENT_V2_ADMISSION_ENV, "0", () => expect(isEventV2AdmissionEnabled()).toBe(false))
    withEnv(IM_SINGLE_WRITE_ENV, "false", () => expect(isEventV2ImSingleWriteEnabled()).toBe(false))
    withEnv(IM_SINGLE_WRITE_ENV, "0", () => expect(isEventV2ImSingleWriteEnabled()).toBe(false))
  })

  test("the production entrypoint enables both authorities", () => {
    const entry = readFileSync(
      fileURLToPath(new URL("../../../packages/deepagent-code/src/index.ts", import.meta.url)),
      "utf8",
    )
    expect(entry).toContain('process.env.DEEPAGENT_CODE_EVENT_V2_ADMISSION ??= "true"')
    expect(entry).toContain('process.env.DEEPAGENT_CODE_EVENT_V2_IM_SINGLE_WRITE ??= "true"')
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
