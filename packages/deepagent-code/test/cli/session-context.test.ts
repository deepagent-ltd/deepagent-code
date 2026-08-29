import { describe, expect, it } from "bun:test"
import type { RecoveryExportClient } from "@/cli/session-context"
import { exportSessionContext } from "@/cli/session-context"

// C6-08: "复制上下文" in read-only recovery. The recovery evidence-export surface (client.recovery.*)
// stays available when the store is read-only; the create/read calls are exercised here with a
// minimal fake so the contract (session_id on create, export_id on read, typed errors propagate)
// is pinned without a live server.

function makeClient() {
  const calls: Record<string, unknown[]> = {}
  const client: RecoveryExportClient = {
    maintenance: {
      recovery: {
        evidenceExport: (parameters: { export_id: string }) => {
          ;(calls["evidenceExport"] ??= []).push(parameters)
          return Promise.resolve({ exportId: parameters.export_id, sessionId: "ses-1" })
        },
        evidenceExport2: {
          create: (parameters?: { evidenceExportInput?: { session_id: string } }) => {
            ;(calls["create"] ??= []).push(parameters?.evidenceExportInput)
            return Promise.resolve({ exportId: "exp_1", sessionId: parameters?.evidenceExportInput?.session_id })
          },
        },
      },
    },
  }
  return { calls, client }
}

describe("session context export", () => {
  it("creates an evidence export for a session (read-only recovery available)", async () => {
    const { calls, client } = makeClient()
    const manifest = await exportSessionContext(client, { sessionID: "ses-1" })
    expect(calls["create"]).toEqual([{ session_id: "ses-1" }])
    expect(manifest).toEqual({ exportId: "exp_1", sessionId: "ses-1" })
  })

  it("reads a previously-created evidence export by id", async () => {
    const { calls, client } = makeClient()
    const manifest = await exportSessionContext(client, { sessionID: "ses-1", exportID: "exp_old" })
    expect(calls["evidenceExport"]).toEqual([{ export_id: "exp_old" }])
    expect(manifest).toEqual({ exportId: "exp_old", sessionId: "ses-1" })
  })

  it("propagates a typed 410 for a settled/expired export (never parses a message to decide)", async () => {
    const gone = {
      name: "ApiGone",
      data: {
        schemaVersion: "stable-error.v1",
        code: "cursor_gap_exceeded",
        category: "cursor",
        httpStatus: 410,
        resource: "ses-1",
        correlationId: "corr",
        message: "export expired",
      },
    }
    const client: RecoveryExportClient = {
      maintenance: {
        recovery: {
          evidenceExport: () => Promise.reject(new Error("export expired", { cause: { body: gone } })),
          evidenceExport2: { create: () => Promise.resolve({}) },
        },
      },
    }
    await expect(exportSessionContext(client, { sessionID: "ses-1", exportID: "exp_old" })).rejects.toThrow(
      "export expired",
    )
  })
})
