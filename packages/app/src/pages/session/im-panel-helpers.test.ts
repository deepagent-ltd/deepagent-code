import { describe, expect, test, mock } from "bun:test"
import { submitCreateGroup, submitFacadeGroupCreate, submitFacadeName, submitFacadeRebind } from "./im-panel-helpers"
import { IMFacadeRequestError } from "@/utils/im-client"
import type { IMGroup } from "@/components/im/types"

const group = (id: string, name: string): IMGroup => ({
  id,
  workspaceID: "ws",
  projectID: null,
  type: "project",
  name,
  createdBy: "server",
  kernelConvID: null,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
})

describe("submitCreateGroup", () => {
  test("creates a group via the client (never window.prompt)", async () => {
    const createGroup = mock(async (p: { name: string; type: "project" | "system" | "direct" }) =>
      group("grp_1", p.name),
    )
    const result = await submitCreateGroup("  Design  ", createGroup)

    expect(createGroup).toHaveBeenCalledTimes(1)
    // name is trimmed before sending
    expect(createGroup.mock.calls[0][0]).toEqual({ name: "Design", type: "project" })
    expect(result).toEqual({ group: group("grp_1", "Design") })
  })

  test("blank / whitespace name is a no-op and never calls the client", async () => {
    const createGroup = mock(async () => group("grp_x", "x"))
    expect(await submitCreateGroup("   ", createGroup)).toEqual({ skipped: true })
    expect(await submitCreateGroup("", createGroup)).toEqual({ skipped: true })
    expect(createGroup).not.toHaveBeenCalled()
  })

  test("surfaces a client failure as an error string", async () => {
    const createGroup = mock(async () => {
      throw new Error("boom")
    })
    const result = await submitCreateGroup("Team", createGroup)
    expect(result).toEqual({ error: "boom" })
  })
})

describe("submitFacadeName", () => {
  test("normalizes (trim + full-width/case fold) before calling the op", async () => {
    const op = mock(async (name: string) => ({ name }))
    const result = await submitFacadeName(" Ｂｏｂ ", op)
    expect(op).toHaveBeenCalledTimes(1)
    expect(op.mock.calls[0][0]).toBe("bob")
    expect(result).toEqual({ value: { name: "bob" } })
  })

  test("empty name is a skipped no-op; rule violations fail locally without calling the op", async () => {
    const op = mock(async (name: string) => ({ name }))
    expect(await submitFacadeName("   ", op)).toEqual({ skipped: true })
    const tooLong = await submitFacadeName("abcdefghijklmnopqrstu", op)
    expect(tooLong).toEqual({ errorCode: "im_invalid_name", errorMessage: "too_long", invalidReason: "too_long" })
    const badChars = await submitFacadeName("bad name!", op)
    expect(badChars).toEqual({ errorCode: "im_invalid_name", errorMessage: "invalid_chars", invalidReason: "invalid_chars" })
    expect(op).not.toHaveBeenCalled()
  })

  test("surfaces the facade code verbatim (per-code copy is a UI contract)", async () => {
    const op = mock(async () => {
      throw new IMFacadeRequestError("im_name_taken", "name taken in org", 409)
    })
    const result = await submitFacadeName("alice", op)
    expect(result).toEqual({ errorCode: "im_name_taken", errorMessage: "name taken in org" })
  })

  test("non-facade failures (network) bucket as transport_error", async () => {
    const result = await submitFacadeName("alice", async () => {
      throw new TypeError("fetch failed")
    })
    expect(result).toEqual({ errorCode: "transport_error", errorMessage: "fetch failed" })
  })
})

describe("submitFacadeRebind", () => {
  test("trims the key and rejects blank input without calling the op", async () => {
    const op = mock(async (key: string) => ({ key }))
    expect(await submitFacadeRebind("   ", op)).toEqual({ skipped: true })
    const result = await submitFacadeRebind(" sk-new ", op)
    expect(op).toHaveBeenCalledWith("sk-new")
    expect(result).toEqual({ value: { key: "sk-new" } })
  })

  test("surfaces im_key_already_bound verbatim", async () => {
    const result = await submitFacadeRebind("sk-taken", async () => {
      throw new IMFacadeRequestError("im_key_already_bound", "bound to another identity", 409)
    })
    expect(result).toEqual({ errorCode: "im_key_already_bound", errorMessage: "bound to another identity" })
  })
})

describe("submitFacadeGroupCreate", () => {
  test("validates the group name and forwards the member list", async () => {
    const create = mock(async (name: string, _memberNames: string[]) => group("grp_9", name))
    const result = await submitFacadeGroupCreate(" 设计群 ", ["bob", "carol"], create)
    expect(create).toHaveBeenCalledWith("设计群", ["bob", "carol"])
    expect(result).toEqual({ value: group("grp_9", "设计群") })
    expect(await submitFacadeGroupCreate("!!", [], create)).toMatchObject({ errorCode: "im_invalid_name" })
    expect(create).toHaveBeenCalledTimes(1)
  })
})
