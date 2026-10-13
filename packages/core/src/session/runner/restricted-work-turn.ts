export * as RestrictedWorkTurn from "./restricted-work-turn"

import { LLM, LLMRequest } from "@deepagent-code/llm"
import type { RequestExecutor } from "@deepagent-code/llm/route"
import { Duration, Effect, Option, Schema, Scope } from "effect"
import type { Database } from "../../database/database"
import type { EventV2 } from "../../event"
import type { SessionContext } from "../../context-federation/session-context"
import { CanonicalJson } from "../../util/canonical-json"
import { Hash } from "../../util/hash"
import { buildCapabilityEvidence, protocolAttemptIdentityFor, protocolAttemptIdentityHash } from "../../model-protocol"
import { SessionInput } from "../input"
import { SessionSchema } from "../schema"
import type { SessionStore } from "../store"
import { WorkAuthority } from "../work-authority"
import { WorkAuthoritySchema } from "../work-authority.schema"
import { WorkExecutionProfile } from "../work-execution-profile"
import { WorkRoutePolicy } from "../work-route-policy"
import { WorkToolPolicy } from "../work-tool-policy"
import { SessionRunnerCanonical } from "./canonical-turn"
import type { SessionRunnerModel } from "./model"
import { V2ProviderTurn } from "./v2-provider-turn"
import { ToolRegistry } from "../../tool/registry"
import { ReadTool } from "../../tool/read"
import { AgentV2 } from "../../agent"
import { SessionMessage } from "../message"
import { toLLMMessages } from "./to-llm-message"

/** Prepare one turn for the EXISTING runner. No coordinator, model loop, ordinary Context source,
 * tool registry, filesystem discovery, learning hook or compaction is installed here. */
export const prepare = Effect.fn("RestrictedWorkTurn.prepare")(function* (input: {
  readonly db: Database.Interface["db"]
  readonly events: EventV2.Interface
  readonly contexts: SessionContext.Interface
  readonly store: SessionStore.Interface
  readonly models: SessionRunnerModel.Interface
  readonly providerTurns: V2ProviderTurn.Interface
  readonly tools?: ToolRegistry.Interface
  readonly agents?: AgentV2.Interface
  readonly work: WorkAuthority.Work
  readonly location: { readonly directory: string; readonly workspaceID?: string }
}) {
  const scope = yield* Scope.Scope
  const installed = yield* Effect.serviceOption(WorkExecutionProfile.Service)
  if (Option.isNone(installed))
    return yield* refused("PROFILE_UNAVAILABLE", "Restricted runtime profile is not installed")
  const profile = installed.value
  // Entry/model observation can outlive the short native source witness. Each consumption
  // boundary needs a new original capture rather than a still-valid near-expiry cache entry.
  const refreshSource = () => profile.prepareSource?.(input.work, { fresh: true }) ?? Effect.void
  yield* refreshSource()
  const work = yield* WorkAuthority.requireContext(input.db, { sessionID: input.work.session_id }).pipe(
    Effect.mapError(authorityError),
  )
  if (!work || work.work_id !== input.work.work_id || work.control_revision !== input.work.control_revision)
    return yield* refused("WORK_CONTROL_CONFLICT", "Work changed before restricted turn preparation")
  yield* WorkExecutionProfile.requirePlacement(input.db, work).pipe(Effect.mapError(authorityError))
  if (
    work.binding.location.workspaceID !== undefined ||
    work.binding.location.directory !== input.location.directory ||
    input.location.workspaceID !== undefined ||
    work.binding.budget.maxCompletionTokens < 16
  )
    return yield* refused("PROFILE_UNAVAILABLE", "Restricted placement or Responses output ceiling is unavailable")
  const sessionID = SessionSchema.ID.make(work.session_id)
  const session = yield* input.store.get(sessionID)
  if (
    !session ||
    session.location.directory !== input.location.directory ||
    session.location.workspaceID !== undefined ||
    session.agent !== work.binding.agentID ||
    session.model?.providerID !== work.binding.provider.providerID ||
    session.model.id !== work.binding.provider.modelID
  )
    return yield* refused("WORK_BINDING_CONFLICT", "Actual Session differs from its immutable Work binding")
  const resolved = yield* input.models.resolve(session)
  const runtime = yield* profile.observe({ sessionID, resolved })
  if (
    !Schema.is(WorkRoutePolicy.Runtime)(runtime) ||
    runtime.providerID !== resolved.model.provider ||
    runtime.modelID !== resolved.model.id ||
    runtime.routeID !== resolved.model.route.id ||
    runtime.protocol !== resolved.model.route.protocol ||
    runtime.configurationHash !== work.binding.provider.configurationHash ||
    runtime.providerID !== work.binding.provider.providerID ||
    runtime.modelID !== work.binding.provider.modelID ||
    runtime.protocol !== work.binding.provider.protocol
  )
    return yield* refused("PROFILE_UNAVAILABLE", "Actual resolved model/client has no matching approved runtime")
  // Promotion remains durable and Session-owned. The canonical seam rejects any other input,
  // projection, graph context or permission; no ordinary source load precedes this boundary.
  yield* refreshSource()
  yield* WorkAuthority.requireContext(input.db, { sessionID }).pipe(Effect.mapError(authorityError))
  yield* SessionInput.promoteNextQueued(input.db, input.events, sessionID)
  // The canonical selection owns previous-outcome preparation followed by its own fresh source
  // capture and immediate SQL fence. Repeating that I/O here consumes the promotion witness.
  const selected = yield* SessionRunnerCanonical.admitRestrictedSelection({
    db: input.db,
    contexts: input.contexts,
    sessionID,
    workID: work.work_id,
    expectedRevision: work.control_revision,
  }).pipe(Effect.mapError(authorityError))
  const materialization = work.binding.schemaVersion === "work-execution.v2" ? yield* Effect.gen(function* () {
    if (!input.tools || !input.agents) return yield* refused("PROFILE_UNAVAILABLE", "Project tool registration is unavailable")
    const agent = yield* input.agents.select(session.agent)
    if (agent.id !== work.binding.agentID) return yield* refused("WORK_BINDING_CONFLICT", "Project agent changed")
    return yield* input.tools.materialize({ rulesets: [agent.info?.permissions ?? [], session.permissions] })
  }) : undefined
  const nativeWrite = work.binding.schemaVersion === "work-execution.v2" ? yield* Effect.gen(function* () {
    const { WriteTool } = yield* Effect.promise(() => import("../../tool/write"))
    return WriteTool
  }) : undefined
  const nativeCommand = work.binding.schemaVersion === "work-execution.v2" ? yield* Effect.gen(function* () {
    const { ManagedCommandTool } = yield* Effect.promise(() => import("../../tool/work-command"))
    return ManagedCommandTool
  }) : undefined
  const nativeTask = work.binding.schemaVersion === "work-execution.v2" &&
    work.binding.profile.id === "project_shared_root_v1" && work.binding.parentWorkID === undefined &&
    work.binding.childPolicy !== "deny_all" && work.binding.childPolicy.kind === "shared_root_v1"
    ? yield* Effect.gen(function* () {
        const { TaskTool } = yield* Effect.promise(() => import("../../tool/task"))
        return TaskTool
      })
    : undefined
  const definitions = work.binding.schemaVersion === "work-execution.v2" && materialization
    ? yield* Effect.forEach(work.binding.toolPolicy.capabilities, (allowed) => Effect.gen(function* () {
        const actual = ToolRegistry.inspect(materialization, allowed.toolID)
        const native = actual && (allowed.toolID === "read" ? ReadTool.isNativeRead(actual.tool)
          : allowed.toolID === "write" ? nativeWrite?.isNativeWrite(actual.tool)
          : allowed.toolID === "managed_command" ? nativeCommand?.isNativeCommand(actual.tool)
          : allowed.toolID === "task" && nativeTask?.isNativeTask(actual.tool))
        if (!actual || !native || allowed.operations.some((operation) => operation !== (allowed.toolID === "managed_command" ? "run" : allowed.toolID === "task" ? "delegate" : allowed.toolID)) ||
          Hash.sha256(CanonicalJson.stringify(actual.definition)) !== allowed.definitionHash)
          return yield* refused("PROFILE_UNAVAILABLE", "An explicitly approved project tool has no current native adapter")
        return actual.definition
      })) : []
  const history = work.binding.schemaVersion === "work-execution.v2"
    ? yield* Effect.forEach(selected.history, (row) => Schema.decodeUnknownEffect(SessionMessage.Message)({
        ...row.data, id: row.id, type: row.type,
      }).pipe(Effect.mapError(authorityError))) : []
  // Provider metadata/reasoning is not a grant to replay opaque provider context. The original
  // rows remain durable; this profile only discloses their text and authenticated local results.
  const messages = history.flatMap((message): SessionMessage.Message[] => message.type === "user" ? [message]
    : message.type === "assistant" ? [{ ...message, metadata: undefined,
        content: message.content.filter((part) => part.type !== "reasoning").map((part) =>
          part.type === "tool" ? { ...part, provider: undefined } : part),
      }] : [])
  const request = LLM.request({
    model: resolved.model,
    system: selected.instructions,
    ...(work.binding.schemaVersion === "work-execution.v2"
      ? { messages: toLLMMessages(messages, resolved.model), tools: definitions } : { prompt: selected.auditedText }),
    generation: { maxTokens: work.binding.budget.maxCompletionTokens },
    providerOptions: { openai: { store: false } },
  })
  const protocolIdentity = resolved.info === undefined ? undefined : protocolAttemptIdentityFor(
    resolved.info, resolved.provider, buildCapabilityEvidence(resolved.info, resolved.provider),
  )
  const protocolIdentityHash = protocolIdentity === undefined ? undefined : protocolAttemptIdentityHash(protocolIdentity)
  const committed = yield* SessionRunnerCanonical.commitTurn({
    db: input.db,
    contexts: input.contexts,
    sessionID,
    admission: selected.admission,
    ...(protocolIdentityHash === undefined ? {} : { protocolAttemptIdentityHash: protocolIdentityHash }),
    ownerToken: yield* input.providerTurns.currentOwnerToken(),
    receipt: {
      sessionId: sessionID,
      userMessageId: work.input_id,
      historyPromptEpoch: 0,
      historySourceEndMessageId: selected.history.at(-1)?.id ?? work.input_id,
      requestInputHash: Hash.sha256(
        CanonicalJson.stringify({
          ...LLMRequest.input(request),
          model: { id: request.model.id, provider: request.model.provider },
        }),
      ),
      providerId: resolved.model.provider,
      modelId: resolved.model.id,
      protocol: resolved.model.route.protocol,
      ownerMode: "v2",
    },
  }).pipe(Effect.mapError(authorityError))
  const beforeSeal = (wire: RequestExecutor.RequestSealInput) =>
    Effect.gen(function* () {
      yield* refreshSource()
      const current = yield* WorkAuthority.requireContext(input.db, { sessionID }).pipe(Effect.mapError(authorityError))
      if (!current || current.work_id !== work.work_id || current.control_revision !== work.control_revision)
        return yield* refused("WORK_CONTROL_CONFLICT", "Work changed before count disclosure")
      yield* WorkExecutionProfile.requirePlacement(input.db, current).pipe(Effect.mapError(authorityError))
      const authorized = yield* WorkRoutePolicy.authorizeCount(
        { binding: current.binding, auditedText: selected.auditedText, runtime, wire },
        { allowLoopbackHTTP: current.loopback_http },
      )
      const remaining = Math.min(
        10_000,
        current.binding.deadline - Date.now(),
        current.created_at + current.binding.budget.maxDurationMs - Date.now(),
      )
      if (remaining <= 0) return yield* refused("WORK_EXPIRED", "Work expired before count acquisition")
      yield* profile
        .acquireCount({
          workID: current.work_id,
          controlRevision: current.control_revision,
          receiptID: committed.receipt.receiptId,
          runtime,
          route: authorized.route,
          wire,
        })
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.timeout(Duration.millis(remaining)),
          Effect.mapError((error) =>
            error instanceof WorkAuthoritySchema.Error
              ? error
              : refused("PROFILE_UNAVAILABLE", "Authenticated input count did not complete within its deadline"),
          ),
        )
      // Count acquisition is deliberately outside SQL; the real seal rechecks source/route and
      // consumes this receipt in its atomic receipt/attempt/Work dispatch transaction.
      yield* refreshSource()
    })
  return { session, work, selected, request, materialization, definitions, receipt: committed.receipt, runtime, protocolIdentity, protocolIdentityHash, beforeSeal, refreshSource, bind: () => profile.bind(runtime, request), current: () => Effect.gen(function* () {
    if (materialization) for (const definition of definitions) {
      const current = ToolRegistry.inspect(materialization, definition.name)
      const native = current && (definition.name === "read" ? ReadTool.isNativeRead(current.tool)
        : definition.name === "write" ? nativeWrite?.isNativeWrite(current.tool)
        : definition.name === "managed_command" ? nativeCommand?.isNativeCommand(current.tool)
        : definition.name === "task" && nativeTask?.isNativeTask(current.tool))
      if (!current || !native || CanonicalJson.stringify(current.definition) !== CanonicalJson.stringify(definition))
        return yield* refused("WORK_BINDING_CONFLICT", "Project tool advertisement changed before dispatch")
    }
    yield* profile.current(runtime)
  }) }
})

function refused(code: WorkAuthoritySchema.ErrorCode, message: string) {
  return new WorkAuthoritySchema.Error({ code, message })
}

function authorityError(error: unknown) {
  return error instanceof WorkAuthoritySchema.Error
    ? error
    : refused("WORK_RECOVERY_REQUIRED", "Restricted canonical authority or durable preparation is unavailable")
}
