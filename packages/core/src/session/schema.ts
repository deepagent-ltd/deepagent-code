export * as SessionSchema from "./schema"

import { Schema } from "effect"
import { LocationRef } from "../location/ref"
import { ModelRef } from "../model/ref"
// Deep import: project.ts owns the drizzle edges; the ID schema alone is dependency-free.
import { ProjectID } from "../project/id"
import { NonNegativeInt, RelativePath, optionalOmitUndefined, withStatics } from "../schema"
import { externalID, type ExternalID } from "../schema/external-id"
import { Identifier } from "../util/identifier"
import { V2Schema } from "../v2-schema"
import { AgentID } from "../agent/id"
import { PermissionSchema } from "../permission/schema"

export const ID = Schema.String.check(Schema.isStartsWith("ses")).pipe(
  Schema.brand("SessionID"),
  withStatics((schema) => {
    const create = () => schema.make("ses_" + Identifier.descending())
    return {
      create,
      descending: (id?: string) => (id === undefined ? create() : schema.make(id)),
      fromExternal: (input: ExternalID) => schema.make(externalID("ses", input)),
    }
  }),
)
export type ID = typeof ID.Type

export const Metadata = Schema.Record(Schema.String, Schema.Unknown).annotate({ identifier: "Session.Metadata" })
export type Metadata = typeof Metadata.Type

export const Share = Schema.Struct({ url: Schema.String }).annotate({ identifier: "Session.Share" })
export type Share = typeof Share.Type

const MessageID = Schema.String.check(Schema.isStartsWith("msg"))
const PartID = Schema.String.check(Schema.isStartsWith("prt"))

/** Canonical, bounded file-diff descriptor shared by V2 events and persisted projections. */
export const FileDiff = Schema.Struct({
  file: Schema.optional(Schema.String),
  patch: Schema.optional(Schema.String),
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.optional(Schema.Literals(["added", "deleted", "modified"])),
}).annotate({ identifier: "Session.FileDiff" })
export type FileDiff = typeof FileDiff.Type

export const DiffManifestDescriptor = Schema.Struct({
  completeness: Schema.Literals(["complete", "truncated"]),
  truncationReasons: Schema.Array(
    Schema.Literals([
      "candidate_file_limit",
      "discovery_output_limit",
      "discovery_failed",
      "manifest_bytes_limit",
      "source_file_limit",
      "source_total_limit",
      "patch_file_limit",
      "patch_total_limit",
      "materialization_failed",
      "time_limit",
    ]),
  ),
  manifestHash: Schema.String,
  totalFiles: NonNegativeInt,
  totalFilesExact: Schema.Boolean,
  statisticsExact: Schema.optional(Schema.Boolean),
  includedFiles: NonNegativeInt,
  truncatedFiles: NonNegativeInt,
}).annotate({ identifier: "Session.DiffManifestDescriptor" })
export type DiffManifestDescriptor = typeof DiffManifestDescriptor.Type

/** Summary is deliberately metadata-only; full file diffs travel in SessionEvent.DiffUpdated. */
export const Summary = Schema.Struct({
  additions: Schema.Finite,
  deletions: Schema.Finite,
  files: NonNegativeInt,
  diffManifest: DiffManifestDescriptor.pipe(Schema.optional),
}).annotate({ identifier: "Session.Summary" })
export type Summary = typeof Summary.Type

/** Revert state is an independent V2 model and is never embedded in SessionSchema.Info. */
export const Revert = Schema.Struct({
  messageID: MessageID,
  partID: PartID.pipe(Schema.optional),
  snapshot: Schema.String.pipe(Schema.optional),
  diff: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "Session.Revert" })
export type Revert = typeof Revert.Type

// Durable learning reviewer sessions (deterministic `ses_learning_review_<hash>` ids, created by
// SessionPrompt.createLearningReviewerPort) are internal infrastructure, not user work — user-facing
// listings (session.list, TUI picker, project docs) hide them by default; enumerating them needs an
// explicit include-internal opt-in.
export const LEARNING_REVIEWER_SESSION_PREFIX = "ses_learning_review_"
export const isLearningReviewerSession = (id: ID) => id.startsWith(LEARNING_REVIEWER_SESSION_PREFIX)

export class Info extends Schema.Class<Info>("SessionV2.Info")({
  id: ID,
  parentID: ID.pipe(optionalOmitUndefined),
  projectID: ProjectID.ID,
  agent: AgentID.ID.pipe(Schema.optional),
  permissions: PermissionSchema.Ruleset,
  model: ModelRef.Ref.pipe(Schema.optional),
  cost: Schema.Finite,
  tokens: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({
      read: Schema.Finite,
      write: Schema.Finite,
    }),
  }),
  time: Schema.Struct({
    created: V2Schema.DateTimeUtcFromMillis,
    updated: V2Schema.DateTimeUtcFromMillis,
    archived: V2Schema.DateTimeUtcFromMillis.pipe(Schema.optional),
  }),
  title: Schema.String,
  summary: Summary.pipe(Schema.optional),
  metadata: Metadata.pipe(Schema.optional),
  share: Share.pipe(Schema.optional),
  // Write-once snapshot of the first user message. It is carried in the event payload so the
  // encode/decode boundary cannot silently clear the projected value.
  preview: Schema.String.pipe(Schema.optional),
  location: LocationRef.Ref,
  subpath: RelativePath.pipe(Schema.optional),
}) {}
