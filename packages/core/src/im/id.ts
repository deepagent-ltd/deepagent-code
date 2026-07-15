import { Schema } from "effect"
import { withStatics } from "../schema"
import { Identifier } from "../util/identifier"

export const GroupID = Schema.String.check(Schema.isStartsWith("img_")).pipe(
  Schema.brand("IM.Group.ID"),
  withStatics((schema) => ({
    create: () => schema.make("img_" + Identifier.ascending()),
  })),
)
export type GroupID = typeof GroupID.Type

export const MemberID = Schema.String.check(Schema.isStartsWith("imm_")).pipe(
  Schema.brand("IM.Member.ID"),
  withStatics((schema) => ({
    create: () => schema.make("imm_" + Identifier.ascending()),
  })),
)
export type MemberID = typeof MemberID.Type

export const MessageID = Schema.String.check(Schema.isStartsWith("imsg_")).pipe(
  Schema.brand("IM.Message.ID"),
  withStatics((schema) => ({
    create: () => schema.make("imsg_" + Identifier.ascending()),
  })),
)
export type MessageID = typeof MessageID.Type

// V4.0 §B3/§B4 — IM file attachment id. Distinct prefix ("ima_") so an attachment id can never be
// mistaken for a group/member/message id in a shared code path.
export const AttachmentID = Schema.String.check(Schema.isStartsWith("ima_")).pipe(
  Schema.brand("IM.Attachment.ID"),
  withStatics((schema) => ({
    create: () => schema.make("ima_" + Identifier.ascending()),
  })),
)
export type AttachmentID = typeof AttachmentID.Type
