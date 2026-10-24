export * as SharedBrowserTuiSchema from "./shared-tui-schema"

import { Schema } from "effect"
import { BrowserSchema } from "./schema"
import { SharedBrowserSchema } from "./shared-schema"

export const MAX_PENDING = 16
export const PENDING_MS = 60_000
export const MAX_ACTIVE = 8
export const MAX_PER_SOURCE = 4
export const MAX_WAITING = 32
export const MAX_INPUT_BYTES = 1_048_576
const Directory = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))
const RawInput = Schema.String.check(
  Schema.isMaxLength(MAX_INPUT_BYTES),
  Schema.makeFilter((value) => new TextEncoder().encode(value).byteLength <= MAX_INPUT_BYTES),
)
export const Pair = Schema.Struct({
  requestID: BrowserSchema.ID,
  challengeHash: BrowserSchema.Digest,
  rootSessionID: BrowserSchema.ID,
  directory: Directory,
})
export type Pair = typeof Pair.Type
export const View = Schema.Struct({
  ...Pair.fields,
  attachID: BrowserSchema.ID,
  generation: BrowserSchema.ID,
  pendingUntil: BrowserSchema.Count,
  state: Schema.Literals(["pending", "active", "retired"]),
  streamLive: Schema.Boolean,
  barrierOrder: BrowserSchema.Count,
})
export type View = typeof View.Type
export const Approve = Schema.Struct({
  ...Pair.fields,
  attachID: BrowserSchema.ID,
  expectedGeneration: BrowserSchema.ID,
})
export type Approve = typeof Approve.Type
export const Connect = Schema.Struct({
  attachID: BrowserSchema.ID,
  generation: BrowserSchema.ID,
  secret: BrowserSchema.Digest,
})
export type Connect = typeof Connect.Type
export const Reserve = Schema.Struct({
  ...Connect.fields,
  expectedBarrierOrder: BrowserSchema.Count,
  inputID: BrowserSchema.ID,
  originalSubmissionID: BrowserSchema.ID,
  rawInput: RawInput,
})
export type Reserve = typeof Reserve.Type
export const Seal = Schema.Struct({
  ...Connect.fields,
  stamp: SharedBrowserSchema.InputStamp,
  prompt: Schema.Unknown,
})
export type Seal = typeof Seal.Type
export const Detach = Connect
export type Detach = typeof Detach.Type
// Constructed only by the actual utility listener and private bootstrap, never decoded
// from a public HTTP body. Main verifies serverURL against its actual ready server.
export const Transport = Schema.Struct({
  hostIncarnation: BrowserSchema.ID,
  credentialBinding: BrowserSchema.Digest,
  serverURL: BrowserSchema.Address,
})
export type Transport = typeof Transport.Type
export const StreamBinding = Schema.Struct({
  attachID: BrowserSchema.ID,
  generation: BrowserSchema.ID,
  streamID: BrowserSchema.ID,
})
export type StreamBinding = typeof StreamBinding.Type
export const State = Schema.Struct({
  type: Schema.Literal("shared.tui.state"),
  ...StreamBinding.fields,
  view: View,
})
export type State = typeof State.Type
