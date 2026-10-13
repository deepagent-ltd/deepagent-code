export * as BrowserProtocol from "./protocol"

import { Schema } from "effect"
import { BrowserSchema } from "./schema"
import { BrowserFileSchema } from "./file-exchange.schema"

// Private utility-process wire only. Public HTTP exposes no action dispatch endpoint.
export const Bootstrap = Schema.Struct({ type: Schema.Literal("managed-browser-install-v1"),
  hostID: BrowserSchema.ID, hostIncarnation: BrowserSchema.ID, username: BrowserSchema.ID,
  credentialBinding: BrowserSchema.Digest, credentialKey: BrowserSchema.Digest })
export const Request = Schema.Union([
  Schema.Struct({ type: Schema.Literal("create"), id: BrowserSchema.ID, control: BrowserSchema.Control }),
  Schema.Struct({ type: Schema.Literal("cancel"), id: BrowserSchema.ID, control: BrowserSchema.Control }),
  Schema.Struct({ type: Schema.Literal("execute"), id: BrowserSchema.ID, control: BrowserSchema.Control, action: BrowserSchema.Action,
    files: Schema.optional(Schema.Array(Schema.Struct({ grant: BrowserFileSchema.Grant, artifact: BrowserFileSchema.Artifact })).check(Schema.isMaxLength(4))) }),
  Schema.Struct({ type: Schema.Literal("file.confirm"), id: BrowserSchema.ID, control: BrowserSchema.Control,
    preview: BrowserFileSchema.Preview, command: BrowserFileSchema.Approve }),
])
export type Request = typeof Request.Type
export const Response = Schema.Struct({ type: Schema.Literal("response"), id: BrowserSchema.ID,
  error: Schema.optional(BrowserSchema.ErrorCode), stopped: Schema.optional(Schema.Boolean),
  result: Schema.optional(BrowserSchema.Result),
  confirmation: Schema.optional(BrowserFileSchema.Confirmation),
  png: Schema.optional(Schema.String.check(Schema.isMaxLength(Math.ceil(BrowserSchema.MAX_PNG_BYTES / 3) * 4))),
})
export type Response = typeof Response.Type
export const Check = Schema.Struct({ type: Schema.Literal("check"), id: BrowserSchema.ID,
  actionID: BrowserSchema.ID, controlID: BrowserSchema.ID, digest: BrowserSchema.Digest })
export const Permit = Schema.Struct({ type: Schema.Literal("permit"), id: BrowserSchema.ID,
  allowed: Schema.Boolean })

const LeafFields = { type: Schema.Literal("file.leaf"), id: BrowserSchema.ID, executeID: BrowserSchema.ID,
  actionID: BrowserSchema.ID, controlID: BrowserSchema.ID, digest: BrowserSchema.Digest, artifactID: BrowserFileSchema.ID }
const Base64Chunk = Schema.String.check(Schema.isMaxLength(Math.ceil(BrowserFileSchema.CHUNK_BYTES / 3) * 4),
  Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/),
  Schema.makeFilter((value) => value.length % 4 === 0 &&
    value.length / 4 * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0) <= BrowserFileSchema.CHUNK_BYTES))
export const FileLeaf = Schema.Union([
  Schema.Struct({ ...LeafFields, operation: Schema.Literal("upload.read"), offset: BrowserFileSchema.Count,
    length: BrowserFileSchema.Revision.check(Schema.isLessThanOrEqualTo(BrowserFileSchema.CHUNK_BYTES)) }),
  Schema.Struct({ ...LeafFields, operation: Schema.Literals(["upload.seal", "upload.observe", "download.publish"]),
    bytes: BrowserFileSchema.FileBytes, sha256: BrowserFileSchema.Digest }),
  Schema.Struct({ ...LeafFields, operation: Schema.Literal("download.write"), offset: BrowserFileSchema.Count, payload: Base64Chunk }),
])
export type FileLeaf = typeof FileLeaf.Type
export const FileLeafResponse = Schema.Struct({ type: Schema.Literal("file.leaf.response"), id: BrowserSchema.ID,
  error: Schema.optional(Schema.Literals(BrowserFileSchema.ErrorCodes)), payload: Schema.optional(Base64Chunk),
  publication: Schema.optional(BrowserFileSchema.Publication) })
export type FileLeafResponse = typeof FileLeafResponse.Type
export const FileCheck = Schema.Struct({ type: Schema.Literal("file.check"), id: BrowserSchema.ID,
  confirmID: BrowserSchema.ID, controlID: BrowserSchema.ID, previewHash: BrowserSchema.Digest, commandHash: BrowserSchema.Digest })

export const Closed = Schema.Struct({ type: Schema.Literal("closed"), controlID: BrowserSchema.ID,
  resourceID: BrowserSchema.ID, hostIncarnation: BrowserSchema.ID })
