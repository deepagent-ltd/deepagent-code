import { describe, expect, test } from "bun:test"
import { createSessionBundle, parseSessionBundle, sanitizeBundleValue } from "../../src/session/bundle"
import type { SessionSnapshot } from "../../src/session/snapshot"

const snapshot = {
  format: "deepagent-code.session-snapshot",
  format_version: 1,
  exported_at: 123,
  source: { session_id: "ses_a", title: "example" },
  session: { id: "ses_a", title: "example", v2_authority: true, metadata: {} },
  messages: [{ id: "msg_a", session_id: "ses_a", data: { text: "sk-1234567890123456" } }],
  parts: [{ id: "prt_a", session_id: "ses_a", message_id: "msg_a", data: { text: "/Users/alice/private" } }],
  activities: [{ activity_id: "activity_a", session_id: "ses_a", state: "settled" }],
  progress: [],
} as unknown as SessionSnapshot

describe("session ZIP bundle", () => {
  test("A is a verified read-only conversation and omits activity metadata", async () => {
    const result = await parseSessionBundle(await createSessionBundle({ snapshot, tier: "conversation" }))
    expect(result.manifest.tier).toBe("conversation")
    expect(result.manifest.execution).toBe("read_only_archive")
    expect(result.snapshot.session.v2_authority).toBe(false)
    expect(result.snapshot.activities).toEqual([])
    expect(JSON.stringify(result.snapshot)).not.toContain("sk-1234567890123456")
    expect(JSON.stringify(result.snapshot)).not.toContain("/Users/alice/private")
  })

  test("B retains activity metadata without granting execution authority", async () => {
    const result = await parseSessionBundle(await createSessionBundle({ snapshot, tier: "conversation_metadata" }))
    expect(result.snapshot.activities).toHaveLength(1)
    expect(result.snapshot.session.v2_authority).toBe(false)
  })

  test("C sharing forces redaction and preserves logs as archival data", async () => {
    const bytes = await createSessionBundle({
      snapshot,
      tier: "session_logs",
      share: true,
      logs: { events: [{ id: "ev_a", api_key: "top-secret" }], inputs: [], providerTurns: [] },
    })
    const result = await parseSessionBundle(bytes)
    expect(result.manifest.redacted).toBe(true)
    expect(result.logs?.events).toEqual([{ id: "ev_a", api_key: "[REDACTED]" }])
    expect(result.snapshot.session.metadata?.imported_bundle).toMatchObject({ execution: "read_only_archive" })
    expect(JSON.stringify(result)).not.toContain("top-secret")
    await expect(createSessionBundle({
      snapshot, tier: "session_logs", share: true, redact: false,
      logs: { events: [], inputs: [], providerTurns: [] },
    })).rejects.toThrow("requires redaction")
  })

  test("rejects conversation rows outside the source Session", async () => {
    const invalid = { ...snapshot, parts: [{ ...snapshot.parts[0], message_id: "missing" }] } as SessionSnapshot
    const bytes = await createSessionBundle({ snapshot: invalid, tier: "conversation" })
    const result = await parseSessionBundle(bytes).then(() => "accepted", (error: Error) => error.message)
    expect(result).toBe("session bundle relationship mismatch")
  })

  test("redacts nested credentials and absolute paths", () => {
    expect(sanitizeBundleValue({ nested: { authorization: "Bearer abc", text: "read /home/alice/key", command: 'API_KEY="private"' } })).toEqual({
      nested: { authorization: "[REDACTED]", text: "read [REDACTED_PATH]", command: "[REDACTED]" },
    })
  })
})
