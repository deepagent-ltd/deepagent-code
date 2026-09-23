import { createHash } from "node:crypto"
import { BlobReader, BlobWriter, TextReader, TextWriter, ZipReader, ZipWriter } from "@zip.js/zip.js"
import { Effect } from "effect"
import { asc, eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventTable } from "@deepagent-code/core/event/sql"
import { SessionContextEpochTable, SessionInputTable } from "@deepagent-code/core/session/sql"
import { SessionContextSelectionTable } from "@deepagent-code/core/context-federation/session-sql"
import { V2ProviderTurnReceiptTable } from "@deepagent-code/core/session/runner/v2-provider-turn.sql"
import { V2TaskRunReceiptTable } from "@deepagent-code/core/session/runner/v2-task-run-receipt.sql"
import { V2ToolEffectAdmissionTable, V2ToolEffectTable } from "@deepagent-code/core/session/runner/v2-tool-effect.sql"
import { SessionToolRequestReceiptTable } from "./tool-request-receipt.sql"
import { exportSessionSnapshot } from "./snapshot"
import type { SessionSnapshot } from "./snapshot"

export const BUNDLE_FORMAT = "deepagent-code.session-bundle"
export const BUNDLE_VERSION = 1
export const BUNDLE_MAX_BYTES = 64 * 1024 * 1024

export type BundleTier = "conversation" | "conversation_metadata" | "session_logs"
export type BundleLogs = {
  events: unknown[]
  inputs: unknown[]
  providerTurns: unknown[]
  receipts?: unknown[]
}
export type BundleContext = { selections: unknown[]; epoch: unknown | null }
export type BundleProgress = (phase: "collect" | "redact" | "compress" | "verify" | "done", percent: number, bytes: number) => void

export type BundleManifest = {
  format: typeof BUNDLE_FORMAT
  format_version: typeof BUNDLE_VERSION
  tier: BundleTier
  archive: "zip"
  exported_at: number
  source: { session_id: string; title: string }
  counts: { messages: number; parts: number; events: number; receipts: number }
  checksums: Record<string, string>
  redacted: boolean
  execution: "read_only_archive"
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")
const sensitiveKey = /(?:^|[_-])(?:api[_-]?key|authorization|token|secret|password|credential|private[_-]?key)$|(?:ApiKey|Token|Secret|Password|Credential|PrivateKey)$/i
const secretValue = /\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+|(?:api[_-]?key|token|secret|password)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,"'}]+))/gi
const absolutePath = /(?:\/Users\/|\/home\/|\/root\/|\/tmp\/|\/var\/|[A-Za-z]:\\Users\\)[^\s"'`<>]+/g

export function sanitizeBundleValue(value: unknown): unknown {
  if (typeof value === "string") return value.replace(secretValue, "[REDACTED]").replace(absolutePath, "[REDACTED_PATH]")
  if (Array.isArray(value)) return value.map(sanitizeBundleValue)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sensitiveKey.test(key) ? "[REDACTED]" : sanitizeBundleValue(item)]),
    )
  return value
}

export async function createSessionBundle(input: {
  snapshot: SessionSnapshot
  tier: BundleTier
  redact?: boolean
  logs?: BundleLogs
  context?: BundleContext
  share?: boolean
  progress?: BundleProgress
}): Promise<Uint8Array> {
  if (input.tier === "session_logs" && !input.logs) throw new Error("session_logs requires durable log collection")
  if (input.share && input.tier === "session_logs" && input.redact === false)
    throw new Error("session_logs sharing requires redaction")
  input.progress?.("collect", 10, 0)
  const redacted = input.share || input.redact !== false
  const snapshot = input.snapshot
  const clean = (value: unknown) => JSON.stringify(redacted ? sanitizeBundleValue(value) : value)
  const files: Record<string, string> = {
    "session.json": clean({
      ...snapshot.session,
      metadata: null,
      permission: null,
      revert: null,
      summary_diffs: null,
      summary_diff_manifest: null,
      execution_claim_token: null,
      interrupt_seq: null,
      v2_authority: false,
      share_url: null,
    }),
    "conversation.json": clean({ messages: snapshot.messages, parts: snapshot.parts }),
  }
  if (input.tier !== "conversation")
    files["metadata.json"] = clean({ activities: snapshot.activities, progress: snapshot.progress, context: input.context ?? { selections: [], epoch: null } })
  if (input.tier === "session_logs") {
    files["logs/events.jsonl"] = (input.logs?.events ?? []).map((row) => clean(row)).join("\n")
    files["logs/inputs.jsonl"] = (input.logs?.inputs ?? []).map((row) => clean(row)).join("\n")
    files["logs/provider-turns.jsonl"] = (input.logs?.providerTurns ?? []).map((row) => clean(row)).join("\n")
    files["logs/receipts.jsonl"] = (input.logs?.receipts ?? []).map((row) => clean(row)).join("\n")
  }
  if (Object.values(files).reduce((sum, value) => sum + Buffer.byteLength(value), 0) > BUNDLE_MAX_BYTES)
    throw new Error("session bundle source exceeds 64 MiB limit")
  input.progress?.("redact", 40, Object.values(files).reduce((sum, value) => sum + value.length, 0))
  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    format_version: BUNDLE_VERSION,
    tier: input.tier,
    archive: "zip",
    exported_at: snapshot.exported_at,
    source: redacted ? (sanitizeBundleValue(snapshot.source) as BundleManifest["source"]) : snapshot.source,
    counts: {
      messages: snapshot.messages.length,
      parts: snapshot.parts.length,
      events: input.logs?.events.length ?? 0,
      receipts: input.logs?.receipts?.length ?? 0,
    },
    checksums: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, sha256(value)])),
    redacted,
    // No imported bundle grants the target V2 authority. A valid zip is evidence of integrity,
    // not evidence of execution ownership or a replayable provider state.
    execution: "read_only_archive",
  }
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  for (const [name, value] of Object.entries({ "manifest.json": JSON.stringify(manifest), ...files })) {
    await writer.add(name, new TextReader(value))
    input.progress?.("compress", 40 + Math.floor((Object.keys(files).indexOf(name) + 1) * 50 / (Object.keys(files).length + 1)), value.length)
  }
  const result = new Uint8Array(await (await writer.close()).arrayBuffer())
  if (result.byteLength > BUNDLE_MAX_BYTES) throw new Error("session bundle exceeds 64 MiB limit")
  input.progress?.("done", 100, result.byteLength)
  return result
}

export async function parseSessionBundle(bytes: Uint8Array, progress?: BundleProgress): Promise<{
  manifest: BundleManifest
  snapshot: SessionSnapshot
  logs?: BundleLogs
  context?: BundleContext
}> {
  if (bytes.byteLength > BUNDLE_MAX_BYTES) throw new Error("session bundle exceeds 64 MiB limit")
  progress?.("verify", 10, bytes.byteLength)
  const reader = new ZipReader(new BlobReader(new Blob([new Uint8Array(bytes)])))
  const entries = await reader.getEntries()
  if (entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0) > BUNDLE_MAX_BYTES)
    throw new Error("session bundle expands beyond 64 MiB limit")
  const names = entries.map((entry) => entry.filename)
  if (new Set(names).size !== names.length) throw new Error("duplicate bundle member")
  if (names.some((name) => name.startsWith("/") || name.includes("..") || name.includes("\\")))
    throw new Error("unsafe bundle member")
  const contents: Record<string, string> = {}
  let actualBytes = 0
  try {
    for (const entry of entries) {
      if (!entry.getData || entry.uncompressedSize > BUNDLE_MAX_BYTES) throw new Error("unsupported or oversized bundle member")
      const value = await entry.getData(new TextWriter())
      actualBytes += Buffer.byteLength(value)
      if (actualBytes > BUNDLE_MAX_BYTES) throw new Error("session bundle expands beyond 64 MiB limit")
      contents[entry.filename] = value
    }
  } finally {
    await reader.close()
  }
  const manifest = JSON.parse(contents["manifest.json"] ?? "null") as BundleManifest | null
  if (manifest?.format !== BUNDLE_FORMAT || manifest.format_version !== BUNDLE_VERSION || manifest.archive !== "zip")
    throw new Error("unsupported session bundle format or version")
  if (!["conversation", "conversation_metadata", "session_logs"].includes(manifest.tier))
    throw new Error("unsupported session bundle tier")
  if (manifest.execution !== "read_only_archive") throw new Error("unsupported session bundle execution authority")
  const required = ["session.json", "conversation.json"]
  if (manifest.tier !== "conversation") required.push("metadata.json")
  if (manifest.tier === "session_logs")
    required.push("logs/events.jsonl", "logs/inputs.jsonl", "logs/provider-turns.jsonl", "logs/receipts.jsonl")
  if (Object.keys(manifest.checksums).length !== required.length || required.some((name) => contents[name] === undefined))
    throw new Error("session bundle missing required members")
  if (names.some((name) => name !== "manifest.json" && !required.includes(name)))
    throw new Error("session bundle has unexpected members")
  if (required.some((name) => manifest.checksums[name] !== sha256(contents[name])))
    throw new Error("session bundle checksum mismatch")
  const session = JSON.parse(contents["session.json"]) as SessionSnapshot["session"]
  const conversation = JSON.parse(contents["conversation.json"]) as Pick<SessionSnapshot, "messages" | "parts">
  const metadata = contents["metadata.json"]
    ? (JSON.parse(contents["metadata.json"]) as Pick<SessionSnapshot, "activities" | "progress"> & { context?: BundleContext })
    : { activities: [], progress: [], context: undefined }
  if (!Array.isArray(conversation.messages) || !Array.isArray(conversation.parts))
    throw new Error("invalid session conversation")
  if (!Array.isArray(metadata.activities) || !Array.isArray(metadata.progress))
    throw new Error("invalid session metadata")
  if (session.id !== manifest.source.session_id || conversation.messages.length !== manifest.counts.messages ||
      conversation.parts.length !== manifest.counts.parts)
    throw new Error("session bundle manifest does not match content")
  const messageIDs = new Set<string>(conversation.messages.map((row) => row.id))
  const partIDs = new Set<string>(conversation.parts.map((row) => row.id))
  const activityIDs = new Set(metadata.activities.map((row) => row.activity_id))
  if (messageIDs.size !== conversation.messages.length || conversation.messages.some((row) => row.session_id !== session.id) ||
      partIDs.size !== conversation.parts.length ||
      conversation.parts.some((row) => row.session_id !== session.id || !messageIDs.has(row.message_id)) ||
      activityIDs.size !== metadata.activities.length || metadata.activities.some((row) => row.session_id !== session.id) ||
      metadata.progress.some((row) => !activityIDs.has(row.activity_id) || !messageIDs.has(row.assistant_message_id) ||
        (row.text_part_id !== null && row.text_part_id !== undefined && !partIDs.has(row.text_part_id))))
    throw new Error("session bundle relationship mismatch")
  const decodeLines = (name: string) => contents[name]?.split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown) ?? []
  const logs = manifest.tier === "session_logs"
    ? { events: decodeLines("logs/events.jsonl"), inputs: decodeLines("logs/inputs.jsonl"),
        providerTurns: decodeLines("logs/provider-turns.jsonl"), receipts: decodeLines("logs/receipts.jsonl") }
    : undefined
  if (logs && (logs.events.length !== manifest.counts.events || logs.receipts.length !== manifest.counts.receipts))
    throw new Error("session bundle log count mismatch")
  progress?.("done", 100, bytes.byteLength)
  return {
    manifest,
    snapshot: {
      format: "deepagent-code.session-snapshot",
      format_version: 1,
      exported_at: manifest.exported_at,
      source: manifest.source,
      session: {
        ...session,
        v2_authority: false,
        metadata: {
          ...session.metadata,
          imported_bundle: {
            tier: manifest.tier,
            redacted: manifest.redacted,
            execution: manifest.execution,
            // These records are retained for inspection only. The Session runner never reads
            // them as admission, receipt, or EventV2 authority.
            ...(logs ? { logs } : {}),
            ...(metadata.context ? { context: metadata.context } : {}),
          },
        },
      },
      messages: conversation.messages,
      parts: conversation.parts,
      activities: metadata.activities,
      progress: metadata.progress,
    },
    logs,
    context: metadata.context,
  }
}

export const exportSessionBundle = Effect.fn("Session.exportBundle")(function* (input: {
  sessionID: string
  tier: BundleTier
  redact?: boolean
  share?: boolean
  progress?: BundleProgress
}) {
  const snapshot = yield* exportSessionSnapshot(input.sessionID)
  const { db } = yield* Database.Service
  const logs = input.tier === "session_logs"
    ? {
        events: yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, input.sessionID))
          .orderBy(asc(EventTable.seq)).all().pipe(Effect.orDie),
        inputs: yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, snapshot.session.id))
          .orderBy(asc(SessionInputTable.admitted_seq)).all().pipe(Effect.orDie),
        providerTurns: yield* db.select().from(V2ProviderTurnReceiptTable)
          .where(eq(V2ProviderTurnReceiptTable.session_id, snapshot.session.id))
          .orderBy(asc(V2ProviderTurnReceiptTable.request_ordinal)).all().pipe(Effect.orDie),
        receipts: [
          ...(yield* db.select().from(SessionToolRequestReceiptTable)
            .where(eq(SessionToolRequestReceiptTable.session_id, snapshot.session.id))
            .orderBy(asc(SessionToolRequestReceiptTable.request_ordinal)).all().pipe(Effect.orDie))
            .map((row) => ({ type: "legacy_tool_request", row })),
          ...(yield* db.select().from(V2TaskRunReceiptTable)
            .where(eq(V2TaskRunReceiptTable.session_id, snapshot.session.id))
            .orderBy(asc(V2TaskRunReceiptTable.time_created)).all().pipe(Effect.orDie))
            .map((row) => ({ type: "v2_task_run", row })),
          ...(yield* db.select().from(V2ToolEffectAdmissionTable)
            .where(eq(V2ToolEffectAdmissionTable.session_id, snapshot.session.id))
            .orderBy(asc(V2ToolEffectAdmissionTable.time_created)).all().pipe(Effect.orDie))
            .map((row) => ({ type: "v2_tool_effect_admission", row })),
          ...(yield* db.select().from(V2ToolEffectTable)
            .where(eq(V2ToolEffectTable.session_id, snapshot.session.id))
            .orderBy(asc(V2ToolEffectTable.time_created)).all().pipe(Effect.orDie))
            .map((row) => ({ type: "v2_tool_effect", row })),
        ],
      }
    : undefined
  const context = input.tier === "conversation" ? undefined : {
    selections: yield* db.select().from(SessionContextSelectionTable)
      .where(eq(SessionContextSelectionTable.session_id, snapshot.session.id))
      .orderBy(asc(SessionContextSelectionTable.created_at)).all().pipe(Effect.orDie),
    epoch: (yield* db.select().from(SessionContextEpochTable)
      .where(eq(SessionContextEpochTable.session_id, snapshot.session.id)).get().pipe(Effect.orDie)) ?? null,
  }
  return yield* Effect.tryPromise(() => createSessionBundle({ ...input, snapshot, logs, context }))
})
