import { Schema } from "effect"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"

export namespace SessionNotFound {
  export class Error extends Schema.TaggedErrorClass<Error>()("Session.NotFoundError", {
    sessionID: SessionSchema.ID,
  }) {}
}

export class MessageDecodeError extends Schema.TaggedErrorClass<MessageDecodeError>()("Session.MessageDecodeError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {}

export class ContextSnapshotDecodeError extends Schema.TaggedErrorClass<ContextSnapshotDecodeError>()(
  "Session.ContextSnapshotDecodeError",
  {
    sessionID: SessionSchema.ID,
    details: Schema.String,
  },
) {
  override get message() {
    return `Failed to decode context snapshot for session ${this.sessionID}: ${this.details}`
  }
}
