export * as IMTaskStatusNotice from "./task-status-notice"
export * as IMTaskStatusNoticeHost from "./task-status-notice"

import { Context, Effect, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { IMTaskStatusNotice } from "@deepagent-code/core/im/task-status-notice"
import { IMTaskStatusNoticeSchema } from "@deepagent-code/core/im/task-status-notice.schema"
import type { WorkAuthority } from "@deepagent-code/core/session/work-authority"

const unavailable = () => Effect.fail(new IMTaskStatusNoticeSchema.Error({ code: "TASK_NOTICE_UNAVAILABLE", message: "Restricted IM status production is retired" }))

/** Historical notices are read without source recapture or outbox writes. */
export const make = Effect.gen(function* () {
  const database = yield* Database.Service
  return {
    read: (noticeID: string) => IMTaskStatusNotice.read(database.db, noticeID),
    refuse: (_input: IMTaskStatusNoticeSchema.RefuseInput): Effect.Effect<IMTaskStatusNoticeSchema.RefuseReceipt, IMTaskStatusNoticeSchema.Error> => unavailable(),
    prepare: (_noticeID: string): Effect.Effect<object, IMTaskStatusNoticeSchema.Error> => unavailable(),
    verify: (_tx: WorkAuthority.Transaction, _input: { noticeID: string; original: object }): Effect.Effect<IMTaskStatusNoticeSchema.Notice, IMTaskStatusNoticeSchema.Error> => unavailable(),
    collectPass: unavailable(),
  }
})
export type Interface = Effect.Success<typeof make>
export class Service extends Context.Service<Service, Interface>()("@deepagent-code/im/TaskStatusNotice") {}
export const layer = Layer.effect(Service, make)
