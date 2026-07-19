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
