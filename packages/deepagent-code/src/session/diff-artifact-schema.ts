import { Schema } from "effect"

export const Limits = {
  batch: 4,
  manifestFiles: 100,
  patchBytes: 1024 * 1024,
} as const

export const Descriptor = Schema.Struct({
  id: Schema.String,
  hash: Schema.String,
  codec: Schema.Literals(["legacy-message-diff.v1", "legacy-message-diff.v2"]),
  fileCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
})

export const ManifestFile = Schema.Struct({
  file: Schema.String,
  additions: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  deletions: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  status: Schema.optional(Schema.Literals(["added", "deleted", "modified"])),
  patchBytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  patchHash: Schema.String,
})

export const Manifest = Schema.Struct({
  artifact: Descriptor,
  files: Schema.Array(ManifestFile),
  nextCursor: Schema.optional(Schema.String),
  complete: Schema.Boolean,
})

export const File = Schema.Struct({
  artifactID: Schema.String,
  file: Schema.String,
  additions: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  deletions: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  status: Schema.optional(Schema.Literals(["added", "deleted", "modified"])),
  patch: Schema.String,
  patchBytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  returnedBytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  patchHash: Schema.String,
  truncated: Schema.Boolean,
})
