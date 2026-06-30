export * as SessionV2 from "./session"
export * from "./session/schema"

import { Cause, DateTime, Effect, Layer, Schema, Context, Stream } from "effect"
import { and, asc, desc, eq, gt, inArray, like, lt, or, type SQL } from "drizzle-orm"
import { ProjectV2 } from "./project"
import { WorkspaceV2 } from "./workspace"
import { ModelV2 } from "./model"
import { ProviderV2 } from "./provider"
import { Location } from "./location"
import { SessionMessage } from "./session/message"
import { AgentAttachment, FileAttachment, Prompt, Source } from "./session/prompt"
import { EventV2 } from "./event"
import { Database } from "./database/database"
import { SessionProjector } from "./session/projector"
import { MessageTable, PartTable, SessionMessageTable, SessionTable } from "./session/sql"
import { SessionSchema } from "./session/schema"
import { AbsolutePath, PositiveInt, RelativePath } from "./schema"
import { AgentV2 } from "./agent"
import { SessionV1 } from "./v1/session"
import { InstallationVersion } from "./installation/version"
import { Slug } from "./util/slug"
import { ProjectTable } from "./project/sql"
import path from "path"
import { fromRow } from "./session/info"
import { SessionRunner } from "./session/runner/index"
import { SessionStore } from "./session/store"
import { SessionExecution } from "./session/execution"
import { logFailure } from "./session/logging"
import { MessageDecodeError } from "./session/error"
import { SessionEvent } from "./session/event"
import { SessionInput } from "./session/input"

// get project -> project.locations
//
// get all sessions
//

// - by project
//   - by subpath
// - by workspace (home is special)

export const ListAnchor = Schema.Struct({
  id: SessionSchema.ID,
  time: Schema.Finite,
  direction: Schema.Literals(["previous", "next"]),
})
export type ListAnchor = typeof ListAnchor.Type

const ListInputBase = {
  workspaceID: WorkspaceV2.ID.pipe(Schema.optional),
  search: Schema.String.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional),
  anchor: ListAnchor.pipe(Schema.optional),
}

const ListDirectoryInput = Schema.Struct({
  ...ListInputBase,
  directory: AbsolutePath,
})

const ListProjectInput = Schema.Struct({
  ...ListInputBase,
  project: ProjectV2.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const ListAllInput = Schema.Struct(ListInputBase)

export const ListInput = Schema.Union([ListDirectoryInput, ListProjectInput, ListAllInput])
export type ListInput = typeof ListInput.Type

type CreateInput = {
  id?: SessionSchema.ID
  agent?: AgentV2.ID
  model?: ModelV2.Ref
  location: Location.Ref
}

type CompactInput = {
  sessionID: SessionSchema.ID
  prompt?: Prompt
}

type LegacyMessageWithParts = {
  info: SessionV1.Info
  parts: SessionV1.Part[]
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Session.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

export class OperationUnavailableError extends Schema.TaggedErrorClass<OperationUnavailableError>()(
  "Session.OperationUnavailableError",
  {
    operation: Schema.Literals(["move", "shell", "skill", "switchAgent", "compact", "wait"]),
  },
) {}

export { ContextSnapshotDecodeError, MessageDecodeError } from "./session/error"

export class PromptConflictError extends Schema.TaggedErrorClass<PromptConflictError>()("Session.PromptConflictError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {}

export type Error = NotFoundError | MessageDecodeError | OperationUnavailableError | PromptConflictError

const V2ConversationTypes = ["user", "synthetic", "system", "shell", "assistant", "compaction"] as const

const legacyInfo = (row: typeof MessageTable.$inferSelect) =>
  ({
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
  }) as SessionV1.Info

const legacyPart = (row: typeof PartTable.$inferSelect) =>
  ({
    ...row.data,
    id: row.id,
    messageID: row.message_id,
    sessionID: row.session_id,
  }) as SessionV1.Part

function legacyPromptSource(source?: { value: string; start: number; end: number }) {
  if (!source) return undefined
  return new Source({ text: source.value, start: source.start, end: source.end })
}

function legacyFilePromptSource(source?: SessionV1.FilePart["source"]) {
  if (!source) return undefined
  return new Source({
    text: source.text.value,
    start: source.text.start,
    end: source.text.end,
  })
}

function legacyRecord(input: unknown) {
  if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>
  return {}
}

function legacyErrorMessage(input: unknown) {
  if (input && typeof input === "object" && "message" in input && typeof input.message === "string")
    return input.message
  if (input && typeof input === "object" && "name" in input && typeof input.name === "string") return input.name
  return "Legacy error"
}

function legacyTimestamp(input: number) {
  return DateTime.makeUnsafe(input) as DateTime.Utc
}

function legacyToolState(state: SessionV1.ToolState): SessionMessage.ToolState {
  if (state.status === "pending") {
    return new SessionMessage.ToolStatePending({
      status: "pending",
      input: state.raw,
    })
  }
  if (state.status === "running") {
    return new SessionMessage.ToolStateRunning({
      status: "running",
      input: legacyRecord(state.input),
      structured: {},
      content: [],
    })
  }
  if (state.status === "completed") {
    return new SessionMessage.ToolStateCompleted({
      status: "completed",
      input: legacyRecord(state.input),
      structured: {},
      content: [],
      outputPaths: [],
      result: state.output,
    })
  }
  return new SessionMessage.ToolStateError({
    status: "error",
    input: legacyRecord(state.input),
    structured: {},
    content: [],
    error: { type: "unknown", message: state.error },
    result: state.error,
  })
}

function legacyAssistantContent(part: SessionV1.Part): SessionMessage.AssistantContent | undefined {
  if (part.type === "text") {
    return new SessionMessage.AssistantText({ type: "text", id: part.id, text: part.text })
  }
  if (part.type === "reasoning") {
    return new SessionMessage.AssistantReasoning({
      type: "reasoning",
      id: part.id,
      text: part.text,
      providerMetadata: part.metadata,
    })
  }
  if (part.type === "tool") {
    const stateTime = "time" in part.state && typeof part.state.time === "object" ? part.state.time : { start: 0 }
    return new SessionMessage.AssistantTool({
      type: "tool",
      id: part.callID,
      name: part.tool,
      provider: {
        executed: false,
        metadata: part.metadata,
      },
      state: legacyToolState(part.state),
      time: {
        created: legacyTimestamp(stateTime.start),
        completed: "end" in stateTime && typeof stateTime.end === "number" ? legacyTimestamp(stateTime.end) : undefined,
      },
    })
  }
  return undefined
}

function legacySessionMessage(input: LegacyMessageWithParts): SessionMessage.Message {
  if (input.info.role === "user") {
    const text = input.parts
      .filter((part): part is SessionV1.TextPart => part.type === "text" && part.ignored !== true)
      .map((part) => part.text)
      .join("\n")
    const files = input.parts
      .filter((part): part is SessionV1.FilePart => part.type === "file")
      .map(
        (part) =>
          new FileAttachment({
            uri: part.url,
            mime: part.mime,
            name: part.filename,
            source: legacyFilePromptSource(part.source),
          }),
      )
    const agents = input.parts
      .filter((part): part is SessionV1.AgentPart => part.type === "agent")
      .map(
        (part) =>
          new AgentAttachment({
            name: part.name,
            source: legacyPromptSource(part.source),
          }),
      )
    return new SessionMessage.User({
      id: SessionMessage.ID.make(input.info.id),
      type: "user",
      metadata: input.info.metadata,
      text,
      files: files.length > 0 ? files : undefined,
      agents: agents.length > 0 ? agents : undefined,
      references: undefined,
      time: { created: legacyTimestamp(input.info.time.created) },
    })
  }

  const startSnapshot = input.parts.find(
    (part): part is SessionV1.StepStartPart => part.type === "step-start" && part.snapshot !== undefined,
  )?.snapshot
  const finishSnapshot = input.parts.findLast(
    (part): part is SessionV1.StepFinishPart => part.type === "step-finish" && part.snapshot !== undefined,
  )?.snapshot
  const content = input.parts
    .map(legacyAssistantContent)
    .filter((part): part is SessionMessage.AssistantContent => part !== undefined)

  return new SessionMessage.Assistant({
    id: SessionMessage.ID.make(input.info.id),
    type: "assistant",
    agent: input.info.agent,
    model: {
      id: ModelV2.ID.make(input.info.modelID),
      providerID: ProviderV2.ID.make(input.info.providerID),
      variant: input.info.variant ? ModelV2.VariantID.make(input.info.variant) : undefined,
    },
    content,
    snapshot: startSnapshot || finishSnapshot ? { start: startSnapshot, end: finishSnapshot } : undefined,
    finish: input.info.finish,
    cost: input.info.cost,
    tokens: {
      input: input.info.tokens.input,
      output: input.info.tokens.output,
      reasoning: input.info.tokens.reasoning,
      cache: input.info.tokens.cache,
    },
    error: input.info.error ? { type: "unknown", message: legacyErrorMessage(input.info.error) } : undefined,
    time: {
      created: legacyTimestamp(input.info.time.created),
      completed: input.info.time.completed === undefined ? undefined : legacyTimestamp(input.info.time.completed),
    },
  })
}

function compareMessageTime(left: SessionMessage.Message, right: SessionMessage.Message) {
  const diff = DateTime.toEpochMillis(left.time.created) - DateTime.toEpochMillis(right.time.created)
  if (diff !== 0) return diff
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<SessionSchema.Info[]>
  readonly create: (input: CreateInput) => Effect.Effect<SessionSchema.Info>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly messages: (input: {
    sessionID: SessionSchema.ID
    limit?: number
    order?: "asc" | "desc"
    cursor?: {
      id: SessionMessage.ID
      direction: "previous" | "next"
    }
  }) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly message: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.Message | undefined>
  readonly context: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly events: (input: {
    sessionID: SessionSchema.ID
    after?: EventV2.Cursor
  }) => Stream.Stream<EventV2.CursorEvent<SessionEvent.DurableEvent>, NotFoundError>
  readonly switchAgent: (input: {
    sessionID: SessionSchema.ID
    agent: string
  }) => Effect.Effect<void, OperationUnavailableError>
  readonly switchModel: (input: {
    sessionID: SessionSchema.ID
    model: ModelV2.Ref
  }) => Effect.Effect<void, NotFoundError>
  readonly prompt: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    prompt: Prompt
    delivery?: SessionInput.Delivery
    resume?: boolean
  }) => Effect.Effect<SessionInput.Admitted, NotFoundError | PromptConflictError>
  readonly shell: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    command: string
    resume?: boolean
  }) => Effect.Effect<void, OperationUnavailableError>
  readonly skill: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    skill: string
    resume?: boolean
  }) => Effect.Effect<void, OperationUnavailableError>
  readonly compact: (input: CompactInput) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
  readonly wait: (id: SessionSchema.ID) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | SessionRunner.RunError>
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/v2/Session") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service
    const execution = yield* SessionExecution.Service
    const store = yield* SessionStore.Service
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)
    const isDurableSessionEvent = Schema.is(SessionEvent.Durable)
    const scope = yield* Effect.scope

    const enqueueWake = (admitted: SessionInput.Admitted) =>
      execution.wake(admitted.sessionID, admitted.admittedSeq).pipe(
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : logFailure("Failed to wake Session", admitted.sessionID, cause),
        ),
        Effect.ignore,
        Effect.forkIn(scope, { startImmediately: true }),
        Effect.asVoid,
      )

    const decode = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(
        Effect.mapError(
          () =>
            new MessageDecodeError({
              sessionID: SessionSchema.ID.make(row.session_id),
              messageID: SessionMessage.ID.make(row.id),
            }),
        ),
      )

    const legacyRecoveryMessages = Effect.fn("V2Session.legacyRecoveryMessages")(function* (input: {
      sessionID: SessionSchema.ID
      limit?: number
      order?: "asc" | "desc"
      cursor?: {
        id: SessionMessage.ID
        direction: "previous" | "next"
      }
    }) {
      const legacyRows = yield* db
        .select()
        .from(MessageTable)
        .where(eq(MessageTable.session_id, input.sessionID))
        .all()
        .pipe(Effect.orDie)
      if (legacyRows.length === 0) return undefined

      const projectedConversation = yield* db
        .select({ id: SessionMessageTable.id })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, input.sessionID),
            inArray(SessionMessageTable.type, V2ConversationTypes),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      if (projectedConversation.length > 0) return undefined

      const legacyParts =
        legacyRows.length === 0
          ? []
          : yield* db
              .select()
              .from(PartTable)
              .where(
                inArray(
                  PartTable.message_id,
                  legacyRows.map((row) => row.id),
                ),
              )
              .orderBy(PartTable.message_id, PartTable.id)
              .all()
              .pipe(Effect.orDie)
      const partByMessage = new Map<string, SessionV1.Part[]>()
      for (const row of legacyParts) {
        const next = legacyPart(row)
        const current = partByMessage.get(row.message_id)
        if (current) current.push(next)
        else partByMessage.set(row.message_id, [next])
      }

      const projectedRows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, input.sessionID))
        .all()
        .pipe(Effect.orDie)
      const recovered = new Map<string, SessionMessage.Message>()
      for (const message of yield* Effect.forEach(projectedRows, decode)) {
        recovered.set(message.id, message)
      }
      for (const row of legacyRows) {
        const message = legacySessionMessage({ info: legacyInfo(row), parts: partByMessage.get(row.id) ?? [] })
        if (!recovered.has(message.id)) recovered.set(message.id, message)
      }

      const direction = input.cursor?.direction ?? "next"
      const requestedOrder = input.order ?? "desc"
      const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
      const all = [...recovered.values()]
      const anchor = input.cursor ? all.find((message) => message.id === input.cursor?.id) : undefined
      if (input.cursor && !anchor) return []

      const sorted = all
        .filter((message) => {
          if (!anchor) return true
          const compared = compareMessageTime(message, anchor)
          return order === "asc" ? compared > 0 : compared < 0
        })
        .sort((left, right) => (order === "asc" ? compareMessageTime(left, right) : compareMessageTime(right, left)))
      const limited = input.limit === undefined ? sorted : sorted.slice(0, input.limit)
      return direction === "previous" ? limited.toReversed() : limited
    })

    const result = Service.of({
      create: Effect.fn("V2Session.create")(function* (input) {
        const sessionID = input.id ?? SessionSchema.ID.create()
        const recorded = yield* store.get(sessionID)
        if (recorded) return recorded
        const project = yield* projects.resolve(input.location.directory)
        yield* db
          .insert(ProjectTable)
          .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const now = Date.now()
        const info = SessionV1.SessionInfo.make({
          id: sessionID,
          slug: Slug.create(),
          version: InstallationVersion,
          projectID: project.id,
          directory: input.location.directory,
          path: path.relative(project.directory, input.location.directory).replaceAll("\\", "/"),
          workspaceID: input.location.workspaceID ? WorkspaceV2.ID.make(input.location.workspaceID) : undefined,
          title: `New session - ${new Date(now).toISOString()}`,
          agent: input.agent,
          model: input.model
            ? {
                id: ModelV2.ID.make(input.model.id),
                providerID: input.model.providerID,
                variant: input.model.variant,
              }
            : undefined,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        })
        const projected = yield* events
          .publish(SessionV1.Event.Created, { sessionID, info }, { location: input.location })
          .pipe(
            Effect.as({ type: "created" } as const),
            Effect.catchDefect((defect) => {
              if (!(defect instanceof SessionProjector.SessionAlreadyProjected)) {
                return Effect.die(defect)
              }
              // Concurrent creation lost the projection race. The existing Session identity wins.
              return store
                .get(sessionID)
                .pipe(
                  Effect.flatMap((session) =>
                    session ? Effect.succeed({ type: "existing", session } as const) : Effect.die(defect),
                  ),
                )
            }),
          )
        if (projected.type === "existing") return projected.session
        // TODO: Restore recorded sessions onto replacement synchronized workspaces in a future API slice.
        return yield* result.get(sessionID).pipe(Effect.orDie)
      }),
      get: Effect.fn("V2Session.get")(function* (sessionID) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* new NotFoundError({ sessionID })
        return session
      }),
      list: Effect.fn("V2Session.list")(function* (input = {}) {
        const direction = input.anchor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const sortColumn = SessionTable.time_created
        const conditions: SQL[] = []
        if ("directory" in input) conditions.push(eq(SessionTable.directory, input.directory))
        if (input.workspaceID) conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
        if ("project" in input) conditions.push(eq(SessionTable.project_id, input.project))
        if (input.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
        if (input.anchor) {
          conditions.push(
            order === "asc"
              ? or(
                  gt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), gt(SessionTable.id, input.anchor.id)),
                )!
              : or(
                  lt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), lt(SessionTable.id, input.anchor.id)),
                )!,
          )
        }
        const query = db
          .select()
          .from(SessionTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            order === "asc" ? asc(sortColumn) : desc(sortColumn),
            order === "asc" ? asc(SessionTable.id) : desc(SessionTable.id),
          )
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return (direction === "previous" ? rows.toReversed() : rows).map((row) => fromRow(row))
      }),
      messages: Effect.fn("V2Session.messages")(function* (input) {
        yield* result.get(input.sessionID)
        const recovered = yield* legacyRecoveryMessages(input)
        if (recovered) return recovered

        const direction = input.cursor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const anchor = input.cursor
          ? yield* db
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(
                and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.cursor.id)),
              )
              .get()
              .pipe(Effect.orDie)
          : undefined
        if (input.cursor && !anchor) return []
        const boundary = anchor
          ? order === "asc"
            ? gt(SessionMessageTable.seq, anchor.seq)
            : lt(SessionMessageTable.seq, anchor.seq)
          : undefined
        const where = boundary
          ? and(eq(SessionMessageTable.session_id, input.sessionID), boundary)
          : eq(SessionMessageTable.session_id, input.sessionID)
        const query = db
          .select()
          .from(SessionMessageTable)
          .where(where)
          .orderBy(order === "asc" ? asc(SessionMessageTable.seq) : desc(SessionMessageTable.seq))
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return yield* Effect.forEach(direction === "previous" ? rows.toReversed() : rows, decode)
      }),
      message: Effect.fn("V2Session.message")(function* (input) {
        const stored = yield* store.message(input.messageID)
        return stored?.sessionID === input.sessionID ? stored.message : undefined
      }),
      context: Effect.fn("V2Session.context")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* store.context(sessionID)
      }),
      events: (input) =>
        Stream.unwrap(
          result
            .get(input.sessionID)
            .pipe(Effect.as(events.aggregateEvents({ aggregateID: input.sessionID, after: input.after }))),
        ).pipe(
          Stream.filter((event): event is EventV2.CursorEvent<SessionEvent.DurableEvent> =>
            isDurableSessionEvent(event.event),
          ),
        ),
      prompt: Effect.fn("V2Session.prompt")((input) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            yield* result.get(input.sessionID)
            const returnPrompt = Effect.fnUntraced(function* (admitted: SessionInput.Admitted) {
              if (input.resume !== false) yield* enqueueWake(admitted)
              return admitted
            }, Effect.uninterruptible)
            const messageID = input.id ?? SessionMessage.ID.create()
            const delivery = input.delivery ?? "steer"
            const expected = { sessionID: input.sessionID, messageID, prompt: input.prompt, delivery }
            const admitted = yield* SessionInput.admit(db, events, {
              id: messageID,
              sessionID: input.sessionID,
              prompt: input.prompt,
              delivery,
            }).pipe(
              Effect.catchDefect((defect) =>
                defect instanceof SessionInput.LifecycleConflict
                  ? new PromptConflictError({ sessionID: input.sessionID, messageID })
                  : Effect.die(defect),
              ),
            )
            if (!SessionInput.equivalent(admitted, expected))
              return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
            return yield* returnPrompt(admitted)
          }),
        ),
      ),
      shell: Effect.fn("V2Session.shell")(function* () {
        return yield* new OperationUnavailableError({ operation: "shell" })
      }),
      skill: Effect.fn("V2Session.skill")(function* () {
        return yield* new OperationUnavailableError({ operation: "skill" })
      }),
      switchAgent: Effect.fn("V2Session.switchAgent")(function* () {
        return yield* new OperationUnavailableError({ operation: "switchAgent" })
      }),
      switchModel: Effect.fn("V2Session.switchModel")(function* (input) {
        yield* result.get(input.sessionID)
        yield* events.publish(SessionEvent.ModelSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          model: input.model,
        })
      }),
      compact: Effect.fn("V2Session.compact")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* new OperationUnavailableError({ operation: "compact" })
      }),
      wait: Effect.fn("V2Session.wait")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* new OperationUnavailableError({ operation: "wait" })
      }),
      resume: Effect.fn("V2Session.resume")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* execution.resume(sessionID)
      }),
      interrupt: Effect.fn("V2Session.interrupt")((sessionID) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const session = yield* store.get(sessionID)
            if (!session) return yield* execution.interrupt(sessionID)
            const event = yield* events.publish(SessionEvent.InterruptRequested, {
              sessionID,
              timestamp: yield* DateTime.now,
            })
            if (event.seq === undefined)
              return yield* Effect.die("Interrupt request event is missing aggregate sequence")
            yield* execution.interrupt(sessionID, event.seq)
          }),
        ),
      ),
    })

    return result
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(SessionExecution.noopLayer),
  Layer.provide(SessionStore.defaultLayer),
  Layer.provide(SessionProjector.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(ProjectV2.defaultLayer),
  Layer.orDie,
)
