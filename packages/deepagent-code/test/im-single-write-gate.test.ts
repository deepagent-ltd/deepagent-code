import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { shouldExecuteLegacyAgentMentions } from "../src/server/routes/instance/httpapi/handlers/im"
import { ImSingleWrite } from "@deepagent-code/core/deepagent/im-single-write"

// C5-12 — the IM single-write gate for the legacy @mention double-write. When the IM single-write switch
// is ON, the legacy synchronous @mention execution path is skipped (the durable single-write receipt is
// the authority); when OFF the legacy double-write stays authoritative (unchanged).

const saved = process.env[ImSingleWrite.IM_SINGLE_WRITE_ENV]

describe("C5-12 IM single-write legacy @mention gate", () => {
  beforeAll(() => {
    process.env[ImSingleWrite.IM_SINGLE_WRITE_ENV] = "false"
  })
  afterAll(() => {
    if (saved === undefined) delete process.env[ImSingleWrite.IM_SINGLE_WRITE_ENV]
    else process.env[ImSingleWrite.IM_SINGLE_WRITE_ENV] = saved
  })

  test("flag OFF: a message with mentions runs the legacy @mention path", () => {
    process.env[ImSingleWrite.IM_SINGLE_WRITE_ENV] = "false"
    expect(shouldExecuteLegacyAgentMentions(2)).toBe(true)
    expect(shouldExecuteLegacyAgentMentions(0)).toBe(false)
  })

  test("flag ON: the legacy @mention double-write side is SKIPPED", () => {
    process.env[ImSingleWrite.IM_SINGLE_WRITE_ENV] = "true"
    expect(shouldExecuteLegacyAgentMentions(2)).toBe(false)
    expect(shouldExecuteLegacyAgentMentions(0)).toBe(false)
  })
})
