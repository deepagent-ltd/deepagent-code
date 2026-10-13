export * as ImportJobSchema from "./schema"

import { Schema } from "effect"

const Count = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
const Time = Schema.Number.pipe(Schema.check(Schema.isFinite()))
const Scopes = Schema.Array(Schema.Literals(["session", "memory", "skill"]))

export const State = Schema.Literals([
  "preflight",
  "ready",
  "running",
  "cancel_requested",
  "completed",
  "failed",
  "cancelled",
  "cancelled_partial",
  "recovery_required",
])
export type State = typeof State.Type

export const Request = Schema.Struct({
  requestID: Schema.String,
  source: Schema.Literals(["codex", "claude"]),
  sourcePath: Schema.optional(Schema.String),
  scopes: Schema.optional(Scopes),
  dryRun: Schema.optional(Schema.Boolean),
  mode: Schema.optional(Schema.Literals(["copy_to_new_db", "merge_into_live"])),
  copyLiveDb: Schema.optional(Schema.Boolean),
  confirmLiveMerge: Schema.optional(Schema.Boolean),
  cwdFilter: Schema.optional(Schema.String),
}).annotate({ identifier: "ImportJobRequest" })
export type Request = typeof Request.Type

export const Target = Schema.Struct({
  id: Schema.String,
  mode: Schema.Literals(["copy_to_new_db", "merge_into_live"]),
  sourcePath: Schema.String,
  dbPath: Schema.String,
  dataRoot: Schema.String,
  configDir: Schema.String,
  dryRun: Schema.Boolean,
  backup: Schema.optional(Schema.Struct({ path: Schema.String, manifestPath: Schema.String, sha256: Schema.String })),
}).annotate({ identifier: "ImportJobTarget" })
export type Target = typeof Target.Type

export const SessionResult = Schema.Struct({
  sourceId: Schema.String,
  targetId: Schema.String,
  turns: Count,
  reimport: Schema.Boolean,
})
export type SessionResult = typeof SessionResult.Type

const FileSetFields = {
  kind: Schema.Literal("file_set.v1"),
  phase: Schema.Literal("published"),
  sourceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  targetId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  manifestHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  directoryRef: Schema.Struct({
    area: Schema.Literals(["data", "config"]),
    relative: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048),
      Schema.makeFilter((value) => !value.includes("\\") && !/[\u0000-\u001f\u007f:]/.test(value) &&
        value.split("/").every((part) => part !== "" && part !== "." && part !== ".."))),
  }),
  bytes: Count.check(Schema.isLessThanOrEqualTo(256 * 1024 * 1024)),
  fileCount: Count.check(Schema.isLessThanOrEqualTo(10_000)),
}
export const FileSetResult = Schema.Union([
  Schema.Struct({ ...FileSetFields, scope: Schema.Literal("memory"), summary: Schema.Struct({
    staged: Count, approved: Count, pending: Count, writtenToInstructions: Schema.Literal(false),
  }) }),
  Schema.Struct({ ...FileSetFields, scope: Schema.Literal("skill"), summary: Schema.Struct({ written: Count, skipped: Count }) }),
])
export type FileSetResult = typeof FileSetResult.Type
export const BatchResult = Schema.Union([SessionResult, FileSetResult])
export type BatchResult = typeof BatchResult.Type

export const Info = Schema.Struct({
  id: Schema.String,
  requestID: Schema.String,
  source: Schema.Literals(["codex", "claude"]),
  state: State,
  revision: Count,
  dryRun: Schema.Boolean,
  scopes: Schema.optional(Scopes),
  target: Schema.optional(Target),
  sourceDigest: Schema.optional(Schema.String),
  totalSessions: Count,
  committedBatches: Count,
  committedSessions: Schema.optional(Count),
  fileResults: Schema.optional(Schema.Array(FileSetResult)),
  failedBatches: Count,
  activeBatchID: Schema.optional(Schema.String),
  cancelRequestedAt: Schema.optional(Time),
  stopConfirmedAt: Schema.optional(Time),
  createdAt: Time,
  updatedAt: Time,
  settledAt: Schema.optional(Time),
  error: Schema.optional(Schema.Struct({ code: Schema.String, message: Schema.String })),
}).annotate({ identifier: "ImportJobInfo" })
export type Info = typeof Info.Type

export const Page = Schema.Struct({ items: Schema.Array(Info), cursor: Schema.optional(Schema.String) })

export class Error extends Schema.TaggedErrorClass<Error>()("ImportJob.Error", {
  code: Schema.Literals(["invalid_request", "conflict", "not_found", "unavailable"]),
  message: Schema.String,
}) {}

export const terminal = (state: State) =>
  state === "completed" ||
  state === "failed" ||
  state === "cancelled" ||
  state === "cancelled_partial" ||
  state === "recovery_required"
