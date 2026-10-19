export * as RemoteCompaction from "./remote-compaction"

import { LLMError, LLMEvent, isTerminalProviderFailure, type LLMRequest } from "@deepagent-code/llm"
import { OpenAIResponses } from "@deepagent-code/llm/protocols/openai-responses"
import { RequestExecutor } from "@deepagent-code/llm/route"
import { Duration, Effect, Option, Schema, Stream } from "effect"
import type { SessionCompaction } from "./compaction"
import type { Database } from "../database/database"
import type { SessionContext } from "../context-federation/session-context"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { RemoteCompactionBinding } from "./remote-compaction-binding"
import { RemoteCompactionWindow } from "./remote-compaction-window"
import { ModelHardPolicy } from "./runner/model-hard-policy"
import { PreparedProviderTurn } from "./runner/prepared-provider-turn"
import { SessionRunnerCanonical } from "./runner/canonical-turn"
import { V2ProviderTurn } from "./runner/v2-provider-turn"

const Artifact = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("remote_window"), window: RemoteCompactionWindow.State }),
  Schema.Struct({ kind: Schema.Literal("not_supported") }),
])

// Responses compatibility is not a declaration that /compact exists. These canonical
// endpoints are the explicitly supported adapters; arbitrary proxy routes stay local.
export function supported(request: LLMRequest) {
  const binding = RemoteCompactionBinding.identity(request.model)
  if (binding.routeID !== "openai-responses" && binding.routeID !== "openai-compatible-responses") return false
  const base = request.model.route.endpoint.baseURL
  if (!base || !URL.canParse(base)) return false
  const url = new URL(base)
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    !url.search &&
    !url.hash &&
    ((binding.providerID === "openai" &&
      url.hostname === "api.openai.com" &&
      url.pathname.replace(/\/$/, "") === "/v1") ||
      (binding.providerID === "deepseek" &&
        url.hostname === "api.deepseek.com" &&
        ["", "/v1"].includes(url.pathname.replace(/\/$/, ""))))
  )
}

export function replay(receipt: {
  state: string
  outcome_hash: string | null
  outcome_artifact: readonly unknown[] | null
}): SessionCompaction.RemoteCompactionResult {
  if (
    receipt.state !== "settled" ||
    !receipt.outcome_artifact ||
    receipt.outcome_hash !== Hash.sha256(CanonicalJson.stringify(receipt.outcome_artifact))
  )
    return { kind: "recovery_required", reason: "provider_error" }
  const decoded = Schema.decodeUnknownOption(Artifact)(receipt.outcome_artifact[0])
  if (Option.isNone(decoded)) return { kind: "recovery_required", reason: "provider_error" }
  return decoded.value
}

export function make(dependencies: {
  db: Database.Interface["db"]
  contexts: SessionContext.Interface
  providerTurns: V2ProviderTurn.Interface
}) {
  return (
    input: SessionCompaction.RemoteCompactionRequest,
  ): Effect.Effect<SessionCompaction.RemoteCompactionResult, unknown> =>
    Effect.gen(function* () {
      if (input.model !== input.request.model)
        return { kind: "unavailable", reason: "remote_compaction_model_mismatch" } as const
      if (!supported(input.request)) return { kind: "not_supported" } as const
      const budget = PreparedProviderTurn.budget(
        input.model,
        PreparedProviderTurn.estimateFullRequestTokens(input.request),
        0,
      )
      if (budget.decision !== "ok" || budget.provenance !== "model_limit")
        return { kind: "unavailable", reason: "remote_input_budget_unavailable" } as const
      const policy = ModelHardPolicy.decide({
        providerID: String(input.model.provider),
        runtimeModelID: String(input.model.id),
        endpointOrigin: input.model.route.endpoint.baseURL,
        mode: input.mode,
        bufferTokens: 0,
        physicalInputBudget: budget.physicalInputBudget,
        estimatedFullRequestTokens: budget.estimatedFullRequestTokens,
        autoCompact: true,
      })
      if (policy.state !== "managed" || budget.estimatedFullRequestTokens >= policy.policyInputLimit)
        return { kind: "unavailable", reason: "remote_compaction_working_budget_exceeded" } as const
      const requestHash = Hash.sha256(
        CanonicalJson.stringify({
          operation: "responses.compact.v1",
          binding: RemoteCompactionBinding.identity(input.model),
          request: {
            system: input.request.system,
            messages: input.request.messages,
            model: { id: input.model.id, provider: input.model.provider },
          },
        }),
      )
      const identity = {
        sessionId: input.sessionID,
        userMessageId: input.userMessageID,
        historyPromptEpoch: input.historyPromptEpoch,
        requestInputHash: requestHash,
      }
      // Read before admitting: a crash after the provider response must reuse its
      // recorded *complete* window, and an indeterminate dispatch must never retry.
      const prior = yield* V2ProviderTurn.receiptByIdentity(dependencies.db, identity).pipe(Effect.orDie)
      if (prior) {
        const outcome = replay(prior)
        return outcome.kind === "remote_window" && !RemoteCompactionBinding.matches(outcome.window, input.model)
          ? ({ kind: "recovery_required", reason: "provider_error" } as const)
          : outcome
      }
      const receipt = (yield* SessionRunnerCanonical.commitTurn({
        db: dependencies.db,
        contexts: dependencies.contexts,
        sessionID: input.sessionID,
        admission: input.admission,
        receipt: {
          ...identity,
          providerId: input.model.provider,
          modelId: input.model.id,
          protocol: input.model.route.protocol,
          ownerMode: input.ownerMode,
        },
        ownerToken: yield* dependencies.providerTurns.currentOwnerToken(),
      })).receipt
      const artifacts: (typeof Artifact.Type)[] = []
      const usageEvents: LLMEvent[] = []
      yield* V2ProviderTurn.stream({
        service: dependencies.providerTurns,
        receipt,
        prepare: (wireHash) =>
          V2ProviderTurn.prepare(
            {
              receipt,
              stableSystemParts: input.request.system.map((part) => part.text),
              volatileSystemParts: [],
              historyMessages: input.request.messages,
              toolDefinitions: [],
              toolIDs: [],
              toolChoice: null,
              toolResultReferences: [],
              budget,
              userMessageID: input.userMessageID,
              activityID: receipt.activityId,
              providerTurnSeq: receipt.providerTurnSeq,
              contextSelectionID: input.admission.selectionId,
              contextProjectionHash: input.admission.projectionHash,
            },
            wireHash,
          ),
        stream: Stream.fromEffect(
          OpenAIResponses.compactConversation({ request: input.request }).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                if (result.usage)
                  usageEvents.push(LLMEvent.stepFinish({ index: 0, reason: "stop", usage: result.usage }))
              }),
            ),
            Effect.map((result) => ({
              kind: "remote_window" as const,
              window: { ...RemoteCompactionBinding.identity(input.model), output: result.output },
            })),
            // Only a definitive endpoint refusal allows local fallback. Timeouts,
            // malformed success responses and 5xx preserve the original history.
            Effect.catch((error) => {
              const status =
                error instanceof LLMError && "http" in error.reason ? error.reason.http?.response?.status : undefined
              return status === 405 || status === 501
                ? Effect.succeed({ kind: "not_supported" as const })
                : Effect.fail(error)
            }),
            Effect.provide(RequestExecutor.defaultLayer),
            Effect.timeout(Duration.minutes(2)),
            Effect.tap((result) => Effect.sync(() => artifacts.push(result))),
          ),
        ),
        outcomeArtifact: () => [...artifacts, ...usageEvents],
        errorCode: (error) => `compaction_stream_failed:${Hash.sha256(String(error)).slice(0, 16)}`,
        terminalProviderFailure: isTerminalProviderFailure,
      }).pipe(Stream.runDrain)
      return artifacts[0] ?? ({ kind: "recovery_required", reason: "provider_error" } as const)
    }).pipe(
      Effect.catchTag("V2ProviderTurn.UnsafeRetryError", () =>
        Effect.succeed({ kind: "recovery_required", reason: "provider_error" } as const),
      ),
    )
}
