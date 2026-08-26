import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  LLMRequest,
  Message,
  SystemPart,
  isContextOverflowFailure,
  type ProviderErrorEvent,
} from "@deepagent-code/llm"
import { AgentGateway } from "../../agent-gateway"
import { desc, eq } from "drizzle-orm"
import { Cause, DateTime, Effect, Exit, FiberSet, Layer, Option, Schema, Semaphore, Stream } from "effect"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { QuestionV2 } from "../../question"
import { SystemContext } from "../../system-context/index"
import { SystemContextRegistry } from "../../system-context/registry"
import { SkillGuidance } from "../../skill/guidance"
import { ToolRegistry } from "../../tool/registry"
import { ToolOutputStore } from "../../tool-output-store"
import { SessionContextEpoch } from "../context-epoch"
import { SessionCompaction } from "../compaction"
import { SessionContext } from "../../context-federation/session-context"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionInput } from "../input"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { type RunError, Service, StepLimitExceededError } from "./index"
import { SessionRunnerModel } from "./model"
import { PreparedProviderTurn } from "./prepared-provider-turn"
import { V2ToolEffect } from "./v2-tool-effect"
import { createLLMEventPublisher } from "./publish-llm-event"
import { toLLMMessages } from "./to-llm-message"
import { SessionRunnerCanonical } from "./canonical-turn"
import { V2ProviderTurn } from "./v2-provider-turn"
import { V2ProviderTurnReceiptTable } from "./v2-provider-turn.sql"
import { CanonicalJson } from "../../util/canonical-json"
import { Hash } from "../../util/hash"

/**
 * Runs one durable coding-agent Session until it settles.
 *
 * Keep this as orchestration over smaller collaborators rather than rebuilding the legacy
 * `SessionPrompt` monolith. Implement the unchecked items in small reviewed slices:
 *
 * - Session ownership and controls
 *   - [x] Coordinate one local active drain per Session; explicit resumes join and prompt wakeups coalesce.
 *   - [ ] Replace local ownership with durable multi-node ownership when clustered.
 *   - [ ] Mark busy, retrying, idle, interrupted, or terminal-failure status durably.
 *   - [ ] Honor interruption and reject stale work after runtime attachment replacement.
 *   - [x] Bound model steps.
 *   - [ ] Bound provider retries and repeated identical tool calls.
 *
 * - Runtime context assembly
 *   - Keep V1 runtime-context parity enforced by the production runner tests and Context Epoch invariants.
 *
 * - One provider turn
 *   - [x] Translate every projected V2 Session message variant into canonical
 *     `@deepagent-code/llm` messages.
 *   - [ ] Resolve policy-filtered built-in, MCP, plugin, and structured-output tool definitions.
 *   - [x] Stream exactly one `llm.stream(request)` provider turn.
 *   - [x] Persist assistant text and usage events incrementally as they arrive.
 *   - [ ] Persist snapshots, patches, and retry notices incrementally as they arrive.
 *   - [x] Persist reasoning, provider errors, and tool-call events incrementally as they arrive.
 *
 * - Tool settlement and continuation
 *   - [x] Durably record each tool call before side effects begin.
 *   - [x] Authorize and execute recorded local calls through a core-owned registry hook.
 *   - [x] Persist typed success, failure, and provider-executed tool outcomes.
 *   - [x] Start each recorded local call eagerly and await all settlements before continuation.
 *   - [ ] Add scoped runtime context, progress updates, attachment normalization,
 *     plugins, and cancellation settlement.
 *   - [x] Reload projected history and start the next explicit provider turn after local tool results.
 *   - [x] Continue for durable user steering accepted during an active provider turn.
 *   - [x] Continue after compaction: pre-turn budget compaction rebuilds the prepared turn
 *     (RebuildPreparedTurn); a post-dispatch context overflow runs one compaction and the
 *     ContinueAfterOverflowCompaction transition re-runs the turn on the compacted history (one
 *     recovery per turn; a second overflow fails the turn). Manual compaction stays
 *     typed-unavailable on SessionV2.compact until the legacy compaction state machine
 *     (continuation state / soft-landing / remote artifacts) is ported. Other continuation
 *     conditions beyond MAX_STEPS and overflow are not implemented.
 *
 * - Post-run maintenance
 *   - [ ] Settle final status and expose durable output events to replayable consumers.
 *   - [ ] Coalesce streamed deltas and add covering projected-history indexes.
 *   - [ ] Update title, summaries, compaction state, and cleanup in bounded background work.
 *
 * Use `llm.stream(request)` for each provider turn. Keep tool execution and continuation here.
 * Durable activity recovery remains a separate future slice with an explicit retry policy.
 *
 * The current slice loads V2 history, translates it, resolves a model through a core service, and persists one
 * provider turn. Registry definitions are advertised, local tool calls are settled durably, and a
 * bounded explicit loop starts the next provider turn after local settlement.
 */

const MAX_STEPS = 25
const MAX_STEPS_PROMPT = `CRITICAL - MAXIMUM STEPS REACHED

The maximum number of steps allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.

Summarize the work completed so far, list any remaining tasks, and recommend what should happen next. Do not make any tool calls.`

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const tools = yield* ToolRegistry.Service
    const models = yield* SessionRunnerModel.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const systemContext = yield* SystemContextRegistry.Service
    const skillGuidance = yield* SkillGuidance.Service
    const config = yield* Config.Service
    const providerTurns = yield* V2ProviderTurn.Service
    const toolEffects = yield* V2ToolEffect.Service
    const permissionGrantLookup = yield* V2ToolEffect.CurrentPermissionGrantLookup
    // §16.3 order 4 history-epoch bridge: resolved once at layer scope (like the grant lookup) so
    // the captured value reaches every forked drain fiber; undefined keeps the pre-seam identity.
    const historyEpochLookup = yield* V2ProviderTurn.CurrentHistoryEpochLookup
    const contexts = yield* SessionContext.Service
    const ownerAuthorization = yield* V2ProviderTurn.OwnerAuthorization
    const db = (yield* Database.Service).db
    const remoteCompaction = yield* SessionCompaction.CurrentRemoteCompaction
    const compaction = SessionCompaction.make({
      events,
      llm,
      providerTurns,
      db,
      contexts,
      config: yield* config.entries(),
      ...(remoteCompaction ? { remoteCompaction } : {}),
    })
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    const getContext = Effect.fn("SessionRunner.getContext")(function* (sessionID: SessionSchema.ID) {
      return yield* store.context(sessionID)
    })
    const failInterruptedTools = Effect.fn("SessionRunner.failInterruptedTools")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* getContext(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "pending" && tool.state.status !== "running")) continue
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID,
            timestamp: yield* DateTime.now,
            assistantMessageID: message.id,
            callID: tool.id,
            error: { type: "unknown", message: "Tool execution interrupted" },
            provider: {
              executed: tool.provider?.executed === true,
              ...(tool.provider?.metadata === undefined ? {} : { metadata: tool.provider.metadata }),
            },
          })
        }
      }
    })

    const awaitToolFibers = (fibers: FiberSet.FiberSet<void, ToolOutputStore.Error>) =>
      Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers))

    // Match V1: dismissing a question halts the loop instead of becoming model-facing tool output.
    const isQuestionRejected = (cause: Cause.Cause<unknown>) =>
      cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect instanceof QuestionV2.RejectedError)

    type TurnTransition =
      // Request preparation observed a concurrent Session change and must restart from durable state.
      | { readonly _tag: "RebuildPreparedTurn"; readonly promotion?: SessionInput.Delivery; readonly step?: number }
      // Overflow compaction completed; rebuild once through the path without overflow recovery.
      | { readonly _tag: "ContinueAfterOverflowCompaction"; readonly step: number }

    class TurnTransitionError extends Error {
      constructor(readonly transition: TurnTransition) {
        super()
      }
    }

    const rebuildPreparedTurn = (promotion?: SessionInput.Delivery, step?: number) =>
      new TurnTransitionError({ _tag: "RebuildPreparedTurn", promotion, step })
    const continueAfterOverflowCompaction = (step: number) =>
      new TurnTransitionError({
        _tag: "ContinueAfterOverflowCompaction",
        step,
      })

    const retryAgentMismatch = (promotion: SessionInput.Delivery | undefined, step?: number) =>
      Effect.catchDefect((defect) =>
        defect instanceof SessionContextEpoch.AgentMismatch
          ? Effect.die(rebuildPreparedTurn(promotion, step))
          : Effect.die(defect),
      )

    const sameModel = Schema.toEquivalence(Schema.UndefinedOr(ModelV2.Ref))
    const loadSystemContext = (agent: AgentV2.Selection) =>
      Effect.all([systemContext.load(), skillGuidance.load(agent)], { concurrency: "unbounded" }).pipe(
        Effect.map(SystemContext.combine),
      )

    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      recoverOverflow?: typeof compaction.compactAfterOverflow,
    ) {
      const parityCampaign = (yield* V2ProviderTurn.CurrentCampaign) ?? V2ProviderTurn.campaignFromEnv()
      const ownerCampaign = (yield* V2ProviderTurn.CurrentOwnerCampaign) ?? V2ProviderTurn.ownerCampaignFromEnv()
      if (!(yield* ownerAuthorization.authorize(db, ownerCampaign)))
        return yield* new V2ProviderTurn.ConflictError({ reason: "v2_owner_campaign_not_verified" })
      if (parityCampaign && ownerCampaign)
        return yield* new V2ProviderTurn.ConflictError({ reason: "v2_owner_cannot_record_shadow_parity" })
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      const agent = yield* agents.select(session.agent)
      const initialized = yield* SessionContextEpoch.initialize(
        db,
        loadSystemContext(agent),
        session.id,
        session.location,
        agent.id,
      ).pipe(retryAgentMismatch(promotion))
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      let needsContinuation = false
      const promoted = yield* Effect.gen(function* () {
        if (!promotion) return [] as readonly string[]
        const cutoff = yield* SessionInput.latestSeq(db, session.id)
        if (promotion === "steer") return yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        const queued = yield* SessionInput.promoteNextQueued(db, events, session.id)
        const steers = yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        return queued === undefined ? steers : [queued, ...steers]
      })
      const currentStep = promoted.length > 0 ? 1 : step
      const system =
        initialized ??
        (yield* SessionContextEpoch.prepare(
          db,
          events,
          loadSystemContext(agent),
          session.id,
          session.location,
          agent.id,
        ).pipe(retryAgentMismatch(undefined, currentStep)))
      const current = yield* getSession(sessionID)
      if ((yield* agents.select(current.agent)).id !== agent.id || !sameModel(current.model, session.model))
        return yield* Effect.die(rebuildPreparedTurn(undefined, currentStep))
      const model = yield* models.resolve(session)
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
      const context = entries.map((entry) => entry.message)
      const currentUserMessageID = context.findLast((message) => message.type === "user")?.id
      const latestReceipt = currentUserMessageID
        ? undefined
        : yield* db
            .select({
              userMessageID: V2ProviderTurnReceiptTable.user_message_id,
              state: V2ProviderTurnReceiptTable.state,
            })
            .from(V2ProviderTurnReceiptTable)
            .where(eq(V2ProviderTurnReceiptTable.session_id, session.id))
            .orderBy(desc(V2ProviderTurnReceiptTable.request_ordinal))
            .get()
            .pipe(Effect.orDie)
      if (
        latestReceipt &&
        ["preparing", "dispatching", "streaming", "indeterminate_after_crash"].includes(latestReceipt.state)
      )
        return yield* new V2ProviderTurn.UnsafeRetryError({ state: latestReceipt.state })
      // Compaction can replace the visible user prefix with a summary. Until the canonical V2 turn-id
      // schema lands, bind that continuation to the latest settled/failed durable receipt identity.
      // A truly empty imported Session still has no identity and must not dispatch.
      const receiptUserMessageID = currentUserMessageID ?? latestReceipt?.userMessageID
      if (!receiptUserMessageID) return { needsContinuation: false, step: currentStep }
      const toolMaterialization = yield* tools.materialize(agent.info?.permissions)
      const stepLimitReached = agent.info?.steps !== undefined && currentStep >= agent.info.steps
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      const deepagentSystem = AgentGateway.systemPrompt(model.provider)
      const requestSystem =
        deepagentSystem.length > 0
          ? deepagentSystem
          : [agent.info?.system, system.baseline].filter(
              (part): part is string => part !== undefined && part.length > 0,
            )
      const requestMessages = [
        ...toLLMMessages(context, model),
        ...(stepLimitReached ? [Message.assistant(MAX_STEPS_PROMPT)] : []),
      ]
      const request = LLM.request({
        model,
        providerOptions: { openai: { promptCacheKey } },
        system: requestSystem.map(SystemPart.make),
        messages: requestMessages,
        tools: toolMaterialization.definitions,
        toolChoice: stepLimitReached ? "none" : undefined,
        metadata: {
          "deepagent-code": {
            callKind: "session_turn",
            feature: "v2_session_chat",
            sessionID: session.id,
            messageID: receiptUserMessageID,
            agent: agent.id,
          },
        },
      })
      // Canonical activity/selection admission: the runner takes its durable identity from the
      // promoted inputs (or the surrounding turn identity for continuations), never from derived keys.
      const selectionAdmission = yield* SessionRunnerCanonical.admitSelection({
        db,
        contexts,
        sessionID: session.id,
        agent: agent.id,
        location: session.location,
        promotedInputIds: promoted,
        fallbackUserInputId: receiptUserMessageID,
        system: { baseline: system.baseline, revision: system.revision, baselineSeq: system.baselineSeq },
        historyEndMessageId: context.at(-1)?.id,
      })
      // An interrupted turn must terminalize the activity it admitted; otherwise the leftover
      // `active` activity blocks every future queued admission on this Session. The per-turn scope
      // closes on interruption too, and settleActivity is idempotent.
      yield* Effect.addFinalizer((exit) =>
        Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
          ? contexts
              .settleActivity({ activityId: selectionAdmission.activityId, state: "interrupted" })
              .pipe(Effect.ignore)
          : Effect.void,
      )
      // §16.3 order 4: the receipt's history-window identity comes from the optional epoch bridge;
      // unwired compositions (or a lookup fault) keep the ContextEpoch revision exactly as before.
      // Identity stability: the read happens BEFORE compactIfNeeded and is replayed in the same
      // order after a crash, so the value is stable across exact retries; a compaction committed
      // within this turn rebuilds the prepared turn (new request input) rather than reusing this
      // identity, and the single-owner invariant rules out a concurrent epoch advance.
      const historyPromptEpoch =
        (historyEpochLookup
          ? yield* historyEpochLookup(session.id).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          : undefined) ?? system.revision
      if (
        yield* compaction.compactIfNeeded({
          sessionID: session.id,
          entries,
          model,
          request,
          userMessageID: receiptUserMessageID,
          historyPromptEpoch,
          ownerMode: parityCampaign ? "shadow_v2" : "v2",
          admission: selectionAdmission,
        })
      )
        return yield* Effect.die(rebuildPreparedTurn(undefined, currentStep))
      // One recoverable boundary: canonical attempt + V2 receipt are created and bound atomically.
      const requestInputHash = Hash.sha256(
        CanonicalJson.stringify({
          ...LLMRequest.input(request),
          model: {
            id: request.model.id,
            provider: request.model.provider,
          },
        }),
      )
      const providerReceipt = (
        yield* SessionRunnerCanonical.commitTurn({
          db,
          contexts,
          sessionID: session.id,
          admission: selectionAdmission,
          receipt: {
            sessionId: session.id,
            userMessageId: receiptUserMessageID,
            historyPromptEpoch,
            historySourceEndMessageId: context.at(-1)?.id,
            requestInputHash,
            providerId: model.provider,
            modelId: model.id,
            protocol: model.route.protocol,
            ownerMode: parityCampaign ? "shadow_v2" : "v2",
          },
          ownerToken: providerTurns.ownerToken,
        })
      ).receipt
      const publisher = createLLMEventPublisher(events, {
        sessionID: session.id,
        agent: agent.id,
        model: {
          id: ModelV2.ID.make(model.id),
          providerID: ProviderV2.ID.make(model.provider),
          ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
        },
      })
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(publisher.publish(event, outputPaths))
      const baseSettleTool: ToolRegistry.Materialization["settle"] = stepLimitReached
        ? () =>
            Effect.succeed({
              result: { type: "error", value: "Tools are disabled after the maximum agent steps" },
            })
        : toolMaterialization.settle
      // Durable tool-effect authority (§16.3 order 1): every settled call records exactly one
      // terminal row bound to the attempt/receipt that offered it. Capability classification is
      // not yet wired into the V2 registry, so effects are recorded conservatively as mutating —
      // watermark proofs must never undercount side effects. A settlement that dies leaves no row:
      // the enclosing turn receipt quarantines indeterminate, the recovery authority for unknown
      // outcomes.
      const recordToolEffect = (
        input: Parameters<ToolRegistry.Materialization["settle"]>[0],
        state: "settled" | "failed",
        result: unknown,
        errorCode: string | undefined,
      ) => {
        const attemptId = providerReceipt.providerAttemptId
        if (attemptId === undefined) return Effect.die("tool effect requires a bound provider attempt")
        // Permission grant evidence: when the composition wires the V2 permission capability,
        // bind the first grant for this call onto the effect row. A lookup failure records the
        // effect grant-less rather than losing the settlement evidence (fail-closed but not
        // evidence-destroying).
        const lookupGrant = permissionGrantLookup
          ? permissionGrantLookup({
              sessionID: input.sessionID,
              toolCallID: input.call.id,
              toolName: input.call.name,
            }).pipe(
              Effect.map((grants) => {
                const first = grants[0]
                return first === undefined
                  ? {}
                  : {
                      grant: { receiptId: first.receiptID, ownerId: first.ownerID, state: first.state, version: first.version },
                    }
              }),
              // The seam's error channel is never, so a wired lookup can only fail by defect;
              // catch the full cause so a broken lookup degrades to grant-less evidence instead
              // of destroying the settlement record.
              Effect.catchCause(() => Effect.succeed({})),
            )
          : Effect.succeed({})
        return lookupGrant.pipe(
          Effect.flatMap((grantEvidence) =>
            toolEffects.record({
              sessionId: input.sessionID,
              providerAttemptId: attemptId,
              receiptId: providerReceipt.receiptId,
              toolCallId: input.call.id,
              toolName: input.call.name,
              effectKind: "mutating",
              state,
              outcomeHash: Hash.sha256(CanonicalJson.stringify(result)),
              ...(errorCode === undefined ? {} : { errorCode }),
              ...grantEvidence,
              ownerToken: providerTurns.ownerToken,
              now: Date.now(),
            }),
          ),
          Effect.orDie,
        )
      }
      // Only typed settlement failures record a `failed` row. Defects and interrupts leave no
      // row: the enclosing turn receipt quarantines indeterminate, which is the recovery
      // authority for unknown outcomes (`tapError` observes typed errors only and never
      // captures defects or interrupts).
      const settleTool: ToolRegistry.Materialization["settle"] = (input) =>
        baseSettleTool(input).pipe(
          Effect.tap((settlement) => recordToolEffect(input, "settled", settlement.result, undefined)),
          Effect.tapError(() =>
            recordToolEffect(input, "failed", { type: "error", value: "settlement_failed" }, "tool_settlement_failed"),
          ),
        )
      let overflowFailure: ProviderErrorEvent | undefined
      const providerEvents: LLMEvent[] = []
      // Any rebuild after admit must terminalize the admitted receipt first: an epoch that is no
      // longer current invalidates the prepared request, and a leftover `preparing` receipt would
      // otherwise survive the rebuild as an orphan the recovery classifier cannot attribute. The
      // abandon is CAS-bound to `preparing`, so losing it means the receipt already moved; a failed
      // terminalize is logged but must not block the rebuild itself.
      const terminalizePreDispatch = (errorCode: string) =>
        providerTurns.abandon(providerReceipt, errorCode).pipe(
          Effect.tapCause((cause) =>
            Effect.logWarning("failed to terminalize preparing receipt before rebuild", {
              cause: Cause.pretty(cause),
              errorCode,
            }),
          ),
          Effect.ignore,
          Effect.uninterruptible,
        )
      const epochCurrent = yield* SessionContextEpoch.current(db, session.id, agent.id, system.revision).pipe(
        Effect.onInterrupt(() => terminalizePreDispatch("turn_aborted_before_dispatch")),
      )
      if (!epochCurrent) {
        yield* terminalizePreDispatch("epoch_mismatch_rebuild")
        return yield* Effect.die(rebuildPreparedTurn(undefined, currentStep))
      }
      const providerStream = V2ProviderTurn.stream({
        service: providerTurns,
        receipt: providerReceipt,
        prepare: (wireRequestHash) =>
          V2ProviderTurn.prepare(
            {
              receipt: providerReceipt,
              stableSystemParts: [system.baseline],
              volatileSystemParts: PreparedProviderTurn.mergeSystemParts([agent.info?.system], deepagentSystem),
              historyMessages: requestMessages,
              toolDefinitions: toolMaterialization.definitions,
              toolIDs: toolMaterialization.definitions.map((tool) => tool.name),
              toolChoice: stepLimitReached ? "none" : null,
              toolResultReferences: context.flatMap((message) =>
                message.type === "assistant"
                  ? message.content.flatMap((part) =>
                      part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")
                        ? [part.id]
                        : [],
                    )
                  : [],
              ),
              samplingMaxOutputTokens: request.generation?.maxTokens,
              budget: PreparedProviderTurn.budget(model),
              userMessageID: receiptUserMessageID,
              activityID: providerReceipt.activityId,
              providerTurnSeq: providerReceipt.providerTurnSeq,
              contextSelectionID: selectionAdmission.selectionId,
              contextProjectionHash: selectionAdmission.projectionHash,
            },
            wireRequestHash,
          ),
        stream: llm.stream(request).pipe(Stream.tap((event) => Effect.sync(() => providerEvents.push(event)))),
        outcomeArtifact: () => providerEvents,
        errorCode: (error) => `provider_stream_failed:${Hash.sha256(String(error)).slice(0, 16)}`,
        // Context overflow is rejected by the provider before any generation or tool call, so it is a
        // proven-terminal failure that may settle as `failed` and drive overflow compaction recovery.
        // Any other post-dispatch typed failure cannot prove a terminal outcome and stays
        // indeterminate/recovery_required.
        terminalProviderFailure: isContextOverflowFailure,
      })
      const settledProviderStream = providerStream.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (overflowFailure || publisher.hasProviderError()) return
            if (LLMEvent.is.providerError(event)) {
              if (isContextOverflowFailure(event) && !publisher.hasAssistantStarted()) {
                overflowFailure = event
                return
              }
            }
            yield* publish(event)
            if (event.type !== "tool-call" || event.providerExecuted) return
            if (!stepLimitReached) needsContinuation = true
            const assistantMessageID = yield* publisher.assistantMessageID(event.id)
            yield* Effect.uninterruptibleMask((restore) =>
              restore(
                settleTool({
                  sessionID: session.id,
                  agent: agent.id,
                  assistantMessageID,
                  call: event,
                }),
              ).pipe(
                Effect.flatMap((settlement) =>
                  publish(
                    LLMEvent.toolResult({
                      id: event.id,
                      name: event.name,
                      result: settlement.result,
                      output: settlement.output,
                    }),
                    settlement.outputPaths ?? [],
                  ),
                ),
              ),
            ).pipe(FiberSet.run(toolFibers))
          }),
        ),
        Effect.ensuring(withPublication(publisher.flush())),
      )

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const stream = yield* restore(settledProviderStream).pipe(Effect.exit)
          const failure =
            stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
          if (
            recoverOverflow &&
            !publisher.hasAssistantStarted() &&
            isContextOverflowFailure(overflowFailure ?? failure) &&
            (yield* restore(
              recoverOverflow({
                sessionID: session.id,
                entries,
                model,
                request,
                userMessageID: receiptUserMessageID,
                historyPromptEpoch,
                ownerMode: parityCampaign ? "shadow_v2" : "v2",
                admission: selectionAdmission,
              }),
            ))
          )
            return yield* Effect.die(continueAfterOverflowCompaction(currentStep))
          if (overflowFailure) yield* publish(overflowFailure)
          const llmFailure = failure instanceof LLMError ? failure : undefined
          if (llmFailure && !publisher.hasProviderError()) {
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
            yield* withPublication(
              events.publish(SessionEvent.Step.Failed, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(),
                error: { type: "unknown", message: llmFailure.reason.message },
              }),
            )
          }
          if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) yield* FiberSet.clear(toolFibers)
          const settled = yield* restore(awaitToolFibers(toolFibers)).pipe(Effect.exit)
          if (settled._tag === "Failure" && isQuestionRejected(settled.cause)) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            return yield* Effect.interrupt
          }
          if (
            (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) ||
            (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
          ) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
          }
          if (settled._tag === "Failure" && !Cause.hasInterrupts(settled.cause)) {
            const failure = Cause.squash(settled.cause)
            const message = failure instanceof Error ? failure.message : String(failure)
            yield* withPublication(publisher.failUnsettledTools(`Tool execution failed: ${message}`))
          }
          if (publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
          if (stream._tag === "Success" && !publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
          if (stream._tag === "Failure") return yield* Effect.failCause(stream.cause)
          if (settled._tag === "Failure") return yield* Effect.failCause(settled.cause)
          if (parityCampaign && providerReceipt)
            yield* providerTurns.recordParityForReceipt({ campaign: parityCampaign, receipt: providerReceipt })
          return {
            needsContinuation: !publisher.hasProviderError() && needsContinuation,
            step: currentStep,
            activityId: selectionAdmission.activityId,
          }
        }),
      )
    }, Effect.scoped)
    type RunTurn = (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
    ) => Effect.Effect<
      { readonly needsContinuation: boolean; readonly step: number; readonly activityId?: string },
      RunError
    >

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step) {
      return yield* runTurnAttempt(sessionID, promotion, step).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
            yield* Effect.yieldNow
            return yield* runAfterOverflowCompaction(
              sessionID,
              defect.transition.promotion,
              defect.transition.step ?? step,
            )
          }),
        ),
      )
    })

    const runTurn: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step) {
      return yield* runTurnAttempt(sessionID, promotion, step, compaction.compactAfterOverflow).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            yield* Effect.yieldNow
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step)
            return yield* runTurn(sessionID, defect.transition.promotion, defect.transition.step ?? step)
          }),
        ),
      )
    })

    const run = Effect.fn("SessionRunner.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force?: boolean
    }) {
      const hasSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
      const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
      if (input.force !== true && !hasSteer && !hasQueue) return
      const parityCampaign = (yield* V2ProviderTurn.CurrentCampaign) ?? V2ProviderTurn.campaignFromEnv()
      const ownerCampaign = (yield* V2ProviderTurn.CurrentOwnerCampaign) ?? V2ProviderTurn.ownerCampaignFromEnv()
      if (!(yield* ownerAuthorization.authorize(db, ownerCampaign)))
        return yield* new V2ProviderTurn.ConflictError({ reason: "v2_owner_campaign_not_verified" })
      if (parityCampaign && ownerCampaign)
        return yield* new V2ProviderTurn.ConflictError({ reason: "v2_owner_cannot_record_shadow_parity" })
      yield* failInterruptedTools(input.sessionID)
      let promotion: SessionInput.Delivery | undefined = hasSteer ? "steer" : hasQueue ? "queue" : undefined
      let openActivity = input.force === true || hasSteer || hasQueue
      while (openActivity) {
        let needsContinuation = true
        let step = 1
        let activityId: string | undefined
        for (let attempt = 0; attempt < MAX_STEPS; attempt++) {
          const result = yield* runTurn(input.sessionID, promotion, step)
          needsContinuation = result.needsContinuation
          step = result.step + 1
          promotion = "steer"
          activityId = result.activityId ?? activityId
          if (!needsContinuation) needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
          if (!needsContinuation) break
        }
        if (needsContinuation)
          return yield* new StepLimitExceededError({ sessionID: input.sessionID, limit: MAX_STEPS })
        // One activity's turn chain is complete: settle it so a queued input may open the next
        // activity. Settle is idempotent and best-effort; recovery owns activities a drain never
        // settles. Interrupted turns settle their own activity through the per-turn scope
        // finalizer in runTurnAttempt.
        if (activityId !== undefined)
          yield* Effect.uninterruptible(contexts.settleActivity({ activityId, state: "settled" })).pipe(
            Effect.ignore,
          )
        openActivity = yield* SessionInput.hasPending(db, input.sessionID, "queue")
        promotion = openActivity ? "queue" : undefined
      }
    })

    return Service.of({
      run,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(V2ProviderTurn.ownerAuthorizationLayer))
