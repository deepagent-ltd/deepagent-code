import { describe, expect, test } from "bun:test"
import { EVENT_V2_ADMISSION_ENV, isEventV2AdmissionEnabled } from "../../src/deepagent/event-admission"
import { IM_SINGLE_WRITE_ENV, isEventV2ImSingleWriteEnabled } from "../../src/deepagent/im-single-write"

// C7-05 flip contract: the V2 admission + IM single-write switches SHIP ON by default (the V2
// surface is the single authority); an explicit `=false`/`=0` restores the legacy path. The
// runtime double-write=0 proof lives in the flag-gated suites (event-v2-bridge emit counter 0
// under ON, im caller gate skip under ON) — this file pins the switch semantics themselves.

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

describe("C7-05 flip contract (default ON + explicit kill-switch)", () => {
  test("V2 admission ships ON by default", () => {
    withEnv(EVENT_V2_ADMISSION_ENV, undefined, () => expect(isEventV2AdmissionEnabled()).toBe(true))
  })

  test("admission kill-switch =false / =0 restores the legacy authority; =true re-enables", () => {
    withEnv(EVENT_V2_ADMISSION_ENV, "false", () => expect(isEventV2AdmissionEnabled()).toBe(false))
    withEnv(EVENT_V2_ADMISSION_ENV, "0", () => expect(isEventV2AdmissionEnabled()).toBe(false))
    withEnv(EVENT_V2_ADMISSION_ENV, "true", () => expect(isEventV2AdmissionEnabled()).toBe(true))
    withEnv(EVENT_V2_ADMISSION_ENV, "1", () => expect(isEventV2AdmissionEnabled()).toBe(true))
  })

  test("IM single-write ships ON by default with the same kill-switch semantics", () => {
    withEnv(IM_SINGLE_WRITE_ENV, undefined, () => expect(isEventV2ImSingleWriteEnabled()).toBe(true))
    withEnv(IM_SINGLE_WRITE_ENV, "false", () => expect(isEventV2ImSingleWriteEnabled()).toBe(false))
    withEnv(IM_SINGLE_WRITE_ENV, "0", () => expect(isEventV2ImSingleWriteEnabled()).toBe(false))
  })

  test("the two switches are independent", () => {
    withEnv(EVENT_V2_ADMISSION_ENV, "false", () => {
      withEnv(IM_SINGLE_WRITE_ENV, undefined, () => {
        expect(isEventV2AdmissionEnabled()).toBe(false)
        expect(isEventV2ImSingleWriteEnabled()).toBe(true)
      })
    })
  })
})
