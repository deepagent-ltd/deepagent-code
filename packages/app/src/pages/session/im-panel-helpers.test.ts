import { describe, expect, test, mock } from "bun:test"
import { submitCreateGroup } from "./im-panel-helpers"
import type { IMGroup } from "@/components/im/types"

const group = (id: string, name: string): IMGroup => ({
  id,
  workspaceID: "ws",
  projectID: null,
  type: "project",
  name,
  createdBy: "server",
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
})

describe("submitCreateGroup", () => {
  test("creates a group via the client (never window.prompt)", async () => {
    const createGroup = mock(async (p: { name: string; type: "project" | "system" }) => group("grp_1", p.name))
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
