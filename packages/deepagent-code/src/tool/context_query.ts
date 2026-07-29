import { ContextQueryFacade } from "@/context-federation/context-query-facade"
import { ContextFederationContract } from "@deepagent-code/core/context-federation/contract"
import { Effect } from "effect"
import DESCRIPTION from "./context_query.txt"
import { Tool } from "./tool"

export const Parameters = ContextFederationContract.ContextQueryInput
export const ContextQueryParameters = Parameters

type Metadata = {
  readonly schemaVersion: 1
  readonly result?: ContextQueryFacade.Result
  readonly error?: string
}

export const ContextQueryTool = Tool.define(
  "context_query",
  Effect.gen(function* () {
    const facade = yield* ContextQueryFacade.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      semanticFingerprint: (input: ContextFederationContract.ContextQueryInput) => ({
        intent: input.intent,
        query: input.query,
        sources: input.sources,
        ref: input.ref,
        relation: input.relation,
        limit: input.limit,
        consistency: input.consistency,
        cursor: input.cursor,
      }),
      execute: (
        request: ContextFederationContract.ContextQueryInput,
        context: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          yield* context.ask({
            permission: "context_query",
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
            const reason = result.error._tag === "FederatedContextQuery.InvalidQueryError"
              ? result.error.reason
              : result.error._tag === "ContextQueryFacade.AuthorizationUnavailableError"
                ? "authorization_unavailable"
                : result.error._tag === "ContextQueryFacade.ArtifactUnavailableError"
                  ? "audit_storage_unavailable"
                  : result.error._tag === "ContextQueryFacade.TokenError"
                    ? "ref_cursor_expired_or_invalid"
                    : "federated_context_unavailable"
            return {
              title: "context_query unavailable",
              output: JSON.stringify({ schemaVersion: 1, error: { reason } }),
              metadata: { schemaVersion: 1, error: reason } satisfies Metadata,
            }
          }
          return {
            title: `context_query: ${request.intent}`,
            output: JSON.stringify(result.value),
            metadata: { schemaVersion: 1, result: result.value } satisfies Metadata,
          }
        }),
    }
  }),
)
