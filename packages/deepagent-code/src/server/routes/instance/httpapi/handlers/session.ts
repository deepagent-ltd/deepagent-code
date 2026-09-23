import { PermissionV1 } from "@deepagent-code/core/v1/permission"
import { Database } from "@deepagent-code/core/database/database"
import { Agent } from "@/agent/agent"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ContextFederationDiagnostics } from "@/context-federation/diagnostics"
import { Command } from "@/command"
import { Permission } from "@/permission"
import { SessionShare } from "@/share/session"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { MessageV2 } from "@/session/message-v2"
import { SessionPromptV2 } from "@/session/prompt-v2"
import { SessionCommandV2 } from "@/session/command-v2"
import { SessionPromptIntent } from "@/session/prompt-intent"
import { LegacyExecutionUnavailable, guardLegacyExecution } from "@/session/legacy-execution-zero"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { AgentV2 } from "@deepagent-code/core/agent"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionRuntimeStatus } from "@deepagent-code/core/session/runtime-status"
import { SessionMutationEpoch } from "@/session/mutation-epoch"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionSummary } from "@/session/summary"
import { SessionLegacyProviderResolution } from "@/session/legacy-provider-resolution"
import { SessionProviderResolution } from "@/session/provider-resolution"
import { DevCampaignMint } from "@/effect/dev-campaign-mint"
import { Todo } from "@/session/todo"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { NamedError } from "@deepagent-code/core/util/error"
import { Cause, Effect, Option, Queue, Schema, Scope } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError, HttpApiSchema } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { InstanceHttpApi } from "../api"
import {
  CommandPayload,
  ContinuationResolutionPayload,
  ContextAttemptResolvePayload,
  ContextCohortQuery,
  DiffArtifactFileQuery,
  DiffArtifactMaintenancePayload,
  DiffArtifactManifestQuery,
  DiffQuery,
  ForkPayload,
  InitPayload,
  ImportSnapshotPayload,
  ExportBundlePayload,
  ImportBundlePayload,
  ShareBundlePayload,
  ImportBundleSharePayload,
  RevokeBundleSharePayload,
  LegacyForkPayload,
  ListQuery,
  MessagesQuery,
  PermissionResponsePayload,
  PromptPreparePayload,
  PromptPayload,
  ProviderResolutionCommandPayload,
  ProviderResolutionPayload,
  RevertPayload,
  ShellPayload,
  SummarizePayload,
  UpdatePayload,
} from "../groups/session"
import {
  ApiNotFoundError,
  ConflictError,
  PermissionNotFoundError,
  ServiceUnavailableError,
  SessionBusyError,
  notFound,
} from "../errors"
import * as SessionError from "./session-errors"
import { randomUUID } from "node:crypto"
import { getWorkspaceContext } from "../utils/workspace-context"
import { SessionDiffArtifact } from "@/session/diff-artifact"
import { exportSessionSnapshot, importSessionSnapshot, type SessionSnapshot } from "@/session/snapshot"
import { exportSessionBundle, parseSessionBundle, BUNDLE_MAX_BYTES } from "@/session/bundle"
import { uploadSessionBundle, downloadSessionBundle, revokeSessionBundle } from "@/session/bundle-share"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"

const tryParseJson = (text: string) =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => new HttpApiError.BadRequest({}),
  })

type PromptPreparePart = (typeof SessionPromptV2.PromptInput.Type)["parts"][number]

const promptText = (parts: readonly PromptPreparePart[]) =>
  parts.map((part) => (part.type === "text" ? part.text : "")).join("")

const promptPrepareEvent = (data: unknown): Sse.Event => ({
  _tag: "Event",
  event: "message",
  id: undefined,
  data: JSON.stringify(data),
})

const isPromptPrepareTerminal = (event: unknown) =>
  typeof event === "object" && event !== null && "type" in event && (event.type === "result" || event.type === "error")

export const sessionHandlers = HttpApiBuilder.group(InstanceHttpApi, "session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const shareSvc = yield* SessionShare.Service
    const promptSvc = yield* SessionPromptV2.Service
    const commandSvc = yield* SessionCommandV2.Service
    const database = yield* Database.Service
    const revertSvc = yield* SessionRevert.Service
    const compactSvc = yield* SessionCompaction.Service
    const coreV2Session = yield* SessionV2.Service
    const runState = yield* SessionRunState.Service
    const agentSvc = yield* Agent.Service
    const permissionSvc = yield* Permission.Service
    const runtimeStatus = yield* SessionRuntimeStatus.Service
    const todoSvc = yield* Todo.Service
    const summary = yield* SessionSummary.Service
    const events = yield* EventV2Bridge.Service
    const contextDiagnosticsSvc = yield* ContextFederationDiagnostics.Service
    const providerResolutionSvc = yield* SessionLegacyProviderResolution.Service
    const providerResolutionFacade = yield* SessionProviderResolution.Service
    const flags = yield* RuntimeFlags.Service
    const scope = yield* Scope.Scope
    // 1.4.8.rN dev campaign mint (env-gated): consume the seam so the merged layer is a real
    // graph requirement and builds with the Database (production: no-op, empty service).
    yield* DevCampaignMint

    const mapLegacyZero = (error: LegacyExecutionUnavailable) =>
      error.reason === "legacy_session_requires_adoption"
        ? new ConflictError({ message: error.detail, resource: error.reason })
        : new ServiceUnavailableError({
            service: "session.prompt",
            message: error.reason + ": " + error.detail + (error.sessionID ? " (session " + error.sessionID + ")" : ""),
          })

    const refuseLegacyRecoveryMutation = (sessionID: SessionID, operation: string) =>
      flags.coreV2Only
        ? Effect.fail(
            new ServiceUnavailableError({
              service: operation,
              message:
                `Core V2-only runtime cannot apply the legacy recovery state machine for ${sessionID}; ` +
                "use the exact durable maintenance recovery command surface",
            }),
          )
        : Effect.void

    const list = Effect.fn("SessionHttpApi.list")(function* (ctx: { query: typeof ListQuery.Type }) {
      return yield* session.list({
        directory: ctx.query.scope === "project" ? undefined : ctx.query.directory,
        scope: ctx.query.scope,
        path: ctx.query.path,
        roots: ctx.query.roots,
        start: ctx.query.start,
        search: ctx.query.search,
        limit: ctx.query.limit,
      })
    })

    const status = Effect.fn("SessionHttpApi.status")(function* () {
      return Object.fromEntries(
        [...(yield* runtimeStatus.list)].map(([sessionID, state]) => [
          sessionID,
          state.status === "busy"
            ? { type: "busy" as const }
            : {
                type: "recovery_required" as const,
                message: "Execution stopped with an unresolved durable claim; inspect recovery before resuming",
                ...(state.blockedReason ? { blockedReason: state.blockedReason } : {}),
              },
        ]),
      )
    })

    // Core V2 drains do not occupy the compatibility SessionRunState lane. History mutations must
    // therefore consult both authorities or a revert/delete can race a live provider/tool turn.
    // Treat recovery_required as non-mutable too: its durable claim must be resolved before any
    // compatibility projection is rewritten.
    const assertSessionLaneAvailable = Effect.fn("SessionHttpApi.assertSessionLaneAvailable")(function* (
      sessionID: SessionID,
    ) {
      if ((yield* runtimeStatus.list).has(sessionID)) return yield* new Session.BusyError({ sessionID })
      yield* runState.assertNotBusy(sessionID)
    })

    const requireSession = Effect.fn("SessionHttpApi.requireSession")(function* (sessionID: SessionID) {
      yield* coreV2Session
        .get(SessionV2.ID.make(sessionID))
        .pipe(Effect.mapError(() => notFound(`Session not found: ${sessionID}`)))
      return yield* SessionError.mapStorageNotFound(session.get(sessionID))
    })

    const requireWritableSession = (sessionID: SessionID) =>
      coreV2Session
        .requireWritable(SessionV2.ID.make(sessionID))
        .pipe(
          Effect.mapError((error) =>
            error instanceof SessionV2.LegacySessionRequiresAdoption
              ? new ConflictError({
                  message: `Historical session ${sessionID} requires explicit audited adoption`,
                  resource: error.code,
                })
              : notFound(`Session not found: ${sessionID}`),
          ),
        )

    const get = Effect.fn("SessionHttpApi.get")(function* (ctx: { params: { sessionID: SessionID } }) {
      return yield* requireSession(ctx.params.sessionID)
    })

    const children = Effect.fn("SessionHttpApi.children")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* session.children(ctx.params.sessionID)
    })

    const todo = Effect.fn("SessionHttpApi.todo")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* todoSvc.get(ctx.params.sessionID)
    })

    const plan = Effect.fn("SessionHttpApi.plan")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      const current = AgentGateway.DeepAgentPlanStore.getPlanDoc(ctx.params.sessionID)
      const ref = AgentGateway.DeepAgentPlanStore.planDocRef(ctx.params.sessionID)
      return {
        plan: current
          ? {
              ...current,
              steps: current.steps.map((step) => ({
                ...step,
                acceptance: step.acceptance ?? null,
                assigned_agent: step.assigned_agent ?? null,
                evidence: [...(step.evidence ?? [])],
                note: step.note ?? null,
              })),
            }
          : null,
        doc_id: ref?.id ?? null,
        plan_version: ref?.version ?? null,
      }
    })

    const diff = Effect.fn("SessionHttpApi.diff")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof DiffQuery.Type
    }) {
      return yield* summary.diff({ sessionID: ctx.params.sessionID, messageID: ctx.query.messageID })
    })

    const mapDiffArtifactError = (error: SessionDiffArtifact.Invalid | SessionDiffArtifact.NotFound) => {
      if (error instanceof SessionDiffArtifact.NotFound) return notFound(error.message)
      return new HttpApiError.BadRequest({})
    }

    const diffArtifactMaintenance = Effect.fn("SessionHttpApi.diffArtifactMaintenance")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof DiffArtifactMaintenancePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionDiffArtifact.migrate({
        sessionID: ctx.params.sessionID,
        ...(ctx.payload.limit ? { limit: ctx.payload.limit } : {}),
      }).pipe(
        Effect.mapError(
          (error) => new ServiceUnavailableError({ service: "session.diff-artifact", message: error.message }),
        ),
      )
    })

    const diffArtifactManifest = Effect.fn("SessionHttpApi.diffArtifactManifest")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof DiffArtifactManifestQuery.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionDiffArtifact.manifest({
        sessionID: ctx.params.sessionID,
        messageID: ctx.query.messageID,
        artifactID: ctx.query.artifactID,
        ...(ctx.query.cursor ? { cursor: ctx.query.cursor } : {}),
        ...(ctx.query.limit ? { limit: ctx.query.limit } : {}),
      }).pipe(Effect.mapError(mapDiffArtifactError))
    })

    const diffArtifactFile = Effect.fn("SessionHttpApi.diffArtifactFile")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof DiffArtifactFileQuery.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionDiffArtifact.file({
        sessionID: ctx.params.sessionID,
        messageID: ctx.query.messageID,
        artifactID: ctx.query.artifactID,
        path: ctx.query.path,
        ...(ctx.query.maxBytes ? { maxBytes: ctx.query.maxBytes } : {}),
      }).pipe(Effect.mapError(mapDiffArtifactError))
    })

    const messages = Effect.fn("SessionHttpApi.messages")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof MessagesQuery.Type
    }) {
      if (ctx.query.before) {
        const before = ctx.query.before
        yield* Effect.try({
          try: () => MessageV2.cursor.decode(before),
          catch: () => new HttpApiError.BadRequest({}),
        })
      }
      yield* requireSession(ctx.params.sessionID)
      const page = yield* SessionError.mapStorageNotFound(
        MessageV2.clientPage({
          sessionID: ctx.params.sessionID,
          limit: ctx.query.limit ?? MessageV2.ClientMessageLimits.page,
          before: ctx.query.before,
        }),
      )
      const items = page.items.map((item) => ({ ...item, info: MessageV2.clientProjection(item.info) }))
      if (!page.cursor) return items

      const request = yield* HttpServerRequest.HttpServerRequest
      // toURL() honors the Host + x-forwarded-proto headers, so the Link
      // header echoes the real origin instead of a hard-coded localhost.
      const url = Option.getOrElse(HttpServerRequest.toURL(request), () => new URL(request.url, "http://localhost"))
      url.searchParams.set("limit", (ctx.query.limit ?? MessageV2.ClientMessageLimits.page).toString())
      url.searchParams.set("before", page.cursor)
      return HttpServerResponse.jsonUnsafe(items, {
        headers: {
          "Access-Control-Expose-Headers": "Link, X-Next-Cursor",
          Link: `<${url.toString()}>; rel="next"`,
          "X-Next-Cursor": page.cursor,
        },
      })
    })

    const message = Effect.fn("SessionHttpApi.message")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      const result = yield* SessionError.mapStorageNotFound(
        MessageV2.clientGet({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID }),
      )
      return result
    })

    const create = Effect.fn("SessionHttpApi.create")(function* (ctx: { payload?: Session.CreateInput }) {
      // RI-16/RI-25: under the V2-only profile session create is Core-native (session.created.2
      // authority; the V1 wire shape below is egress only — the bridge derives client events and
      // the shared session row carries the response).
      if (flags.coreV2Only) {
        const instanceCtx = yield* InstanceState.context
        const workspaceID = yield* InstanceState.workspaceID
        const created = yield* coreV2Session
          .create({
            ...(ctx.payload?.parentID ? { parentID: SessionV2.ID.make(ctx.payload.parentID) } : {}),
            ...(ctx.payload?.title ? { title: ctx.payload.title } : {}),
            ...(ctx.payload?.metadata ? { metadata: ctx.payload.metadata } : {}),
            ...(ctx.payload?.agent ? { agent: AgentV2.ID.make(ctx.payload.agent) } : {}),
            ...(ctx.payload?.model
              ? { model: { id: ctx.payload.model.id, providerID: ctx.payload.model.providerID } }
              : {}),
            permissions: SessionV2.permissionsFromLegacy(ctx.payload?.permission),
            location: { directory: AbsolutePath.make(instanceCtx.directory), ...(workspaceID ? { workspaceID } : {}) },
          })
          .pipe(
            // RI-04 admission validation surfaces as a typed 400 like the public V2 endpoint.
            Effect.catchTags({
              "AgentV2.NotFoundError": (error) => Effect.fail(new HttpApiError.BadRequest({})),
              "Session.AgentNotSelectableError": (error) => Effect.fail(new HttpApiError.BadRequest({})),
            }),
          )
        // Read-back cannot miss a session Core just projected; a miss is a defect, not a 404.
        return yield* session.get(SessionID.make(created.id)).pipe(Effect.orDie)
      }
      return yield* shareSvc.create(ctx.payload)
    })

    const createRaw = Effect.fn("SessionHttpApi.createRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* create({})

      const json = yield* tryParseJson(body)
      const decoded = yield* Schema.decodeUnknownEffect(Session.CreateInput)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      const payload = decoded
        ? {
            ...decoded,
            permission: decoded.permission ? [...decoded.permission] : undefined,
          }
        : decoded
      return yield* create({ payload })
    })

    const remove = Effect.fn("SessionHttpApi.remove")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireWritableSession(ctx.params.sessionID)
      yield* session.remove(ctx.params.sessionID).pipe(
        Effect.mapError((error) =>
          error instanceof SessionV2.LegacySessionRequiresAdoption
            ? new ConflictError({
                message: `Historical session ${error.sessionID} requires explicit audited adoption`,
                resource: error.code,
              })
            : notFound(error.message),
        ),
      )
      return true
    })

    const update = Effect.fn("SessionHttpApi.update")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof UpdatePayload.Type
    }) {
      const current = yield* requireSession(ctx.params.sessionID)
      yield* coreV2Session
        .update({
          sessionID: SessionV2.ID.make(ctx.params.sessionID),
          ...(ctx.payload.title !== undefined ? { title: ctx.payload.title } : {}),
          ...(ctx.payload.metadata !== undefined ? { metadata: ctx.payload.metadata } : {}),
          ...(ctx.payload.permission !== undefined
            ? {
                permissions: SessionV2.permissionsFromLegacy(
                  Permission.merge(current.permission ?? [], ctx.payload.permission),
                ),
              }
            : {}),
          ...(ctx.payload.time?.archived !== undefined ? { archived: ctx.payload.time.archived } : {}),
        })
        .pipe(
          Effect.mapError((error) =>
            error instanceof SessionV2.LegacySessionRequiresAdoption
              ? new ConflictError({
                  message: `Historical session ${ctx.params.sessionID} requires explicit audited adoption`,
                  resource: error.code,
                })
              : notFound(`Session not found: ${ctx.params.sessionID}`),
          ),
        )
      return yield* requireSession(ctx.params.sessionID)
    })

    // LEGACY-EXECUTION-ZERO classification: history-copy / API operation — forks copy existing
    // message/part rows (reader adapter), never execute or claim a turn. Exempt.
    const fork = Effect.fn("SessionHttpApi.fork")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ForkPayload.Type
    }) {
      yield* requireWritableSession(ctx.params.sessionID)
      return yield* SessionError.mapFork(
        session.fork({
          sessionID: ctx.params.sessionID,
          intentID: ctx.payload.intentID ?? `legacy_fork_${randomUUID()}`,
          messageID: ctx.payload.messageID,
          directory: ctx.payload.directory,
          isolate: ctx.payload.isolate,
        }),
      )
    })

    const forkRaw = Effect.fn("SessionHttpApi.forkRaw")(function* (ctx: {
      params: { sessionID: SessionID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const json = body.trim().length === 0 ? {} : yield* tryParseJson(body)
      const payload = yield* Schema.decodeUnknownEffect(LegacyForkPayload)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      return yield* fork({
        params: ctx.params,
        payload: { ...payload, intentID: payload.intentID ?? `legacy_fork_${randomUUID()}` },
      })
    })

    const abort = Effect.fn("SessionHttpApi.abort")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* promptSvc.cancel(ctx.params.sessionID).pipe(Effect.mapError(mapLegacyZero))
      return true
    })

    const init = Effect.fn("SessionHttpApi.init")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof InitPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* commandSvc
        .command({
          sessionID: ctx.params.sessionID,
          messageID: ctx.payload.messageID,
          model: `${ctx.payload.providerID}/${ctx.payload.modelID}`,
          command: Command.Default.INIT,
          arguments: "",
        })
        .pipe(
          Effect.mapError((error) =>
            error instanceof LegacyExecutionUnavailable ? mapLegacyZero(error) : new HttpApiError.BadRequest({}),
          ),
        )
      return true
    })

    // share/unshare errors aren't all client-induced — storage and network
    // failures from SessionShare are real possibilities. Map to a typed 500
    // (matches the legacy route behavior which routed any failure through
    // ErrorMiddleware → NamedError.Unknown 500) instead of blanket-mapping
    // every failure to a 400 BadRequest.
    const share = Effect.fn("SessionHttpApi.share")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* shareSvc.share(ctx.params.sessionID).pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      return yield* requireSession(ctx.params.sessionID)
    })

    const unshare = Effect.fn("SessionHttpApi.unshare")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* shareSvc
        .unshare(ctx.params.sessionID)
        .pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      return yield* requireSession(ctx.params.sessionID)
    })

    const summarize = Effect.fn("SessionHttpApi.summarize")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SummarizePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      // RI-18 — under the V2-only profile manual compaction routes through SessionV2.compact, which
      // admits a durable CompactionRequest (fixing the summary model identity and the history fence),
      // wakes the drain, and awaits the request's terminal state; the summary provider turn runs
      // inside the Core SessionCompaction chain with the full receipt contract. Legacy profiles keep
      // the direct path.
      if (flags.coreV2Only) {
        const currentSession = yield* requireSession(ctx.params.sessionID)
        yield* coreV2Session
          .compact({
            sessionID: SessionV2.ID.make(ctx.params.sessionID),
            model: { providerID: ctx.payload.providerID, modelID: ctx.payload.modelID },
            auto: ctx.payload.auto ?? false,
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new ServiceUnavailableError({
                  service: "session.compact",
                  message:
                    "reason" in error && typeof error.reason === "string"
                      ? error.reason
                      : error instanceof Error
                        ? error.message
                        : String(error),
                }),
            ),
          )
        return true
      }
      yield* revertSvc.cleanup(yield* requireSession(ctx.params.sessionID))
      const messages = yield* SessionError.mapStorageNotFound(session.messages({ sessionID: ctx.params.sessionID }))
      const defaultAgent = yield* agentSvc.defaultAgent()
      const currentAgent = messages.findLast((message) => message.info.role === "user")?.info.agent ?? defaultAgent

      yield* compactSvc.create({
        sessionID: ctx.params.sessionID,
        agent: currentAgent,
        model: {
          providerID: ctx.payload.providerID,
          modelID: ctx.payload.modelID,
        },
        auto: ctx.payload.auto ?? false,
      })
      // F-18 follow-up: the V2 drain loop may fail with a typed admission Conflict (reason in
      // `error.reason`) — render it as 503 with the reason instead of leaking a defect.
      yield* promptSvc
        .loop({ sessionID: ctx.params.sessionID })
        .pipe(
          Effect.mapError((error) =>
            error instanceof SessionPromptIntent.Conflict
              ? new ServiceUnavailableError({ service: "session.v2.admission", message: error.reason })
              : mapLegacyZero(error),
          ),
        )
      return true
    })

    const prompt = Effect.fn("SessionHttpApi.prompt")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* session
        .assertRunnable(ctx.params.sessionID)
        .pipe(
          Effect.mapError(
            (error) => new ConflictError({ message: error.reason, resource: `session:${error.sessionID}` }),
          ),
        )
      // V4.1 §S1.2: route through promptOrSteer — if the session is mid-turn, the message is absorbed as
      // a steer (the running turn picks it up at its next boundary) instead of erroring/blocking; if idle,
      // it runs a normal turn. For a completed turn we stream the assistant message as before (unchanged
      // wire shape). For an accepted steer there is no turn result to stream, so we return a small ack
      // envelope ({ steered: true, ... }) — additive; existing clients that only read a completed turn
      // never sent a message mid-turn under the old BusyError contract, so they never see this branch.
      const result = yield* promptSvc
        .promptOrSteer({
          ...ctx.payload,
          sessionID: ctx.params.sessionID,
        })
        .pipe(
          Effect.mapError((error) =>
            error instanceof LegacyExecutionUnavailable
              ? mapLegacyZero(error)
              : error instanceof SessionMutationEpoch.Stale
                ? new ConflictError({
                    message: "prompt intent was superseded by a session revert",
                    resource: `session:${error.sessionID}`,
                  })
                : error instanceof SessionPromptIntent.Conflict
                  ? new ConflictError({ message: error.reason, resource: `session_intent:${error.intentID}` })
                  : error instanceof SessionPromptIntent.InProgress
                    ? new ConflictError({
                        message: "prompt intent admission is already in progress",
                        resource: `session_intent:${error.intentID}`,
                      })
                    : new HttpApiError.BadRequest({}),
          ),
        )
      const body =
        result.kind === "turn"
          ? JSON.stringify(result.message)
          : JSON.stringify({ steered: true, delivery: result.delivery, messageID: result.admitted.id })
      return HttpServerResponse.stream(Stream.make(body).pipe(Stream.encodeText), {
        contentType: "application/json",
      })
    })

    const preparePromptDraft = Effect.fn("SessionHttpApi.preparePromptDraft")(function* (input: {
      ctx: { params: { sessionID: SessionID }; payload: typeof PromptPreparePayload.Type }
      onProgress?: (preview: string) => void
    }) {
      yield* requireSession(input.ctx.params.sessionID)
      const rawInput = promptText(input.ctx.payload.parts)
      if (!rawInput.trim()) return yield* new HttpApiError.BadRequest({})
      if (input.ctx.payload.intent_id) {
        // W0-3b — the V1 intent admission (SessionPromptIntent.prepare) is the intelligence
        // pipeline's ONLY legacy durable write, and it exists to make the V1 claim/renew chain
        // idempotent. Under the V2-only profile that chain is retired: V2 prompt idempotency is
        // carried by the SessionV2 messageID, so prepare is skipped and refinement runs for real
        // (auxiliary model call + fs draft — no legacy rows). intent_id still round-trips so the
        // client's identity checks are unaffected.
        if (!flags.coreV2Only) {
          yield* guardLegacyExecution(flags, { sessionID: input.ctx.params.sessionID }).pipe(
            Effect.mapError(mapLegacyZero),
          )
          yield* SessionPromptIntent.prepare({
            intentID: input.ctx.payload.intent_id,
            sessionID: input.ctx.params.sessionID,
            source: input.ctx.payload.intent_source ?? "intelligence",
          }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.mapError((error) =>
              error instanceof SessionMutationEpoch.Stale
                ? new ConflictError({
                    message: "prompt intent was superseded by a session revert",
                    resource: `session:${error.sessionID}`,
                  })
                : new ConflictError({ message: error.reason, resource: `session_intent:${error.intentID}` }),
            ),
          )
        }
      }
      const result = yield* promptSvc
        .refineIntelligenceDraft({
          sessionID: input.ctx.params.sessionID,
          rawInput,
          outputLanguage: input.ctx.payload.output_language ?? "english",
          onProgress: input.onProgress,
        })
        .pipe(
          // Fail soft: refinement is an enhancement, not a gate. If the model can't produce a
          // usable refined prompt (parse failure, weak model, etc.), degrade to the direct path
          // with the user's raw input instead of blocking the turn. The client treats a "general"
          // route as direct_override, so the user's message still goes through.
          //
          // We log the cause first: an intelligence→direct degradation is exactly the "the plan/confirm
          // popup didn't appear" symptom, and it is otherwise invisible (refineIntelligenceDraft already
          // fails soft internally for chat). The log makes the degrade reason diagnosable —
          // model schema failure vs. an aborted prepare (e.g. the renderer reloaded mid-call).
          Effect.catch((error: unknown) =>
            Effect.logWarning("intelligence prompt prepare degraded to direct").pipe(
              Effect.annotateLogs({
                sessionID: input.ctx.params.sessionID,
                reason: error instanceof Error ? error.message : String(error),
              }),
              Effect.as({
                route: "general" as const,
                prompt_draft_id: "",
                context_plan_id: "",
                state: "general_ready",
                mode: "intelligence" as const,
                goal: rawInput,
                preview: rawInput,
              }),
            ),
          ),
        )
      return {
        ...result,
        ...(input.ctx.payload.intent_id ? { intent_id: input.ctx.payload.intent_id } : {}),
      }
    })

    const promptPrepare = Effect.fn("SessionHttpApi.promptPrepare")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPreparePayload.Type
    }) {
      return yield* preparePromptDraft({ ctx })
    })

    const promptPrepareStream = Effect.fn("SessionHttpApi.promptPrepareStream")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPreparePayload.Type
    }) {
      const queue = yield* Queue.dropping<unknown, Error | Cause.Done>(64)
      yield* preparePromptDraft({
        ctx,
        onProgress: (preview) => {
          if (Queue.offerUnsafe(queue, { type: "progress", preview })) return
          Queue.failCauseUnsafe(
            queue,
            Cause.fail(new Error("Prompt preparation consumer exceeded its 64-event buffer")),
          )
        },
      }).pipe(
        Effect.tap((result) => Effect.sync(() => Queue.offerUnsafe(queue, { type: "result", result }))),
        Effect.catchCause((cause) =>
          Effect.sync(() => Queue.offerUnsafe(queue, { type: "error", message: Cause.pretty(cause) })),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
      return HttpServerResponse.stream(
        Stream.fromQueue(queue).pipe(
          Stream.takeUntil(isPromptPrepareTerminal),
          Stream.map(promptPrepareEvent),
          Stream.pipeThroughChannel(Sse.encode()),
          Stream.encodeText,
          Stream.ensuring(Queue.shutdown(queue)),
        ),
        {
          contentType: "text/event-stream",
          headers: {
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "X-Content-Type-Options": "nosniff",
          },
        },
      )
    })

    const promptSuggestion = Effect.fn("SessionHttpApi.promptSuggestion")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      const suggestion = yield* promptSvc.latestSuggestion({ sessionID: ctx.params.sessionID })
      return { status: suggestion?.status ?? null, body: suggestion?.body ?? null }
    })

    const promptAsync = Effect.fn("SessionHttpApi.promptAsync")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* session
        .assertRunnable(ctx.params.sessionID)
        .pipe(
          Effect.mapError(
            (error) => new ConflictError({ message: error.reason, resource: `session:${error.sessionID}` }),
          ),
        )
      // Return only after the input has crossed its durable admission boundary. Model execution stays
      // asynchronous, but callers may safely serialize destructive actions after this acknowledgement.
      const receipt = yield* promptSvc.promptAsync({ ...ctx.payload, sessionID: ctx.params.sessionID }).pipe(
        Effect.mapError((error) =>
          error instanceof LegacyExecutionUnavailable
            ? mapLegacyZero(error)
            : error instanceof SessionPromptIntent.Conflict
              ? new ConflictError({ message: error.reason, resource: `session_intent:${error.intentID}` })
              : error instanceof SessionPromptIntent.InProgress
                ? new ConflictError({
                    message: "prompt intent admission is already in progress",
                    resource: `session_intent:${error.intentID}`,
                  })
                : error instanceof SessionMutationEpoch.Stale
                  ? new ConflictError({
                      message: "prompt intent was superseded by a session revert",
                      resource: `session:${error.sessionID}`,
                    })
                  : new HttpApiError.BadRequest({}),
        ),
      )
      return receipt
    })

    const command = Effect.fn("SessionHttpApi.command")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof CommandPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* commandSvc
        .command({ ...ctx.payload, sessionID: ctx.params.sessionID })
        .pipe(
          Effect.mapError((error) =>
            error instanceof LegacyExecutionUnavailable ? mapLegacyZero(error) : new HttpApiError.BadRequest({}),
          ),
        )
    })

    const shell = Effect.fn("SessionHttpApi.shell")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ShellPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* SessionError.mapBusy(assertSessionLaneAvailable(ctx.params.sessionID))
      return yield* commandSvc.shell({ ...ctx.payload, sessionID: ctx.params.sessionID }).pipe(
        Effect.mapError((error) =>
          error instanceof Session.BusyError
            ? new SessionBusyError({
                sessionID: error.sessionID,
                message: `Session is busy: ${error.sessionID}`,
              })
            : mapLegacyZero(error),
        ),
      )
    })

    const revert = Effect.fn("SessionHttpApi.revert")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof RevertPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* SessionError.mapBusy(assertSessionLaneAvailable(ctx.params.sessionID))
      return yield* SessionError.mapRevert(revertSvc.revert({ sessionID: ctx.params.sessionID, ...ctx.payload }))
    })

    const unrevert = Effect.fn("SessionHttpApi.unrevert")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* SessionError.mapBusy(assertSessionLaneAvailable(ctx.params.sessionID))
      return yield* SessionError.mapBusy(revertSvc.unrevert({ sessionID: ctx.params.sessionID }))
    })

    const permissionRespond = Effect.fn("SessionHttpApi.permissionRespond")(function* (ctx: {
      params: { sessionID: SessionID; permissionID: PermissionV1.ID }
      payload: typeof PermissionResponsePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* permissionSvc.reply({ requestID: ctx.params.permissionID, reply: ctx.payload.response }).pipe(
        Effect.catchTag("Permission.NotFoundError", (error) =>
          Effect.fail(
            new PermissionNotFoundError({
              requestID: String(error.requestID),
              message: `Permission request not found: ${error.requestID}`,
            }),
          ),
        ),
      )
      return true
    })

    const deleteMessage = Effect.fn("SessionHttpApi.deleteMessage")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* SessionError.mapBusy(assertSessionLaneAvailable(ctx.params.sessionID))
      const messages = yield* SessionError.mapStorageNotFound(session.messages({ sessionID: ctx.params.sessionID }))
      if (!messages.some((message) => message.info.id === ctx.params.messageID))
        return yield* notFound(`Message not found: ${ctx.params.messageID}`)
      yield* session.removeMessage(ctx.params)
      return true
    })

    const deletePart = Effect.fn("SessionHttpApi.deletePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      if (!(yield* session.getPart(ctx.params))) return yield* notFound(`Part not found: ${ctx.params.partID}`)
      yield* session.removePart(ctx.params)
      return true
    })

    const updatePart = Effect.fn("SessionHttpApi.updatePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
      payload: typeof SessionV1.Part.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const payload = ctx.payload as SessionV1.Part
      if (
        payload.id !== ctx.params.partID ||
        payload.messageID !== ctx.params.messageID ||
        payload.sessionID !== ctx.params.sessionID
      ) {
        return yield* new HttpApiError.BadRequest({})
      }
      if (!(yield* session.getPart(ctx.params))) return yield* notFound(`Part not found: ${ctx.params.partID}`)
      return yield* session.updatePart(payload)
    })

    const contextDiagnostics = Effect.fn("SessionHttpApi.contextDiagnostics")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* contextDiagnosticsSvc
        .get(ctx.params.sessionID)
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
    })

    // K-01 R-1/R-2: the unified provider-resolution facade owns this surface. The `abandoned`
    // decision is a durable-only transaction on both authorities (no legacy execution, no
    // provider call), so it is no longer fenced under the V2-only runtime. The exits that
    // genuinely need unavailable machinery stay structural refusals: `replayed` would wake the
    // legacy execution loop (post-dispatch ambiguity is NEVER auto-replayed), and `settled`
    // requires typed external evidence this payload cannot carry (use the
    // provider-resolution command surface's confirm_settled).
    const contextAttemptResolve = Effect.fn("SessionHttpApi.contextAttemptResolve")(function* (ctx: {
      params: { sessionID: SessionID; attemptID: string }
      payload: typeof ContextAttemptResolvePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      if (ctx.payload.decision === "replayed")
        return yield* new ServiceUnavailableError({
          service: "session.context-attempt-resolution",
          message:
            "explicit replay is never automatic; the replayed exit stays behind the risk-acknowledged " +
            "maintenance authority and never wakes an execution loop from this surface",
        })
      if (ctx.payload.decision === "settled")
        return yield* new ServiceUnavailableError({
          service: "session.context-attempt-resolution",
          message:
            "settling requires typed external provider evidence; use session.providerResolutionCommand " +
            "with the confirm_settled command",
        })
      const actor = yield* getWorkspaceContext()
      const outcome = yield* providerResolutionFacade
        .execute({
          commandKind: "abandon_exact",
          sessionID: ctx.params.sessionID,
          attemptID: ctx.params.attemptID,
          actorID: actor.userID,
        })
        .pipe(
          Effect.mapError((error) =>
            error instanceof SessionProviderResolution.NotFound
              ? new HttpApiError.BadRequest({})
              : error instanceof SessionProviderResolution.Conflict
                ? new HttpApiError.BadRequest({})
                : new HttpApiError.BadRequest({}),
          ),
        )
      if (outcome.commandKind !== "abandon_exact")
        return yield* Effect.die(new Error(`facade returned an unexpected command: ${outcome.commandKind}`))
      if (outcome.authority !== "context_federation_attempt")
        return yield* Effect.die(new Error("facade routed the attempt abandon to the legacy authority"))
      // The response view is the SAME projection the GET context diagnostics serve, re-read
      // after the durable apply — no parallel state machine in the handler.
      const diagnostics = yield* contextDiagnosticsSvc
        .get(ctx.params.sessionID)
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      const attempt = diagnostics.attempts.find((row) => row.attemptId === ctx.params.attemptID)
      if (!attempt) return yield* Effect.die(new Error(`resolved attempt disappeared: ${ctx.params.attemptID}`))
      return attempt
    })

    const contextCohort = Effect.fn("SessionHttpApi.contextCohort")(function* (ctx: {
      query: typeof ContextCohortQuery.Type
    }) {
      return yield* contextDiagnosticsSvc
        .cohort({ sinceMs: ctx.query.sinceMs, ...(ctx.query.untilMs != null ? { untilMs: ctx.query.untilMs } : {}) })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
    })

    const providerResolutionList = Effect.fn("SessionHttpApi.providerResolutionList")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* providerResolutionSvc
        .describe(ctx.params.sessionID)
        .pipe(Effect.mapError((error) => notFound(error.reason)))
    })

    // K-01 R-2: the legacy-receipt abandon is admitted under the V2-only runtime through the
    // unified facade — the legacy resolution is an append-only durable transaction (no legacy
    // execution), so the blanket V2-only fence is gone. The payload keeps the SDK shape; the
    // facade is the single execution path.
    const providerResolutionResolve = Effect.fn("SessionHttpApi.providerResolutionResolve")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ProviderResolutionPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const actor = yield* getWorkspaceContext()
      const outcome = yield* providerResolutionFacade
        .execute({
          commandKind: "abandon_exact",
          sessionID: ctx.params.sessionID,
          receiptID: ctx.payload.receiptID,
          commandID: ctx.payload.commandID,
          expected: ctx.payload.expected,
          ...(ctx.payload.reason ? { reason: ctx.payload.reason } : {}),
          actorID: actor.userID,
        })
        .pipe(Effect.mapError(SessionError.mapProviderResolutionError("session.provider-resolution")))
      if (outcome.commandKind !== "abandon_exact")
        return yield* Effect.die(new Error(`facade returned an unexpected command: ${outcome.commandKind}`))
      if (outcome.authority !== "legacy_provider_receipt")
        return yield* Effect.die(new Error("facade routed the legacy abandon to another authority"))
      return outcome.resolution
    })

    /** The ONE facade command entry — the frozen RecoveryCommand vocabulary over the wire. */
    const providerResolutionCommand = Effect.fn("SessionHttpApi.providerResolutionCommand")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ProviderResolutionCommandPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const actor = yield* getWorkspaceContext()
      const outcome = yield* providerResolutionFacade
        .execute({ ...ctx.payload, sessionID: ctx.params.sessionID, actorID: actor.userID })
        .pipe(Effect.mapError(SessionError.mapProviderResolutionError("session.provider-resolution-command")))
      if (outcome.commandKind === "recover")
        return {
          commandKind: "recover" as const,
          legacyReceiptDescriptors: outcome.legacyReceiptDescriptors,
          federationAttemptDescriptors: outcome.federationAttemptDescriptors.map((row) => ({
            descriptorID: row.descriptorId,
            sessionID: row.sessionId,
            activityID: row.activityId,
            turnID: row.turnId,
            kind: row.kind,
            payload: row.payload,
            createdAt: row.createdAt,
          })),
        }
      if (outcome.commandKind === "query_command")
        return {
          commandKind: "query_command" as const,
          authority: outcome.authority,
          ...(outcome.authority === "context_federation_attempt"
            ? {
                command: {
                  commandID: outcome.command.commandId,
                  attemptID: outcome.command.attempt.attemptId,
                  requestHash: outcome.command.requestHash,
                  state: outcome.command.state,
                  ...(outcome.command.commandKind ? { commandKind: outcome.command.commandKind } : {}),
                  createdAt: outcome.command.createdAt,
                  updatedAt: outcome.command.updatedAt,
                },
              }
            : {}),
          ...(outcome.authority === "legacy_provider_receipt" && outcome.resolution !== undefined
            ? { resolution: outcome.resolution }
            : {}),
        }
      return outcome
    })

    const continuationResolutionList = Effect.fn("SessionHttpApi.continuationResolutionList")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* compactSvc.describeContinuationResolutions(ctx.params.sessionID)
    })

    const continuationResolutionResolve = Effect.fn("SessionHttpApi.continuationResolutionResolve")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ContinuationResolutionPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* refuseLegacyRecoveryMutation(ctx.params.sessionID, "session.continuation-resolution")
      return yield* legacyContinuationResolutionResolve(ctx)
    })

    // Legacy-profile path only (unreachable under coreV2Only — see the refusal above): resolves
    // explicit compaction continuations and replays through the legacy loop.
    const legacyContinuationResolutionResolve = Effect.fn("SessionHttpApi.legacyContinuationResolutionResolve")(
      function* (ctx: { params: { sessionID: SessionID }; payload: typeof ContinuationResolutionPayload.Type }) {
        const actor = yield* getWorkspaceContext()
        const result = yield* compactSvc
          .resolveContinuation({ ...ctx.payload, sessionID: ctx.params.sessionID, actorID: actor.userID })
          .pipe(
            Effect.mapError((error) =>
              error instanceof SessionCompaction.ContinuationResolutionNotFound
                ? notFound(error.reason)
                : new ConflictError({ message: error.reason, resource: error.code }),
            ),
          )
        if (result.shouldReplay)
          yield* promptSvc.loop({ sessionID: result.sessionID }).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("explicit compaction continuation replay failed", {
                runID: result.runID,
                resolutionID: result.resolutionID,
                cause: Cause.pretty(cause),
              }),
            ),
            Effect.forkIn(scope, { startImmediately: true }),
          )
        return result
      },
    )

    // LEGACY-EXECUTION-ZERO classification: history export/import (snapshot bundle) — archival
    // read/copy of existing message/part rows, never executes or claims a turn. Exempt.
    const exportSnapshot = Effect.fn("SessionHttpApi.exportSnapshot")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      const bundle = yield* exportSessionSnapshot(ctx.params.sessionID).pipe(
        Effect.mapError(() => notFound(`session not found: ${ctx.params.sessionID}`)),
      )
      return JSON.stringify(bundle)
    })

    const importSnapshot = Effect.fn("SessionHttpApi.importSnapshot")(function* (ctx: {
      payload: typeof ImportSnapshotPayload.Type
    }) {
      const snapshot = yield* tryParseJson(ctx.payload.bundle).pipe(
        Effect.flatMap((raw) =>
          Effect.try({
            try: () => raw as SessionSnapshot,
            catch: () => new HttpApiError.BadRequest({}),
          }),
        ),
      )
      const instanceCtx = yield* InstanceState.context
      return yield* importSessionSnapshot({
        snapshot,
        projectID: instanceCtx.project.id,
        directory: instanceCtx.directory,
      }).pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
    })

    const exportBundle = Effect.fn("SessionHttpApi.exportBundle")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ExportBundlePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const bytes = yield* exportSessionBundle({ sessionID: ctx.params.sessionID, ...ctx.payload }).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      return { bundle: Buffer.from(bytes).toString("base64"), archive: "zip" as const }
    })

    const exportBundleStream = Effect.fn("SessionHttpApi.exportBundleStream")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ExportBundlePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const queue = yield* Queue.dropping<unknown, Error | Cause.Done>(64)
      yield* exportSessionBundle({
        sessionID: ctx.params.sessionID,
        ...ctx.payload,
        progress: (phase, percent, bytes) => {
          Queue.offerUnsafe(queue, { type: "progress", phase, percent, bytes })
        },
      }).pipe(
        Effect.tap((bytes) => Effect.sync(() => Queue.offerUnsafe(queue, { type: "result", archive: "zip", bundle: Buffer.from(bytes).toString("base64") }))),
        Effect.catchCause((cause) => Effect.sync(() => Queue.offerUnsafe(queue, { type: "error", message: Cause.pretty(cause) }))),
        Effect.forkScoped({ startImmediately: true }),
      )
      return HttpServerResponse.stream(
        Stream.fromQueue(queue).pipe(
          Stream.takeUntil(isPromptPrepareTerminal),
          Stream.map(promptPrepareEvent),
          Stream.pipeThroughChannel(Sse.encode()),
          Stream.encodeText,
          Stream.ensuring(Queue.shutdown(queue)),
        ),
        { contentType: "text/event-stream", headers: { "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } },
      )
    })

    const importBundle = Effect.fn("SessionHttpApi.importBundle")(function* (ctx: {
      payload: typeof ImportBundlePayload.Type
    }) {
      if (ctx.payload.bundle.length > BUNDLE_MAX_BYTES * 1.4)
        return yield* new HttpApiError.BadRequest({})
      const parsed = yield* Effect.tryPromise(() => parseSessionBundle(Buffer.from(ctx.payload.bundle, "base64"))).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      const instanceCtx = yield* InstanceState.context
      return yield* importSessionSnapshot({
        snapshot: parsed.snapshot,
        projectID: instanceCtx.project.id,
        directory: instanceCtx.directory,
      }).pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
    })

    const shareBundle = Effect.fn("SessionHttpApi.shareBundle")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ShareBundlePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const service = process.env.DEEPAGENT_SHARE_PUBLIC_URL
      const uploadToken = process.env.DEEPAGENT_SHARE_UPLOAD_TOKEN
      if (!service || !uploadToken)
        return yield* new ServiceUnavailableError({ service: "session.shareBundle", message: "Bundle share host is not configured" })
      const bytes = yield* exportSessionBundle({ sessionID: ctx.params.sessionID, tier: ctx.payload.tier, share: true })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      return yield* Effect.tryPromise(() => uploadSessionBundle({ bytes, service, uploadToken }))
        .pipe(Effect.mapError(() => new ServiceUnavailableError({ service: "session.shareBundle", message: "Bundle upload failed" })))
    })

    const importBundleShare = Effect.fn("SessionHttpApi.importBundleShare")(function* (ctx: {
      payload: typeof ImportBundleSharePayload.Type
    }) {
      const service = process.env.DEEPAGENT_SHARE_PUBLIC_URL
      if (!service)
        return yield* new ServiceUnavailableError({ service: "session.importBundleShare", message: "Bundle share host is not configured" })
      const parsed = yield* Effect.tryPromise(() => downloadSessionBundle({ url: ctx.payload.url, service }))
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      const instanceCtx = yield* InstanceState.context
      return yield* importSessionSnapshot({ snapshot: parsed.snapshot, projectID: instanceCtx.project.id, directory: instanceCtx.directory })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
    })

    const revokeBundleShare = Effect.fn("SessionHttpApi.revokeBundleShare")(function* (ctx: {
      payload: typeof RevokeBundleSharePayload.Type
    }) {
      const service = process.env.DEEPAGENT_SHARE_PUBLIC_URL
      if (!service)
        return yield* new ServiceUnavailableError({ service: "session.revokeBundleShare", message: "Bundle share host is not configured" })
      yield* Effect.tryPromise(() => revokeSessionBundle({ ...ctx.payload, service }))
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      return { revoked: true }
    })

    return handlers
      .handle("list", list)
      .handle("status", status)
      .handle("get", get)
      .handle("children", children)
      .handle("todo", todo)
      .handle("plan", plan)
      .handle("diff", diff)
      .handle("diffArtifactMaintenance", diffArtifactMaintenance)
      .handle("diffArtifactManifest", diffArtifactManifest)
      .handle("diffArtifactFile", diffArtifactFile)
      .handle("messages", messages)
      .handle("message", message)
      .handleRaw("create", createRaw)
      .handle("remove", remove)
      .handle("update", update)
      .handleRaw("fork", forkRaw)
      .handle("abort", abort)
      .handle("init", init)
      .handle("share", share)
      .handle("unshare", unshare)
      .handle("summarize", summarize)
      .handle("prompt", prompt)
      .handle("promptPrepare", promptPrepare)
      .handle("promptPrepareStream", promptPrepareStream)
      .handle("promptSuggestion", promptSuggestion)
      .handle("promptAsync", promptAsync)
      .handle("command", command)
      .handle("shell", shell)
      .handle("revert", revert)
      .handle("unrevert", unrevert)
      .handle("permissionRespond", permissionRespond)
      .handle("deleteMessage", deleteMessage)
      .handle("deletePart", deletePart)
      .handle("updatePart", updatePart)
      .handle("contextDiagnostics", contextDiagnostics)
      .handle("contextAttemptResolve", contextAttemptResolve)
      .handle("contextCohort", contextCohort)
      .handle("providerResolutionList", providerResolutionList)
      .handle("providerResolutionResolve", providerResolutionResolve)
      .handle("providerResolutionCommand", providerResolutionCommand)
      .handle("continuationResolutionList", continuationResolutionList)
      .handle("continuationResolutionResolve", continuationResolutionResolve)
      .handle("exportSnapshot", exportSnapshot)
      .handle("importSnapshot", importSnapshot)
      .handle("exportBundle", exportBundle)
      .handle("exportBundleStream", exportBundleStream)
      .handle("importBundle", importBundle)
      .handle("shareBundle", shareBundle)
      .handle("importBundleShare", importBundleShare)
      .handle("revokeBundleShare", revokeBundleShare)
  }),
)
