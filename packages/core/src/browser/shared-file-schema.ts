export * as SharedBrowserFileSchema from "./shared-file-schema"

import { Option, Schema } from "effect"
import { BrowserSchema } from "./schema"
import { BrowserFileSchema } from "./file-exchange.schema"
import { SharedBrowserSchema } from "./shared-schema"

const ID = BrowserSchema.ID.check(Schema.makeFilter((value) => !value.includes("\0")))
const Relative = BrowserSchema.Address.check(
  Schema.makeFilter(
    (value) =>
      !/[\\:\u0000-\u001f\u007f]/.test(value) &&
      value.split("/").length <= 32 &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  ),
)
const Name = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter(
    (value) => new TextEncoder().encode(value).byteLength <= 255 && !/[\\/\u0000-\u001f\u007f]/.test(value),
  ),
)
export const TargetURL = BrowserSchema.Address.check(
  Schema.makeFilter((value) => {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      url.href === value &&
      Option.isSome(Schema.decodeUnknownOption(SharedBrowserSchema.Origin)(url.origin))
    )
  }),
)

/** Durable identity only: a decoded binding never creates a live native file capability. */
export const Binding = Schema.Struct({
  kind: Schema.Literal("shared-v2"),
  resourceID: ID,
  rootSessionID: ID,
  mainIncarnation: ID,
  sidecarIncarnation: ID,
  leaseID: ID,
  leaseEpoch: BrowserSchema.Revision,
  manualEpoch: BrowserSchema.Count,
  policyHash: BrowserSchema.Digest,
  scopeHash: BrowserSchema.Digest,
})
export type Binding = typeof Binding.Type
export const Execution = Schema.Struct({
  binding: Binding,
  bindingHash: BrowserSchema.Digest,
  actionID: ID,
  admissionID: ID,
  providerReceiptID: ID,
  providerAttemptID: ID,
  toolCallID: ID,
  commandHash: BrowserSchema.Digest,
  deadline: BrowserSchema.Revision,
})
export type Execution = typeof Execution.Type

export const PreviewRequest = Schema.Union([
  Schema.Struct({ direction: Schema.Literal("upload"), relative: Relative, targetURL: TargetURL }),
  Schema.Struct({
    direction: Schema.Literal("download"),
    relative: Relative,
    targetURL: TargetURL,
    maxBytes: BrowserFileSchema.Revision.check(Schema.isLessThanOrEqualTo(BrowserFileSchema.MAX_FILE_BYTES)),
  }),
])
export type PreviewRequest = typeof PreviewRequest.Type
const PreviewFields = {
  version: Schema.Literal(2),
  binding: Binding,
  bindingHash: BrowserSchema.Digest,
  instanceID: ID,
  scopeHash: BrowserSchema.Digest,
  helperHash: BrowserSchema.Digest,
  rootIdentity: BrowserFileSchema.Identity,
  relative: Relative,
  name: Name,
  observedAt: BrowserSchema.Count,
}
export const Preview = Schema.Union([
  Schema.Struct({
    ...PreviewFields,
    direction: Schema.Literal("upload"),
    targetURL: TargetURL,
    fileIdentity: BrowserFileSchema.Identity,
    bytes: BrowserFileSchema.FileBytes,
    sha256: BrowserSchema.Digest,
  }),
  Schema.Struct({
    ...PreviewFields,
    direction: Schema.Literal("download"),
    targetURL: TargetURL,
    parentIdentity: BrowserFileSchema.Identity,
    maxBytes: BrowserFileSchema.Revision.check(Schema.isLessThanOrEqualTo(BrowserFileSchema.MAX_FILE_BYTES)),
    expected: Schema.Literal("missing"),
  }),
]).check(
  Schema.makeFilter(
    (value) => value.scopeHash === value.binding.scopeHash && value.name === value.relative.split("/").at(-1),
  ),
)
export type Preview = typeof Preview.Type
export const Approve = Schema.Struct({
  requestID: ID,
  previewID: ID,
  expectedResourceRevision: BrowserSchema.Revision,
  expectedLeaseID: ID,
  expectedLeaseEpoch: BrowserSchema.Revision,
  expectedManualEpoch: BrowserSchema.Count,
  expiresAt: BrowserSchema.Revision,
})
export type Approve = typeof Approve.Type
/** A settled native refusal for this exact intent; never an execution grant. */
export const Cancellation = Schema.Struct({
  kind: Schema.Literal("cancelled"),
  resourceID: ID,
  requestID: ID,
  bindingHash: BrowserSchema.Digest,
  previewHash: BrowserSchema.Digest,
  commandHash: BrowserSchema.Digest,
  cancelledAt: BrowserSchema.Count,
})
export type Cancellation = typeof Cancellation.Type
export const Grant = Schema.Struct({
  version: Schema.Literal(2),
  binding: Binding,
  bindingHash: BrowserSchema.Digest,
  grantID: ID,
  instanceID: ID,
  scopeHash: BrowserSchema.Digest,
  command: Approve,
  commandHash: BrowserSchema.Digest,
  preview: Preview,
  confirmation: BrowserFileSchema.Confirmation,
  expiresAt: BrowserSchema.Revision,
  createdAt: BrowserSchema.Count,
}).check(
  Schema.makeFilter(
    (value) =>
      value.scopeHash === value.binding.scopeHash &&
      value.preview.bindingHash === value.bindingHash &&
      value.preview.scopeHash === value.scopeHash &&
      value.preview.instanceID === value.instanceID &&
      value.command.expectedLeaseID === value.binding.leaseID &&
      value.command.expectedLeaseEpoch === value.binding.leaseEpoch &&
      value.command.expectedManualEpoch === value.binding.manualEpoch &&
      value.expiresAt === value.command.expiresAt &&
      value.expiresAt > value.createdAt,
  ),
)
export type Grant = typeof Grant.Type
export const Artifact = Schema.Struct({
  version: Schema.Literal(2),
  binding: Binding,
  bindingHash: BrowserSchema.Digest,
  artifactID: ID,
  instanceID: ID,
  grantID: ID,
  grantHash: BrowserSchema.Digest,
  actionID: ID,
  admissionID: ID,
  providerReceiptID: ID,
  providerAttemptID: ID,
  toolCallID: ID,
  sessionID: ID,
  scopeHash: BrowserSchema.Digest,
  ordinal: BrowserSchema.Count.check(Schema.isLessThan(BrowserFileSchema.MAX_FILES)),
  manifest: Preview,
  state: BrowserFileSchema.ArtifactState,
  revision: BrowserSchema.Revision,
  reservedBytes: BrowserSchema.Count,
  publication: Schema.NullOr(BrowserFileSchema.Publication),
  stopConfirmedAt: Schema.NullOr(BrowserSchema.Count),
  releasedAt: Schema.NullOr(BrowserSchema.Count),
  createdAt: BrowserSchema.Count,
  updatedAt: BrowserSchema.Count,
}).check(
  Schema.makeFilter(
    (value) =>
      value.scopeHash === value.binding.scopeHash &&
      value.sessionID === value.binding.rootSessionID &&
      value.manifest.bindingHash === value.bindingHash &&
      value.manifest.scopeHash === value.scopeHash &&
      value.manifest.instanceID === value.instanceID &&
      value.updatedAt >= value.createdAt,
  ),
)
export type Artifact = typeof Artifact.Type
