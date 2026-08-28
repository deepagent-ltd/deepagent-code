import { Deferred, Effect, Layer, Schema, Context } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { SessionID, MessageID } from "@/session/schema"
import * as Log from "@deepagent-code/core/util/log"
import { QuestionID } from "./schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@deepagent-code/core/event"
import { EventRouteRef, type EventRoute } from "@/effect/instance-ref"
import { FSUtil } from "@deepagent-code/core/fs-util"
import type { InstanceContext } from "@/project/instance-context"

const log = Log.create({ service: "question" })

// Schemas — these are pure data; nothing checks class identity (see PR
// description) so they're plain `Schema.Struct` + type alias. That lets
// `Question.ask` and other internal sites trust the type contract without a
// re-decode to coerce nested class instances.

export const Option = Schema.Struct({
  label: Schema.String.annotate({
    description: "Display text (1-5 words, concise)",
  }),
  description: Schema.String.annotate({
    description: "Explanation of choice",
  }),
}).annotate({ identifier: "QuestionOption" })
export type Option = Schema.Schema.Type<typeof Option>

const base = {
  question: Schema.String.annotate({
    description: "Complete question",
  }),
  header: Schema.String.annotate({
    description: "Very short label (max 30 chars)",
  }),
  options: Schema.Array(Option).annotate({
    description: "Available choices",
  }),
  multiple: Schema.optional(Schema.Boolean).annotate({
    description: "Allow selecting multiple choices",
  }),
}

export const Info = Schema.Struct({
  ...base,
  custom: Schema.optional(Schema.Boolean).annotate({
    description: "Allow typing a custom answer (default: true)",
  }),
}).annotate({ identifier: "QuestionInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export const Prompt = Schema.Struct(base).annotate({ identifier: "QuestionPrompt" })
export type Prompt = Schema.Schema.Type<typeof Prompt>

export const Tool = Schema.Struct({
  messageID: MessageID,
  callID: Schema.String,
}).annotate({ identifier: "QuestionTool" })
export type Tool = Schema.Schema.Type<typeof Tool>

export const Request = Schema.Struct({
  id: QuestionID,
  sessionID: SessionID,
  questions: Schema.Array(Info).annotate({
    description: "Questions to ask",
  }),
  tool: Schema.optional(Tool),
}).annotate({ identifier: "QuestionRequest" })
export type Request = Schema.Schema.Type<typeof Request>

export const Answer = Schema.Array(Schema.String).annotate({ identifier: "QuestionAnswer" })
export type Answer = Schema.Schema.Type<typeof Answer>

export const Reply = Schema.Struct({
  answers: Schema.Array(Answer).annotate({
    description: "User answers in order of questions (each answer is an array of selected labels)",
  }),
}).annotate({ identifier: "QuestionReply" })
export type Reply = Schema.Schema.Type<typeof Reply>

export const Replied = Schema.Struct({
  sessionID: SessionID,
  requestID: QuestionID,
  answers: Schema.Array(Answer),
}).annotate({ identifier: "QuestionReplied" })

export const Rejected = Schema.Struct({
  sessionID: SessionID,
  requestID: QuestionID,
}).annotate({ identifier: "QuestionRejected" })

export const Event = {
  Asked: EventV2.define({ type: "question.asked", schema: Request.fields }),
  Replied: EventV2.define({ type: "question.replied", schema: Replied.fields }),
  Rejected: EventV2.define({ type: "question.rejected", schema: Rejected.fields }),
}

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("QuestionRejectedError", {}) {
  override get message() {
    return "The user dismissed this question"
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Question.NotFoundError", {
  requestID: QuestionID,
}) {}

interface PendingEntry {
  info: Request
  deferred: Deferred.Deferred<ReadonlyArray<Answer>, RejectedError>
  owner: State
  origin: InstanceContext
  route: EventRoute
}

interface State {
  pending: Map<QuestionID, PendingEntry>
}

// Service

export interface Interface {
  readonly ask: (input: {
    sessionID: SessionID
    questions: ReadonlyArray<Info>
    tool?: Tool
  }) => Effect.Effect<ReadonlyArray<Answer>, RejectedError>
  readonly reply: (input: {
    requestID: QuestionID
    answers: ReadonlyArray<Answer>
  }) => Effect.Effect<void, NotFoundError>
  readonly reject: (requestID: QuestionID) => Effect.Effect<void, NotFoundError>
  readonly rejectSession: (sessionID: SessionID) => Effect.Effect<void>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/Question") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const allPending = new Map<QuestionID, PendingEntry>()
    const removePending = (id: QuestionID, entry: PendingEntry) => {
      if (allPending.get(id) !== entry) return false
      allPending.delete(id)
      entry.owner.pending.delete(id)
      return true
    }
    const visibleFrom = (entry: PendingEntry, directory: string, workspaceID: string | undefined) =>
      (entry.route.workspaceID === undefined || entry.route.workspaceID === workspaceID) &&
      (FSUtil.resolve(entry.origin.directory) === FSUtil.resolve(directory) ||
        FSUtil.resolve(entry.route.directory) === FSUtil.resolve(directory))
    const publishRejected = (entry: PendingEntry) =>
      events
        .publish(Event.Rejected, {
          sessionID: entry.info.sessionID,
          requestID: entry.info.id,
        })
        .pipe(Effect.provideService(EventRouteRef, entry.route))
    const state = yield* InstanceState.make<State>(
      Effect.fn("Question.state")(function* () {
        const state = {
          pending: new Map<QuestionID, PendingEntry>(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const [id, item] of state.pending) {
              if (!removePending(id, item)) continue
              yield* publishRejected(item)
              yield* Deferred.fail(item.deferred, new RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("Question.ask")(function* (input: {
      sessionID: SessionID
      questions: ReadonlyArray<Info>
      tool?: Tool
    }) {
      const owner = yield* InstanceState.get(state)
      const origin = yield* InstanceState.context
      const workspaceID = yield* InstanceState.workspaceID
      const route = (yield* EventRouteRef) ?? {
        ...origin,
        ...(workspaceID ? { workspaceID } : {}),
      }
      const id = QuestionID.ascending()
      log.info("asking", { id, questions: input.questions.length })

      const deferred = yield* Deferred.make<ReadonlyArray<Answer>, RejectedError>()
      const info: Request = {
        id,
        sessionID: input.sessionID,
        questions: input.questions,
        tool: input.tool,
      }
      const entry: PendingEntry = { info, deferred, owner, origin, route }
      owner.pending.set(id, entry)
      allPending.set(id, entry)
      yield* events.publish(Event.Asked, info)

      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.gen(function* () {
          // reply/reject remove the entry before resolving the Deferred. If the
          // caller is interrupted instead (for example, Session abort), no API
          // endpoint performs that cleanup, so publish the terminal event here
          // to keep renderer and CLI question stores from retaining a stale dock.
          if (!removePending(id, entry)) return
          yield* publishRejected(entry)
        }),
      )
    })

    const reply = Effect.fn("Question.reply")(function* (input: {
      requestID: QuestionID
      answers: ReadonlyArray<Answer>
    }) {
      const current = yield* InstanceState.context
      const workspaceID = yield* InstanceState.workspaceID
      const existing = allPending.get(input.requestID)
      if (!existing || !visibleFrom(existing, current.directory, workspaceID)) {
        log.warn("reply for unknown request", { requestID: input.requestID })
        return yield* new NotFoundError({ requestID: input.requestID })
      }
      removePending(input.requestID, existing)
      log.info("replied", { requestID: input.requestID, answers: input.answers })
      yield* events
        .publish(Event.Replied, {
          sessionID: existing.info.sessionID,
          requestID: existing.info.id,
          answers: input.answers.map((a) => [...a]),
        })
        .pipe(Effect.provideService(EventRouteRef, existing.route))
      yield* Deferred.succeed(existing.deferred, input.answers)
    })

    const reject = Effect.fn("Question.reject")(function* (requestID: QuestionID) {
      const current = yield* InstanceState.context
      const workspaceID = yield* InstanceState.workspaceID
      const existing = allPending.get(requestID)
      if (!existing || !visibleFrom(existing, current.directory, workspaceID)) {
        log.warn("reject for unknown request", { requestID })
        return yield* new NotFoundError({ requestID })
      }
      removePending(requestID, existing)
      log.info("rejected", { requestID })
      yield* publishRejected(existing)
      yield* Deferred.fail(existing.deferred, new RejectedError())
    })

    const rejectSession = Effect.fn("Question.rejectSession")(function* (sessionID: SessionID) {
      const current = yield* InstanceState.context
      const workspaceID = yield* InstanceState.workspaceID
      yield* Effect.forEach(
        Array.from(allPending.values()).filter(
          (item) => item.info.sessionID === sessionID && visibleFrom(item, current.directory, workspaceID),
        ),
        (item) => reject(item.info.id).pipe(Effect.catchTag("Question.NotFoundError", () => Effect.void)),
        { discard: true },
      )
    })

    const list = Effect.fn("Question.list")(function* () {
      const current = yield* InstanceState.context
      const workspaceID = yield* InstanceState.workspaceID
      return Array.from(allPending.values())
        .filter((item) => visibleFrom(item, current.directory, workspaceID))
        .map((item) => item.info)
    })

    return Service.of({ ask, reply, reject, rejectSession, list })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventV2Bridge.defaultLayer))

export * as Question from "."
