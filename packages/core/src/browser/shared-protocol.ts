export * as SharedBrowserProtocol from "./shared-protocol"

import { Schema } from "effect"
import { BrowserSchema } from "./schema"
import { SharedBrowserSchema } from "./shared-schema"
import { SharedBrowserTuiSchema } from "./shared-tui-schema"
import { SharedBrowserFileSchema } from "./shared-file-schema"
import { BrowserFileSchema } from "./file-exchange.schema"
import { BrowserProtocol } from "./protocol"
import { SharedBrowserFileBinding } from "./shared-file-binding"

// Additional private-port messages only; v1 BrowserProtocol bytes remain unchanged.
export const Request = Schema.Union([
  ...(["shared.policy.claim", "shared.policy.check", "shared.policy.abort", "shared.policy.commit"] as const).map((type) =>
    Schema.Struct({ type: Schema.Literal(type), id: BrowserSchema.ID, resource: SharedBrowserSchema.Resource,
      command: SharedBrowserSchema.ApproveOrigin, claim: Schema.optional(BrowserSchema.ID) })),
  Schema.Struct({
    type: Schema.Literal("shared.file.current"),
    id: BrowserSchema.ID,
    resource: SharedBrowserSchema.Resource,
    lease: SharedBrowserSchema.Lease,
  }),
  Schema.Struct({
    type: Schema.Literal("shared.file.confirm"),
    id: BrowserSchema.ID,
    resource: SharedBrowserSchema.Resource,
    lease: SharedBrowserSchema.Lease,
    preview: SharedBrowserFileSchema.Preview,
    command: SharedBrowserFileSchema.Approve,
  }),
  Schema.Struct({
    type: Schema.Literal("shared.file.confirm.status"),
    id: BrowserSchema.ID,
    resource: SharedBrowserSchema.Resource,
    lease: SharedBrowserSchema.Lease,
    preview: SharedBrowserFileSchema.Preview,
    command: SharedBrowserFileSchema.Approve,
  }),
  Schema.Struct({
    type: Schema.Literal("shared.tui.pair"),
    id: BrowserSchema.ID,
    input: SharedBrowserTuiSchema.Pair,
    transport: SharedBrowserTuiSchema.Transport,
  }),
  Schema.Struct({
    type: Schema.Literal("shared.tui.open"),
    id: BrowserSchema.ID,
    input: SharedBrowserTuiSchema.Connect,
    binding: SharedBrowserTuiSchema.StreamBinding,
    transport: SharedBrowserTuiSchema.Transport,
  }),
  Schema.Struct({
    type: Schema.Literal("shared.tui.disconnect"),
    id: BrowserSchema.ID,
    binding: SharedBrowserTuiSchema.StreamBinding,
  }),
  Schema.Struct({
    type: Schema.Literal("shared.tui.reserve"),
    id: BrowserSchema.ID,
    input: SharedBrowserTuiSchema.Reserve,
  }),
  Schema.Struct({ type: Schema.Literal("shared.tui.seal"), id: BrowserSchema.ID, input: SharedBrowserTuiSchema.Seal }),
  Schema.Struct({
    type: Schema.Literal("shared.tui.detach"),
    id: BrowserSchema.ID,
    input: SharedBrowserTuiSchema.Detach,
  }),
  Schema.Struct({
    type: Schema.Literal("shared.input.validate"),
    id: BrowserSchema.ID,
    stamp: SharedBrowserSchema.InputStamp,
  }),
  Schema.Struct({
    type: Schema.Literal("shared.create"),
    id: BrowserSchema.ID,
    resource: SharedBrowserSchema.Resource,
    lease: SharedBrowserSchema.Lease,
  }),
  Schema.Struct({ type: Schema.Literal("shared.status"), id: BrowserSchema.ID, resourceID: BrowserSchema.ID }),
  Schema.Struct({
    type: Schema.Literal("shared.projection.sync"),
    id: BrowserSchema.ID,
    resource: SharedBrowserSchema.Resource,
  }),
  Schema.Struct({
    type: Schema.Literal("shared.takeover"),
    id: BrowserSchema.ID,
    resource: SharedBrowserSchema.Resource,
    request: SharedBrowserSchema.Takeover,
  }),
  Schema.Struct({
    type: Schema.Literal("shared.barrier.commit"),
    id: BrowserSchema.ID,
    resource: SharedBrowserSchema.Resource,
    ticket: SharedBrowserSchema.BarrierTicket,
  }),
  Schema.Struct({
    type: Schema.Literal("shared.acquire"),
    id: BrowserSchema.ID,
    resource: SharedBrowserSchema.Resource,
    lease: SharedBrowserSchema.Lease,
    witness: SharedBrowserSchema.UserWitness,
  }),
  Schema.Struct({
    type: Schema.Literal("shared.execute"),
    id: BrowserSchema.ID,
    resource: SharedBrowserSchema.Resource,
    lease: SharedBrowserSchema.Lease,
    action: SharedBrowserSchema.Action,
    files: Schema.optional(
      Schema.Array(
        Schema.Struct({ grant: SharedBrowserFileSchema.Grant, artifact: SharedBrowserFileSchema.Artifact }),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(BrowserFileSchema.MAX_FILES)),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("shared.close"),
    id: BrowserSchema.ID,
    resource: SharedBrowserSchema.Resource,
    request: SharedBrowserSchema.Close,
  }),
])
export type Request = typeof Request.Type
export const Response = Schema.Struct({
  type: Schema.Literal("shared.response"),
  id: BrowserSchema.ID,
  validInput: Schema.optional(Schema.Boolean),
  policyClaim: Schema.optional(BrowserSchema.ID),
  fileCurrent: Schema.optional(Schema.Boolean),
  fileReady: Schema.optional(Schema.Boolean),
  confirmation: Schema.optional(BrowserFileSchema.Confirmation),
  fileCancellation: Schema.optional(SharedBrowserFileSchema.Cancellation),
  tuiView: Schema.optional(SharedBrowserTuiSchema.View),
  inputStamp: Schema.optional(SharedBrowserSchema.InputStamp),
  error: Schema.optional(BrowserSchema.ErrorCode),
  ticket: Schema.optional(SharedBrowserSchema.BarrierTicket),
  observation: Schema.optional(SharedBrowserSchema.Observation),
  result: Schema.optional(BrowserSchema.Result),
  png: Schema.optional(Schema.String.check(Schema.isMaxLength(Math.ceil(BrowserSchema.MAX_PNG_BYTES / 3) * 4))),
})
export type Response = typeof Response.Type
export const FileCheck = Schema.Struct({
  type: Schema.Literal("shared.file.check"),
  id: BrowserSchema.ID,
  confirmID: BrowserSchema.ID,
  resourceID: BrowserSchema.ID,
  mainIncarnation: BrowserSchema.ID,
  sidecarIncarnation: BrowserSchema.ID,
  leaseID: BrowserSchema.ID,
  leaseEpoch: BrowserSchema.Revision,
  manualEpoch: BrowserSchema.Count,
  bindingHash: BrowserSchema.Digest,
  previewHash: BrowserSchema.Digest,
  commandHash: BrowserSchema.Digest,
})
export type FileCheck = typeof FileCheck.Type
export const Check = Schema.Struct({
  type: Schema.Literal("shared.check"),
  id: BrowserSchema.ID,
  actionID: BrowserSchema.ID,
  resourceID: BrowserSchema.ID,
  leaseID: BrowserSchema.ID,
  leaseEpoch: BrowserSchema.Revision,
  manualEpoch: BrowserSchema.Count,
  commandHash: BrowserSchema.Digest,
})
export type Check = typeof Check.Type

/** Canonical immutable execution binding, never a live permission or Main witness. */
export function fileExecution(
  resource: SharedBrowserSchema.Resource,
  lease: SharedBrowserSchema.Lease,
  action: SharedBrowserSchema.Action,
): SharedBrowserFileSchema.Execution {
  const binding = SharedBrowserFileBinding.from(resource, lease)
  return {
    binding,
    bindingHash: SharedBrowserFileBinding.hash(binding),
    actionID: action.actionID,
    admissionID: action.admissionID,
    providerReceiptID: action.providerReceiptID,
    providerAttemptID: action.providerAttemptID,
    toolCallID: action.toolCallID,
    commandHash: action.commandHash,
    deadline: action.deadline,
  }
}
const LeafFields = {
  type: Schema.Literal("shared.file.leaf"),
  id: BrowserSchema.ID,
  executeID: BrowserSchema.ID,
  actionID: BrowserSchema.ID,
  binding: SharedBrowserFileSchema.Binding,
  executionHash: BrowserSchema.Digest,
  commandHash: BrowserSchema.Digest,
  artifactID: BrowserSchema.ID,
}
export const FileLeaf = Schema.Union([
  Schema.Struct({ ...LeafFields, operation: Schema.Literal("upload.stage") }),
  Schema.Struct({
    ...LeafFields,
    operation: Schema.Literal("upload.read"),
    offset: BrowserFileSchema.Count,
    length: BrowserFileSchema.Revision.check(Schema.isLessThanOrEqualTo(BrowserFileSchema.CHUNK_BYTES)),
  }),
  Schema.Struct({
    ...LeafFields,
    operation: Schema.Literals(["upload.seal", "upload.observe", "download.publish"]),
    bytes: BrowserFileSchema.FileBytes,
    sha256: BrowserSchema.Digest,
  }),
  Schema.Struct({
    ...LeafFields,
    operation: Schema.Literal("download.write"),
    offset: BrowserFileSchema.Count,
    payload: BrowserProtocol.Base64Chunk,
  }),
])
export type FileLeaf = typeof FileLeaf.Type
export const FileLeafResponse = Schema.Struct({
  type: Schema.Literal("shared.file.leaf.response"),
  id: BrowserSchema.ID,
  error: Schema.optional(Schema.Literals(BrowserFileSchema.ErrorCodes)),
  payload: Schema.optional(BrowserProtocol.Base64Chunk),
  publication: Schema.optional(BrowserFileSchema.Publication),
  stage: Schema.optional(BrowserProtocol.UploadStage),
})
export type FileLeafResponse = typeof FileLeafResponse.Type
