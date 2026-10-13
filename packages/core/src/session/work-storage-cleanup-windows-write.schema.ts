export * as WorkStorageCleanupWindowsWriteSchema from "./work-storage-cleanup-windows-write.schema"

import { Schema } from "effect"
import { WorkProcessSupervisorSchema } from "./work-process-supervisor.schema"
import { WorkStorageCleanupSchema } from "./work-storage-cleanup.schema"
import { WorkWindowsPathSchema } from "./work-windows-path.schema"

export const Target = Schema.Literals(["win32-x64", "win32-arm64"])
export const Identity = WorkProcessSupervisorSchema.Identity.members[1]
export const File = Schema.Struct({ relative: Schema.Literals(["payload", "previous"]), identity: Identity,
  sha256: WorkStorageCleanupSchema.Digest, bytes: WorkStorageCleanupSchema.Count.check(Schema.isLessThanOrEqualTo(16_777_216)),
  retainedUnlinked: Schema.Boolean,
}).check(Schema.makeFilter((value) => value.retainedUnlinked === (value.relative === "previous")))
export const Directory = Schema.Struct({ relative: Schema.Literal(""), identity: Identity })

/** This purpose has no AppContainer/security lease. The original helper owns
 * its stage and retained old-file handle; Settings/command custody cannot
 * manufacture those capabilities from matching FileIDs or MACs. */
export const Manifest = Schema.Struct({ ...WorkStorageCleanupSchema.Manifest.fields,
  version: Schema.Literal(2), target: Target, purpose: Schema.Literal("work_write"),
  kind: Schema.Literal("write"), captureKind: Schema.Literal("native_live"),
  stagePhase: Schema.Literals(["prepared_payload", "refused_empty", "refused_payload"]),
  project: WorkWindowsPathSchema.Absolute, projectIdentity: Identity,
  data: WorkWindowsPathSchema.Absolute, dataIdentity: Identity, baseIdentity: Identity, containerIdentity: Identity,
  basename: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)), snapshotHash: Schema.Null,
  files: Schema.Array(File).check(Schema.isMaxLength(1)),
  directories: Schema.Array(Directory).check(Schema.isMinLength(1), Schema.isMaxLength(1)),
}).check(Schema.makeFilter((value) => Buffer.byteLength(JSON.stringify(value)) <= WorkStorageCleanupSchema.MAX_MANIFEST_BYTES &&
  inventory(value.files) && (value.stagePhase === "refused_empty" ? value.files.length === 0 : value.files.length === 1) &&
  value.files.every((file) => file.relative === "payload" && !file.retainedUnlinked && file.bytes <= 51_200) &&
  value.directories[0]?.identity.volumeSerial === value.containerIdentity.volumeSerial &&
  value.directories[0]?.identity.fileID === value.containerIdentity.fileID &&
  [value.dataIdentity, value.baseIdentity, value.containerIdentity, ...value.files.map((file) => file.identity)]
    .every((identity) => identity.volumeSerial === value.projectIdentity.volumeSerial)))
export type Manifest = typeof Manifest.Type

export const Journal = Schema.Struct({ ...WorkStorageCleanupSchema.Journal.fields,
  version: Schema.Literal(2), target: Target, purpose: Schema.Literal("work_write"),
  files: Schema.Array(File).check(Schema.isMaxLength(2)),
  directories: Schema.Array(Directory).check(Schema.isMinLength(1), Schema.isMaxLength(1)),
}).check(Schema.makeFilter((value) => Buffer.byteLength(JSON.stringify(value)) <= WorkStorageCleanupSchema.MAX_JOURNAL_BYTES && inventory(value.files)))
export type Journal = typeof Journal.Type
export const Proof = Schema.Struct({ ...WorkStorageCleanupSchema.Proof.fields,
  version: Schema.Literal(2), target: Target, purpose: Schema.Literal("work_write"),
  dataIdentity: Identity, baseIdentity: Identity, containerIdentity: Identity,
  originalStageRemoved: Schema.Literal(true), retainedHandlesClosed: Schema.Literal(true),
})
export type Proof = typeof Proof.Type

function inventory(files: ReadonlyArray<typeof File.Type>) {
  return new Set(files.map((file) => file.relative)).size === files.length &&
    new Set(files.map((file) => `${file.identity.volumeSerial}:${file.identity.fileID}`)).size === files.length &&
    files.reduce((bytes, file) => bytes + file.bytes, 0) <= 16_828_416
}
