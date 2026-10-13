export * as IMDacSessionSchema from "./dac-session.schema"

import { Schema } from "effect"

const ID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/))
const text = Schema.String.check(Schema.makeFilter((value) => value.trim().length > 0 && !value.includes("\0") && new TextEncoder().encode(value).byteLength <= 100000))
const Placement = {
  groupID: Schema.String,
  projectID: Schema.String,
  directory: Schema.String,
  workspaceID: Schema.NullOr(Schema.String),
}

export const Submit = Schema.Struct({
  commandID: ID,
  text,
  delivery: Schema.Literals(["queue", "steer"]),
  referenceMessageIDs: Schema.optional(Schema.Array(Schema.String.check(Schema.makeFilter((value) => value.length > 0 && value.length <= 512 && !value.includes("\0")))).check(Schema.isMaxLength(32))),
  newSession: Schema.optional(Schema.Boolean),
})
export type Submit = typeof Submit.Type

export const CommandResponse = Schema.Struct({
  version: Schema.Literal(1),
  ...Placement,
  commandID: ID,
  bindingID: Schema.String,
  sessionID: Schema.String,
  inputID: Schema.String,
  delivery: Schema.Literals(["queue", "steer"]),
  state: Schema.Literals(["pending", "admitted", "rejected"]),
  activityID: Schema.NullOr(Schema.String),
  finalMessageID: Schema.NullOr(Schema.String),
  replyStatus: Schema.NullOr(Schema.Literals(["pending", "delivering", "delivered", "dead", "unknown"])),
})
export type CommandResponse = typeof CommandResponse.Type

export const BindingResponse = Schema.Struct({
  version: Schema.Literal(1),
  ...Placement,
  bindingID: Schema.NullOr(Schema.String),
  sessionID: Schema.NullOr(Schema.String),
  recentCommands: Schema.optional(Schema.Array(CommandResponse).check(Schema.isMaxLength(8))),
})
export type BindingResponse = typeof BindingResponse.Type

export class Error extends Schema.TaggedErrorClass<Error>()("IMDacSession.Error", {
  code: Schema.Literals(["command_conflict", "binding_unavailable", "reference_unavailable", "command_not_found", "admission_rejected", "reply_unavailable"]),
}) {}
