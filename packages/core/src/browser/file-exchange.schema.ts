export * as BrowserFileSchema from "./file-exchange.schema"

import { Schema } from "effect"

export const PROFILE = "managed-loopback-exchange-v1"
export const MAX_FILE_BYTES = 52_428_800
export const MAX_FILES = 4
export const MAX_GRANTS_PER_CONTROL = 64
export const MAX_ARTIFACTS = 100_000
export const MAX_RESERVED_BYTES = 1_073_741_824
export const MAX_METADATA_BYTES = 33_554_432
export const MAX_RECORD_BYTES = 8_192
export const TERMINAL_RESERVE_BYTES = 2_048
export const ROW_OVERHEAD_BYTES = 1_024
// Browser binary custody has its own frame bound; Work's UTF-8 reader stays 50KiB.
export const CHUNK_BYTES = 1_048_576

export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
export const Revision = Count.check(Schema.isGreaterThan(0))
export const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const ID = Schema.String.check(Schema.isMinLength(1),
  Schema.makeFilter((value) => Buffer.byteLength(value, "utf8") <= 512 && !value.includes("\0")))
export const Relative = Schema.String.check(Schema.isMinLength(1), Schema.makeFilter((value) =>
  Buffer.byteLength(value, "utf8") <= 2048 && !/[\\:\u0000-\u001f\u007f]/.test(value) &&
  value.split("/").length <= 32 && value.split("/").every((part) => part !== "" && part !== "." && part !== "..")))
export const Name = Schema.String.check(Schema.isMinLength(1), Schema.makeFilter((value) =>
  Buffer.byteLength(value, "utf8") <= 255 && !/[\\/\u0000-\u001f\u007f]/.test(value)))
const Decimal = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]{0,19})$/))
export const Identity = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("posix"), device: Decimal, inode: Decimal }),
  Schema.Struct({ kind: Schema.Literal("windows"), volumeSerial: Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/)),
    fileID: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)) }),
])
export type Identity = typeof Identity.Type
export const FileBytes = Count.check(Schema.isLessThanOrEqualTo(MAX_FILE_BYTES))
export const URL = Schema.String.check(Schema.makeFilter((value) => {
  if (Buffer.byteLength(value, "utf8") > 2048 || !globalThis.URL.canParse(value)) return false
  const url = new globalThis.URL(value)
  return url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname) &&
    !url.username && !url.password && !url.hash && value === url.href
}))
export const PostPath = Schema.String.check(Schema.isMinLength(1), Schema.makeFilter((value) =>
  Buffer.byteLength(value, "utf8") <= 2048 && value.startsWith("/") && !value.startsWith("//") &&
  !/[?#\\\u0000]/.test(value) && !/%(?:2f|5c|00|25)/i.test(value) && !/%(?![0-9a-f]{2})/i.test(value) &&
  globalThis.URL.canParse(value, "http://127.0.0.1") && new globalThis.URL(value, "http://127.0.0.1").pathname === value))
export const Policy = Schema.Struct({ upload: Schema.Boolean, download: Schema.Boolean }).check(
  Schema.makeFilter((value) => value.upload || value.download))
export const PreviewRequest = Schema.Union([
  Schema.Struct({ direction: Schema.Literal("upload"), relative: Relative, targetPath: PostPath }),
  Schema.Struct({ direction: Schema.Literal("download"), relative: Relative, targetURL: URL,
    maxBytes: Revision.check(Schema.isLessThanOrEqualTo(MAX_FILE_BYTES)) }),
])
export type PreviewRequest = typeof PreviewRequest.Type
const PreviewFields = { version: Schema.Literal(1), instanceID: ID, controlID: ID, controlHash: Digest,
  scopeHash: Digest, helperHash: Digest, rootIdentity: Identity, relative: Relative, name: Name, observedAt: Count }
export const Preview = Schema.Union([
  Schema.Struct({ ...PreviewFields, direction: Schema.Literal("upload"), targetPath: PostPath,
    fileIdentity: Identity, bytes: FileBytes, sha256: Digest }),
  Schema.Struct({ ...PreviewFields, direction: Schema.Literal("download"), targetURL: URL,
    parentIdentity: Identity, maxBytes: Revision.check(Schema.isLessThanOrEqualTo(MAX_FILE_BYTES)), expected: Schema.Literal("missing") }),
])
export type Preview = typeof Preview.Type
export const Approve = Schema.Struct({ requestID: ID, previewID: ID, expectedControlRevision: Revision, expiresAt: Revision })
export type Approve = typeof Approve.Type
export const Confirmation = Schema.Struct({ previewHash: Digest, commandHash: Digest,
  confirmationHash: Digest, confirmedAt: Count })
export type Confirmation = typeof Confirmation.Type
export const Grant = Schema.Struct({ version: Schema.Literal(1), grantID: ID, controlID: ID, resourceID: ID,
  hostIncarnation: ID, controlEpoch: Revision, policyRevision: Revision, scopeHash: Digest,
  instanceID: ID, command: Approve, commandHash: Digest, preview: Preview, confirmation: Confirmation,
  expiresAt: Revision, createdAt: Count })
export type Grant = typeof Grant.Type
export const GrantIDs = Schema.Array(ID).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_FILES),
  Schema.makeFilter((values) => new Set(values).size === values.length))

export const Publication = Schema.Struct({ version: Schema.Literal(1), artifactID: ID, grantID: ID,
  direction: Schema.Literals(["upload", "download"]), rootIdentity: Identity, stageIdentity: Identity,
  fileIdentity: Identity, bytes: FileBytes, sha256: Digest, helperHash: Digest, observedAt: Count,
  outcome: Schema.Literals(["selected", "published"]) })
export type Publication = typeof Publication.Type
export const ArtifactState = Schema.Literals(["reserved", "staged", "selected", "published", "refused", "unknown"])
export const Artifact = Schema.Struct({ version: Schema.Literal(1), artifactID: ID, instanceID: ID,
  grantID: ID, grantHash: Digest, actionID: ID, admissionID: ID, providerReceiptID: ID, providerAttemptID: ID,
  toolCallID: ID, sessionID: ID, controlID: ID, resourceID: ID, hostIncarnation: ID, controlEpoch: Revision,
  policyRevision: Revision, scopeHash: Digest, ordinal: Count.check(Schema.isLessThan(MAX_FILES)),
  manifest: Preview, state: ArtifactState, revision: Revision, reservedBytes: Count,
  publication: Schema.NullOr(Publication), stopConfirmedAt: Schema.NullOr(Count), releasedAt: Schema.NullOr(Count),
  createdAt: Count, updatedAt: Count })
export type Artifact = typeof Artifact.Type
export const Summary = Schema.Struct({ artifactID: ID, grantID: ID, direction: Schema.Literals(["upload", "download"]),
  name: Name, bytes: FileBytes, sha256: Digest, state: Schema.Literals(["selected", "published"]), nativeVerified: Schema.Literal(true) })
export const GrantSummary = Schema.Struct({ grantID: ID, direction: Schema.Literals(["upload", "download"]), name: Name,
  bytes: Schema.optional(FileBytes), maxBytes: Schema.optional(FileBytes), expiresAt: Revision,
  state: Schema.Literals(["approved", "used", "expired", "unavailable"]) })
export type GrantSummary = typeof GrantSummary.Type
export const ErrorCodes = ["BROWSER_FILE_UNAVAILABLE", "BROWSER_FILE_INVALID", "BROWSER_FILE_CHANGED",
  "BROWSER_FILE_CONFLICT", "BROWSER_FILE_CAPACITY", "BROWSER_FILE_UNKNOWN", "BROWSER_FILE_SCOPE_DENIED"] as const
export class Error extends Schema.TaggedErrorClass<Error>()("BrowserFile.Error", {
  code: Schema.Literals(ErrorCodes), message: Schema.String,
}) {}
