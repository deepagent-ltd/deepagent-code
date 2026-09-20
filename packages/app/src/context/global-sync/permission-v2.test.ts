import { describe, expect, test } from "bun:test"
import type { DeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { permissionRequestFromV2, replyPermission } from "./permission-v2"

describe("permissionRequestFromV2", () => {
  test("maps the PermissionV2 vocabulary onto the legacy PermissionRequest shape", () => {
    expect(
      permissionRequestFromV2({
        id: "per_1",
        sessionID: "ses_1",
        action: "bash",
        resources: ["git status"],
        save: ["git *"],
        metadata: { reason: "test" },
        source: { type: "tool", messageID: "msg_1", callID: "call_1" },
      }),
    ).toEqual({
      id: "per_1",
      sessionID: "ses_1",
      permission: "bash",
      patterns: ["git status"],
      always: ["git *"],
      metadata: { reason: "test" },
      tool: { messageID: "msg_1", callID: "call_1" },
    })
  })

  test("defaults optional fields and drops a missing source", () => {
    expect(permissionRequestFromV2({ id: "per_1", sessionID: "ses_1", action: "read", resources: [] })).toEqual({
      id: "per_1",
      sessionID: "ses_1",
      permission: "read",
      patterns: [],
      always: [],
      metadata: {},
    })
  })
})

describe("replyPermission", () => {
  const client = (calls: [string, unknown][]) =>
    ({
      v2: {
        session: {
          permission: {
            reply: async (input: unknown) => {
              calls.push(["v2", input])
              return { data: true }
            },
          },
        },
      },
      permission: {
        respond: async (input: unknown) => {
          calls.push(["legacy", input])
          return { data: true }
        },
      },
    }) as unknown as DeepAgentCodeClient

  test("routes provenance-tracked requests to the session-scoped V2 route, carrying reject feedback", async () => {
    const calls: [string, unknown][] = []
    await replyPermission(client(calls), {
      sessionID: "ses_1",
      requestID: "per_1",
      response: "reject",
      message: "do not run this",
      v2: true,
    })
    expect(calls).toEqual([
      ["v2", { sessionID: "ses_1", requestID: "per_1", reply: "reject", message: "do not run this" }],
    ])
  })

  test("omits message on the V2 route when no feedback is given", async () => {
    const calls: [string, unknown][] = []
    await replyPermission(client(calls), { sessionID: "ses_1", requestID: "per_1", response: "once", v2: true })
    expect(calls).toEqual([["v2", { sessionID: "ses_1", requestID: "per_1", reply: "once" }]])
  })

  test("routes legacy requests to the legacy respond route", async () => {
    const calls: [string, unknown][] = []
    await replyPermission(client(calls), {
      sessionID: "ses_1",
      requestID: "per_1",
      response: "always",
      directory: "/tmp",
    })
    expect(calls).toEqual([
      ["legacy", { sessionID: "ses_1", permissionID: "per_1", response: "always", directory: "/tmp" }],
    ])
  })

  test("omits directory on the legacy route when not given", async () => {
    const calls: [string, unknown][] = []
    await replyPermission(client(calls), { sessionID: "ses_1", requestID: "per_1", response: "once" })
    expect(calls).toEqual([["legacy", { sessionID: "ses_1", permissionID: "per_1", response: "once" }]])
  })
})
