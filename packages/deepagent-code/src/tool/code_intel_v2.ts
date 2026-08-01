import { CodeIntelFacade } from "@/code-intelligence/facade"
import { ContextFederationContract } from "@deepagent-code/core/context-federation/contract"
import { Effect } from "effect"
import DESCRIPTION from "./code_intel_v2.txt"
import { Tool } from "./tool"

export const Parameters = ContextFederationContract.CodeIntelInput
export const CodeIntelV2Parameters = Parameters

type Metadata = {
  readonly schemaVersion: 2
  readonly result?: CodeIntelFacade.Result
  readonly error?: string
}

export const CodeIntelV2Tool = Tool.define(
  "code_intel",
  Effect.gen(function* () {
    const facade = yield* CodeIntelFacade.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      semanticFingerprint: (input: ContextFederationContract.CodeIntelInput) => ({
        intent: input.intent,
        query: input.query,
        symbol: input.symbol,
        file: input.file,
        kind: input.kind,
        depth: input.depth,
        limit: input.limit,
        consistency: input.consistency,
        cursor: input.cursor,
      }),
      execute: (
        request: ContextFederationContract.CodeIntelInput,
        context: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          yield* context.ask({
            permission: "code_intel",
            patterns: [request.intent],
            always: [request.intent],
            metadata: { intent: request.intent },
          })
          const result = yield* facade.execute({
            request,
            sessionId: context.sessionID,
            agent: context.agent,
          }).pipe(
            Effect.match({
              onFailure: (error) => ({ ok: false as const, error }),
              onSuccess: (value) => ({ ok: true as const, value }),
            }),
          )
          if (!result.ok) {
            const reason = result.error._tag === "CodeQuery.InvalidQueryError"
              ? result.error.reason
              : result.error._tag === "CodeIntelFacade.CursorError"
                ? "cursor_expired_or_invalid"
                : result.error._tag === "CodeIntelFacade.AuthorizationUnavailableError"
                  ? "authorization_unavailable"
                  : result.error._tag === "CodeIntelFacade.ArtifactUnavailableError"
                    ? "audit_storage_unavailable"
                  : "location_index_unavailable"
            return {
              title: "code_intel unavailable",
              output: JSON.stringify({ schemaVersion: 2, error: { reason } }),
              metadata: { schemaVersion: 2, error: reason } satisfies Metadata,
            }
          }
          return {
            title: `code_intel: ${request.intent}`,
            output: JSON.stringify(result.value),
            metadata: { schemaVersion: 2, result: result.value } satisfies Metadata,
          }
        }),
    }
  }),
)
