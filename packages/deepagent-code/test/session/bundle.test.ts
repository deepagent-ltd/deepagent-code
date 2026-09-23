import { describe, expect, test } from "bun:test"
import { BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js"
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

  test("rejects a valid ZIP whose member hashes do not match the manifest", async () => {
    const writer = new ZipWriter(new BlobWriter("application/zip"))
    await writer.add("manifest.json", new TextReader(JSON.stringify({
      format: "deepagent-code.session-bundle", format_version: 1, archive: "zip", tier: "conversation",
      exported_at: 1, source: { session_id: "ses_a", title: "test" },
      counts: { messages: 0, parts: 0, events: 0, receipts: 0 },
      checksums: { "session.json": "0".repeat(64), "conversation.json": "0".repeat(64) },
      redacted: true, execution: "read_only_archive",
    })))
    await writer.add("session.json", new TextReader("{}"))
    await writer.add("conversation.json", new TextReader("{}"))
    const bytes = new Uint8Array(await (await writer.close()).arrayBuffer())
    const result = await parseSessionBundle(bytes).then(() => "accepted", (error: Error) => error.message)
    expect(result).toBe("session bundle checksum mismatch")
  })

  test("redacts nested credentials and absolute paths", () => {
    expect(sanitizeBundleValue({ nested: { authorization: "Bearer abc", authorization_fingerprint: "digest", ownerToken: "owner-secret", text: "read /home/alice/key", command: 'API_KEY="private"' } })).toEqual({
      nested: { authorization: "[REDACTED]", authorization_fingerprint: "digest", ownerToken: "[REDACTED]", text: "read [REDACTED_PATH]", command: "[REDACTED]" },
    })
  })
})
