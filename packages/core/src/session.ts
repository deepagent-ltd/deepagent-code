export * as SessionV2 from "./session"
export * from "./session/schema"

import { Cause, DateTime, Effect, Exit, Layer, Option, Schema, Context, Stream } from "effect"
import { and, asc, count, desc, eq, gt, inArray, like, lt, max, notLike, or, type SQL } from "drizzle-orm"
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
import { CompactionRequest } from "./session/compaction-request"
import { SessionSchema } from "./session/schema"
import { AbsolutePath, PositiveInt, RelativePath } from "./schema"
import { AgentV2 } from "./agent"
import { SessionV1 } from "./v1/session"
import { PermissionV1 } from "./v1/permission"
import { InstallationVersion } from "./installation/version"
import { Slug } from "./util/slug"
import { ProjectTable } from "./project/sql"
import path from "path"
import { fromRow } from "./session/info"
import { SessionRunner } from "./session/runner/index"
import { SessionStore } from "./session/store"
import { SessionExecution } from "./session/execution"
import { SessionExecutionLocal } from "./session/execution/local"
import { logFailure } from "./session/logging"
import { MessageDecodeError, SessionNotFound } from "./session/error"
import { SessionEvent } from "./session/event"
import { SessionInput } from "./session/input"
import { PermissionV2 } from "./permission"
import { PluginBoot } from "./plugin/boot"
import { LocationServiceMap } from "./location-layer"

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
  // Internal infrastructure sessions (learning reviewer) are hidden unless explicitly requested.
  includeInternal: Schema.Boolean.pipe(Schema.optional),
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
  parentID?: SessionSchema.ID
  title?: string
  metadata?: SessionSchema.Metadata
  agent?: AgentV2.ID
  model?: ModelV2.Ref
  permissions?: PermissionV2.Ruleset
  location: Location.Ref
}

export function permissionsFromLegacy(ruleset?: PermissionV1.Ruleset): PermissionV2.Ruleset {
  return (ruleset ?? []).map((rule) => ({
    action: rule.permission,
    resource: rule.pattern,
    effect: rule.action,
  }))
}

type CompactInput = {
  sessionID: SessionSchema.ID
  prompt?: Prompt
  model?: { readonly providerID: ProviderV2.ID; readonly modelID: ModelV2.ID }
  agent?: AgentV2.ID
  auto?: boolean
}

type LegacyMessageWithParts = {
  info: SessionV1.Info
  parts: SessionV1.Part[]
}

export const NotFoundError = SessionNotFound.Error

// W0-2 — host seam for the projection-layer manual shell (spawn + V1 wire mirror; see the
// shell entry above for the classification rationale).
export type ShellExchange = {
  readonly sessionID: SessionSchema.ID
  readonly command: string
  readonly agent?: AgentV2.ID
  readonly model?: ModelV2.Ref
}
export const CurrentManualShell = Context.Reference<
  ((input: ShellExchange) => Effect.Effect<void, unknown>) | undefined
>("@deepagent-code/v2/SessionV2/CurrentManualShell", { defaultValue: () => undefined })

export type NotFoundError = SessionNotFound.Error

/**
 * A manual (user-initiated) Session control that the wired core services cannot serve yet. Typed,
 * never a silent no-op: callers and the UI surface the `reason` directly. `operation` stays the
 * coarse command name; `reason` states the concrete gap (e.g. manual shell execution is not wired
 * into the V2 runner) so a refusal is distinguishable from an unknown command.
 */
export class OperationUnavailableError extends Schema.TaggedErrorClass<OperationUnavailableError>()(
  "Session.OperationUnavailableError",
  {
    operation: Schema.Literals(["move", "shell", "skill", "switchAgent", "compact", "wait"]),
    reason: Schema.String,
  },
) {}

export { ContextSnapshotDecodeError, MessageDecodeError } from "./session/error"

export class PromptConflictError extends Schema.TaggedErrorClass<PromptConflictError>()("Session.PromptConflictError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {}

/** A V1-only row is readable but cannot enter the V2 write authority without audited adoption. */
export class LegacySessionRequiresAdoption extends Schema.TaggedErrorClass<LegacySessionRequiresAdoption>()(
  "Session.LegacySessionRequiresAdoption",
  { sessionID: SessionSchema.ID, code: Schema.Literal("legacy_session_requires_adoption") },
) {}

/**
 * The requested agent exists in the Location roster but is not directly selectable for a Session
 * (`mode: "subagent"` or `hidden` — the same rule AgentV2 applies when selecting the default agent).
 * Internal agents (goal-worker, compaction, title, summary) are driven by name by their owning
 * machinery; admitting one as a user-selected Session agent would strand the Session on an agent the
 * per-turn default-resolution can never pick.
 */
export class AgentNotSelectableError extends Schema.TaggedErrorClass<AgentNotSelectableError>()(
  "Session.AgentNotSelectableError",
  { id: AgentV2.ID },
) {}

export type Error =
  | NotFoundError
  | MessageDecodeError
  | OperationUnavailableError
  | PromptConflictError
  | AgentNotSelectableError
  | AgentV2.NotFoundError

// W4-6 — the canonical V2→V1 wire converters now live in session/legacy-wire.ts (extracted so
// the core projector can import them without a module cycle; these re-exports keep the host
// call sites' SessionV2.legacyAssistant / SessionV2.legacyUser spelling).
export { legacyAssistant, legacyUser } from "./session/legacy-wire"

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
  readonly create: (
    input: CreateInput,
  ) => Effect.Effect<SessionSchema.Info, AgentV2.NotFoundError | AgentNotSelectableError>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly requireWritable: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionSchema.Info, NotFoundError | LegacySessionRequiresAdoption>
  readonly update: (input: {
    sessionID: SessionSchema.ID
    title?: string
    metadata?: SessionSchema.Metadata | null
    permissions?: PermissionV2.Ruleset
    archived?: number | null
  }) => Effect.Effect<SessionSchema.Info, NotFoundError | LegacySessionRequiresAdoption>
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
  }) => Effect.Effect<
    void,
    NotFoundError | LegacySessionRequiresAdoption | AgentV2.NotFoundError | AgentNotSelectableError
  >
  readonly switchModel: (input: {
    sessionID: SessionSchema.ID
    model: ModelV2.Ref
  }) => Effect.Effect<void, NotFoundError | LegacySessionRequiresAdoption>
  readonly setPermissions: (input: {
    sessionID: SessionSchema.ID
    permissions: PermissionV2.Ruleset
  }) => Effect.Effect<void, NotFoundError | LegacySessionRequiresAdoption>
  readonly setArchived: (
    input: { sessionID: SessionSchema.ID; archived: boolean },
  ) => Effect.Effect<void, NotFoundError | LegacySessionRequiresAdoption>
  readonly prompt: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    prompt: Prompt
    delivery?: SessionInput.Delivery
    resume?: boolean
    revertEpoch?: number
  }) => Effect.Effect<
    SessionInput.Admitted,
    | NotFoundError
    | LegacySessionRequiresAdoption
    | PromptConflictError
    | SessionInput.StaleRevertEpoch
    | AgentV2.NotFoundError
    | AgentNotSelectableError
  >
  readonly shell: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    command: string
    resume?: boolean
  }) => Effect.Effect<void, NotFoundError | LegacySessionRequiresAdoption | OperationUnavailableError>
  readonly skill: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    skill: string
    resume?: boolean
  }) => Effect.Effect<void, NotFoundError | LegacySessionRequiresAdoption | OperationUnavailableError>
  readonly compact: (
    input: CompactInput,
  ) => Effect.Effect<void, NotFoundError | LegacySessionRequiresAdoption | OperationUnavailableError>
  readonly wait: (id: SessionSchema.ID) => Effect.Effect<void, NotFoundError | SessionRunner.RunError>
  readonly resume: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<void, NotFoundError | LegacySessionRequiresAdoption | SessionRunner.RunError>
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void, LegacySessionRequiresAdoption | Error>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/v2/Session") {}

/** RI-18: bounded await for a manual compaction request's terminal state. */
const MANUAL_COMPACTION_DEADLINE_MS = 10 * 60_000

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service
    const execution = yield* SessionExecution.Service
    const store = yield* SessionStore.Service
    const locations = yield* Effect.serviceOption(LocationServiceMap)
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

    // RI-04 — admission-side agent validation for create/switchAgent. The roster is Location-scoped
    // and populated asynchronously by PluginBoot (forkScoped at boot), so the check AWAITS boot
    // before resolving: an id missing after a completed boot is a confirmed miss, never a
    // startup-race guess, and an agent registered late during boot still admits. A composition
    // without a LocationServiceMap (unit tests, noop execution) skips the check — the runner's
    // per-turn AgentV2.NotFoundError stays the last defense there. The selectable rule mirrors
    // AgentV2's own default-selection rule (not subagent, not hidden). Delegated children
    // (`parentID` set — the Core `task` tool's subagent spawns) intentionally bypass ONLY the
    // selectable half: subagent-mode/hidden agents are the point of delegation, but an unknown id
    // still fails at admission.
    const requireAdmissionAgent = Effect.fn("V2Session.requireAdmissionAgent")(function* (
      location: Location.Ref,
      agent: AgentV2.ID,
      selectable: boolean,
    ) {
      if (Option.isNone(locations)) return
      const services = yield* Effect.all({
        boot: Effect.serviceOption(PluginBoot.Service),
        agents: Effect.serviceOption(AgentV2.Service),
      }).pipe(Effect.provide(locations.value.get(location)))
      if (Option.isNone(services.agents)) return
      if (Option.isSome(services.boot)) yield* services.boot.value.wait()
      const resolved = yield* services.agents.value.resolve(agent)
      if (resolved === undefined) return yield* new AgentV2.NotFoundError({ id: agent })
      if (selectable && (resolved.mode === "subagent" || resolved.hidden))
        return yield* new AgentNotSelectableError({ id: agent })
    })

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
        // RI-04 — validate the requested agent against the Location roster BEFORE projecting the
        // created Session. Adopted/existing Sessions return above without re-validation. Root
        // creates require a selectable agent; delegated children (parentID set, e.g. the Core
        // `task` tool) may name subagent-mode/hidden agents but not unknown ones.
        if (input.agent !== undefined)
          yield* requireAdmissionAgent(input.location, input.agent, input.parentID === undefined)
        const project = yield* projects.resolve(input.location.directory)
        yield* db
          .insert(ProjectTable)
          .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const now = Date.now()
        const subpath = path.relative(project.directory, input.location.directory).replaceAll("\\", "/")
        const info = SessionSchema.Info.make({
          id: sessionID,
          parentID: input.parentID,
          projectID: project.id,
          title: input.title ?? `New session - ${new Date(now).toISOString()}`,
          metadata: input.metadata,
          agent: input.agent,
          permissions: input.permissions ?? [],
          model: input.model,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: DateTime.makeUnsafe(now), updated: DateTime.makeUnsafe(now) },
          location: input.location,
          subpath: subpath ? RelativePath.make(subpath) : undefined,
        })
        const projected = yield* events
          .publish(
            SessionEvent.Created,
            { sessionID, info, slug: Slug.create(), version: InstallationVersion },
            { location: input.location },
          )
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
      requireWritable: Effect.fn("V2Session.requireWritable")(function* (sessionID) {
        const row = yield* db
          .select({ v2Authority: SessionTable.v2_authority })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* new NotFoundError({ sessionID })
        if (!row.v2Authority)
          return yield* new LegacySessionRequiresAdoption({ sessionID, code: "legacy_session_requires_adoption" })
        return yield* result.get(sessionID)
      }),
      update: Effect.fn("V2Session.update")(function* (input) {
        yield* result.requireWritable(input.sessionID)
        const row = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, input.sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* new NotFoundError({ sessionID: input.sessionID })
        const current = fromRow(row)
        const info = SessionSchema.Info.make({
          ...current,
          title: input.title ?? current.title,
          metadata: input.metadata === undefined ? current.metadata : (input.metadata ?? undefined),
          permissions: input.permissions ?? current.permissions,
          time: {
            ...current.time,
            updated: DateTime.makeUnsafe(Date.now()),
            archived:
              input.archived === undefined
                ? current.time.archived
                : input.archived === null
                  ? undefined
                  : DateTime.makeUnsafe(input.archived),
          },
        })
        yield* events.publish(SessionEvent.Updated, {
          sessionID: input.sessionID,
          info,
          slug: row.slug,
          version: row.version,
        })
        return yield* result.get(input.sessionID)
      }),
      list: Effect.fn("V2Session.list")(function* (input = {}) {
        const direction = input.anchor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const sortColumn = SessionTable.time_created
        const conditions: SQL[] = []
        if (input.includeInternal !== true)
          conditions.push(notLike(SessionTable.id, `${SessionSchema.LEARNING_REVIEWER_SESSION_PREFIX}%`))
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
            const writable = yield* result.requireWritable(input.sessionID)
            const returnPrompt = Effect.fnUntraced(function* (admitted: SessionInput.Admitted) {
              if (input.resume !== false) yield* enqueueWake(admitted)
              return admitted
            }, Effect.uninterruptible)
            const messageID = input.id ?? SessionMessage.ID.create()
            const delivery = input.delivery ?? "steer"
            const expected = {
              sessionID: input.sessionID,
              messageID,
              prompt: input.prompt,
              delivery,
              revertEpoch: input.revertEpoch,
            }
            // Selection belongs to the exact durable prompt request. An exact retry must not
            // change a Session whose agent/model may have moved on since the original admission.
            const prior = yield* SessionInput.find(db, messageID)
            if (prior !== undefined) {
              if (!SessionInput.equivalent(prior, expected))
                return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
              return yield* returnPrompt(prior)
            }
            // Validate before the durable write, but publish selection only after admission.
            // A stale revert epoch or lifecycle conflict must not leave a switched Session.
            if (input.prompt.agent !== undefined)
              yield* requireAdmissionAgent(
                writable.location,
                AgentV2.ID.make(input.prompt.agent),
                true,
              )
            const admitted = yield* SessionInput.admit(db, events, {
              id: messageID,
              sessionID: input.sessionID,
              prompt: input.prompt,
              delivery,
              revertEpoch: input.revertEpoch,
            }).pipe(
              Effect.catchDefect((defect) =>
                defect instanceof SessionInput.LifecycleConflict
                  ? new PromptConflictError({ sessionID: input.sessionID, messageID })
                  : Effect.die(defect),
              ),
            )
            if (!SessionInput.equivalent(admitted, expected))
              return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
            if (input.prompt.agent !== undefined)
              yield* result.switchAgent({ sessionID: input.sessionID, agent: input.prompt.agent })
            if (input.prompt.model !== undefined)
              yield* result.switchModel({
                sessionID: input.sessionID,
                model: {
                  id: ModelV2.ID.make(input.prompt.model.id),
                  providerID: ProviderV2.ID.make(input.prompt.model.providerID),
                  ...(input.prompt.model.variant === undefined
                    ? {}
                    : { variant: ModelV2.VariantID.make(input.prompt.model.variant) }),
                },
              })
            return yield* returnPrompt(admitted)
          }),
        ),
      ),
      // W1.2 — manual shell execution is NOT wired as a core service: a user-initiated shell command
      // runs only through the provider-turn tool path (the model executes it as a tool), and the V2
      // runner has no standalone "run this command now" seam. Typed refusal with the concrete reason
      // rather than a silent no-op.
      shell: Effect.fn("V2Session.shell")(function* (input) {
        // W0-2 — manual shell is a projection-layer surface: the host implementation spawns the
        // process and mirrors the exchange as V1 wire rows (no legacy durable writes, no provider
        // call). Wired hosts inject CurrentManualShell; an unwired composition keeps the typed
        // refusal with the concrete reason.
        yield* result.requireWritable(input.sessionID)
        const manual = yield* CurrentManualShell
        if (!manual)
          return yield* new OperationUnavailableError({
            operation: "shell",
            reason:
              "manual shell execution is not wired in this composition (provide CurrentManualShell); the V2 runner executes shell only as model tool calls",
          })
        const exit = yield* manual(input).pipe(Effect.exit)
        if (Exit.isFailure(exit)) {
          const failure = Cause.squash(exit.cause)
          return yield* new OperationUnavailableError({
            operation: "shell",
            reason: failure instanceof Error ? failure.message : String(failure),
          })
        }
      }),
      // W1.2 — manual skill invocation is NOT wired as a core service: SkillGuidance is per-turn
      // advisory composition (loaded into the system context at turn boundaries), with no standalone
      // "inject this skill now" service. Typed refusal with the concrete reason.
      skill: Effect.fn("V2Session.skill")(function* (input) {
        yield* result.requireWritable(input.sessionID)
        return yield* new OperationUnavailableError({
          operation: "skill",
          reason:
            "manual skill invocation is not wired: skill guidance composes into the next turn's system context only",
        })
      }),
      // W1.2 (revised by RI-04) — switchAgent is REAL: the AgentSwitched event still owns the
      // transition (the projector updates the Session's agent and requests a ContextEpoch replacement
      // at the next provider-turn boundary, exactly like the sibling switchModel path), but admission
      // now validates the target agent against the Location roster FIRST (RI-04): an unknown id fails
      // AgentV2.NotFoundError and a non-selectable (subagent/hidden) agent fails
      // Session.AgentNotSelectableError, instead of projecting a switch the per-turn runner resolve
      // would reject later. The event owns the transition; admission owns the refusal.
      switchAgent: Effect.fn("V2Session.switchAgent")(function* (input) {
        const session = yield* result.requireWritable(input.sessionID)
        yield* requireAdmissionAgent(session.location, AgentV2.ID.make(input.agent), true)
        yield* events.publish(SessionEvent.AgentSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          agent: input.agent,
        })
      }),
      switchModel: Effect.fn("V2Session.switchModel")(function* (input) {
        yield* result.requireWritable(input.sessionID)
        yield* events.publish(SessionEvent.ModelSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          model: input.model,
        })
      }),
      setPermissions: Effect.fn("V2Session.setPermissions")(function* (input) {
        yield* result.requireWritable(input.sessionID)
        yield* events.publish(SessionEvent.PermissionsChanged, {
          sessionID: input.sessionID,
          timestamp: yield* DateTime.now,
          permissions: input.permissions,
        })
      }),
      setArchived: Effect.fn("V2Session.setArchived")(function* (input) {
        const info = yield* result.requireWritable(input.sessionID)
        if ((info.time.archived !== undefined) === input.archived) return
        const row = yield* db.select({ slug: SessionTable.slug, version: SessionTable.version })
          .from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get().pipe(Effect.orDie)
        if (!row) return yield* new NotFoundError({ sessionID: input.sessionID })
        yield* events.publish(SessionEvent.Updated, {
          sessionID: input.sessionID,
          info: SessionSchema.Info.make({ ...info, time: { ...info.time,
            updated: yield* DateTime.now, archived: input.archived ? yield* DateTime.now : undefined } }),
          slug: row.slug,
          version: row.version,
        }, { location: info.location })
      }),
      // RI-18 native manual compaction: admit a durable request (fixing the summary model and the
      // history fence), wake the drain — the summary provider turn runs inside SessionCompaction
      // with the full receipt contract — and await the request's terminal state. Interruptions and
      // crashes leave recovery_required for the maintenance surface; a settled no-op means the
      // history had nothing worth compacting.
      compact: Effect.fn("V2Session.compact")(function* (input) {
        yield* result.requireWritable(input.sessionID)
        // The summary model identity is EXPLICIT — a caller that cannot name the model gets a
        // typed refusal, never a fabricated or defaulted identity.
        if (input.model === undefined)
          return yield* new OperationUnavailableError({
            operation: "compact",
            reason: "manual compaction requires an explicit summary model identity (provider/model)",
          })
        const fence = yield* db
          .select({ total: count(), lastID: max(SessionMessageTable.id) })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, input.sessionID))
          .get()
          .pipe(Effect.orDie)
        if (fence === undefined || fence.lastID === null)
          return yield* new OperationUnavailableError({
            operation: "compact",
            reason: "manual compaction requires a non-empty session history",
          })
        const request = yield* CompactionRequest.admit(db, {
          sessionID: input.sessionID,
          providerID: input.model.providerID,
          modelID: input.model.modelID,
          fenceMessageCount: fence.total,
          fenceLastMessageID: fence.lastID,
        })
        yield* execution.wake(input.sessionID).pipe(Effect.ignore)
        const terminal = yield* CompactionRequest.awaitTerminal(db, request.request_id, MANUAL_COMPACTION_DEADLINE_MS)
        if (terminal === undefined)
          return yield* new OperationUnavailableError({
            operation: "compact",
            reason: "manual compaction did not settle within its budget",
          })
        if (terminal.status === "settled") return
        return yield* new OperationUnavailableError({
          operation: "compact",
          reason: terminal.outcome ?? terminal.status,
        })
      }),
      // W1.2 — wait is REAL: it maps to SessionExecution.awaitIdle — the process-local ownership
      // chain resolves once the Session is idle (a no-op when nothing is running). With the no-op
      // execution layer (tests) it resolves immediately.
      wait: Effect.fn("V2Session.wait")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* execution.awaitIdle(sessionID)
      }),
      resume: Effect.fn("V2Session.resume")(function* (sessionID) {
        yield* result.requireWritable(sessionID)
        yield* execution.resume(sessionID)
      }),
      interrupt: Effect.fn("V2Session.interrupt")((sessionID) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const session = yield* store.get(sessionID)
            if (!session) return yield* execution.interrupt(sessionID).pipe(Effect.orDie)
            yield* result.requireWritable(sessionID)
            const event = yield* events
              .publish(SessionEvent.InterruptRequested, {
                sessionID,
                timestamp: yield* DateTime.now,
              })
              .pipe(Effect.orDie)
            if (event.seq === undefined)
              return yield* Effect.die("Interrupt request event is missing aggregate sequence")
            yield* execution.interrupt(sessionID, event.seq).pipe(Effect.orDie)
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

/** Production Session service with an explicitly supplied Location map. */
export const runtimeLayer = layer.pipe(
  Layer.provide(SessionExecutionLocal.defaultLayer),
  Layer.provide(SessionStore.defaultLayer),
  Layer.provide(SessionProjector.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(ProjectV2.defaultLayer),
  Layer.orDie,
)

/** Standalone production default. Hosts with application Location services must use runtimeLayer. */
// Layer.suspend defers the LocationServiceMap access to build time: session.ts ↔ location-layer
// form a module cycle (location-layer → tool builtins → tool/task → session), and a top-level
// access here can hit the TDZ depending on the entrypoint's import order.
export const liveLayer = Layer.suspend(() => runtimeLayer.pipe(Layer.provide(LocationServiceMap.layer)))
