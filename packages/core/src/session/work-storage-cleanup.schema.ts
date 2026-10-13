export * as WorkStorageCleanupSchema from "./work-storage-cleanup.schema"

import { Schema } from "effect"
import { WorkAuthoritySchema } from "./work-authority.schema"

export const MAX_MANIFEST_BYTES = 65536
export const MAX_JOURNAL_BYTES = 131072
export const MAX_INSTANCE_RECORDS = 10000
export const MAX_INSTANCE_BYTES = 33554432
export const MAX_ACTIVE = 40
export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
export const Positive = Count.check(Schema.isGreaterThanOrEqualTo(1))
export const Text = Schema.String.check(Schema.isMinLength(1), Schema.makeFilter((value: string) =>
  value.isWellFormed() && Buffer.byteLength(value) <= 512 && !/[\u0000-\u001f\u007f]/.test(value)))
export const Digest = WorkAuthoritySchema.Digest
export const Decimal = Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]{0,19})$/))
export const Identity = Schema.Struct({ kind: Schema.Literal("posix"), device: Decimal, inode: Decimal })
export const Relative = Schema.String.check(Schema.makeFilter((value: string) =>
  value.isWellFormed() && Buffer.byteLength(value) <= 2048 && !/[\\:\u0000-\u001f\u007f]/.test(value) &&
  value.split("/").length <= 16 && value.split("/").every((part) => part !== "" && part !== "." && part !== "..")))
export const DirectoryRelative = Schema.Union([Schema.Literal(""), Relative])
export const Absolute = Schema.String.check(Schema.isMinLength(1), Schema.makeFilter((value: string) =>
  value.isWellFormed() && Buffer.byteLength(value) <= 2048 && value.startsWith("/") && !/[\\\u0000-\u001f\u007f]/.test(value) &&
  value.split("/").slice(1).every((part) => part !== "" && part !== "." && part !== "..")))
export const File = Schema.Struct({ relative: Relative, identity: Identity, sha256: Digest,
  bytes: Count.check(Schema.isLessThanOrEqualTo(16777216)) })
export const Directory = Schema.Struct({ relative: DirectoryRelative, identity: Identity })
export const Manifest = Schema.Struct({
  version: Schema.Literal(1), admissionID: Text, kind: Schema.Literals(["write", "command"]),
  captureKind: Schema.Literals(["native_live", "known_empty_legacy"]),
  instanceID: Text, workID: Text, rootWorkID: Text, sessionID: Text, inputID: Text,
  activityID: Text, providerReceiptID: Text, providerAttemptID: Text, toolCallID: Text,
  ownerToken: Text, sessionClaimToken: Positive, bindingHash: Digest, controlRevision: Positive,
  custodyID: Text, sourceRequestHash: Digest, helperHash: Digest, snapshotHash: Schema.NullOr(Digest),
  project: Absolute, projectIdentity: Identity, data: Absolute, dataIdentity: Identity,
  baseIdentity: Identity, containerIdentity: Identity,
  basename: Schema.String.check(Schema.isPattern(/^(?:cmd_)?[a-f0-9]{32}$/)),
  files: Schema.Array(File).check(Schema.isMaxLength(288)),
  directories: Schema.Array(Directory).check(Schema.isMaxLength(4610)),
  createdAt: Positive,
}).check(Schema.makeFilter((value) => {
  const files = value.files.map((item) => item.relative)
  const directories = value.directories.map((item) => item.relative)
  return Buffer.byteLength(JSON.stringify(value)) <= MAX_MANIFEST_BYTES &&
    new Set(files).size === files.length && new Set(directories).size === directories.length &&
    directories.includes("") && value.files.reduce((sum, item) => sum + item.bytes, 0) <= 67108864 &&
    (value.captureKind !== "known_empty_legacy" || (value.kind === "write" && value.files.length === 0)) &&
    (value.kind === "command" ? value.basename.startsWith("cmd_") && value.snapshotHash !== null
      : !value.basename.startsWith("cmd_") && value.snapshotHash === null)
}))
export type Manifest = typeof Manifest.Type
export const Request = Schema.Struct({ recoveryID: Text, admissionID: Text, requestID: Text,
  expectedCustodyRevision: Positive })
export type Request = typeof Request.Type
export const Phase = Schema.Literals(["retained", "cleanup_pending", "cleanup_recovery", "cleanup_verified", "released"])
export const Journal = Schema.Struct({
  version: Schema.Literal(1), cleanupID: Text, request: Request, requestHash: Digest,
  instanceID: Text, operatorID: Text, operatorRevision: Positive,
  manifestHash: Digest, custodyRecordHash: Digest, recoveryRecordHash: Digest,
  effectID: Text, effectHash: Digest, proofHash: Digest, knownHash: Digest,
  quarantine: Schema.String.check(Schema.isPattern(/^cleanup_[a-f0-9]{32}$/)),
  files: Schema.Array(File).check(Schema.isMaxLength(288)),
  directories: Schema.Array(Directory).check(Schema.isMaxLength(4610)),
  createdAt: Positive,
}).check(Schema.makeFilter((value) => Buffer.byteLength(JSON.stringify(value)) <= MAX_JOURNAL_BYTES &&
  new Set(value.files.map((item) => item.relative)).size === value.files.length &&
  new Set(value.directories.map((item) => item.relative)).size === value.directories.length &&
  value.directories.some((item) => item.relative === "")))
export type Journal = typeof Journal.Type
export const Proof = Schema.Struct({ version: Schema.Literal(1), cleanupID: Text,
  manifestHash: Digest, planHash: Digest, dataIdentity: Identity, baseIdentity: Identity,
  containerIdentity: Identity, quarantine: Schema.String.check(Schema.isPattern(/^cleanup_[a-f0-9]{32}$/)),
  state: Schema.Literal("empty_verified"), files: Count.check(Schema.isLessThanOrEqualTo(288)),
  observedAt: Positive,
})
export type Proof = typeof Proof.Type
export const Receipt = Schema.Struct({ contract: Schema.Literal("work-storage-cleanup.v1"), cleanupID: Text,
  admissionID: Text, workID: Text, requestHash: Digest, phase: Phase, revision: Positive,
  releasedBytes: Count, recordedAt: Positive, replayed: Schema.Boolean })
export type Receipt = typeof Receipt.Type
export class Error extends Schema.TaggedErrorClass<Error>()("WorkStorageCleanup.Error", {
  code: Schema.Literals(["STORAGE_UNAVAILABLE", "STORAGE_INVALID", "STORAGE_AUTH_REQUIRED", "STORAGE_CONFLICT",
    "STORAGE_CAPACITY", "STORAGE_UNKNOWN", "STORAGE_UNSUPPORTED"]),
  message: Schema.String,
}) {}
