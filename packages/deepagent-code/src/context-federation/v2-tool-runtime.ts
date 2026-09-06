export * as V2ContextToolRuntime from "./v2-tool-runtime"

import { CodeIntelFacade } from "@/code-intelligence/facade"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { ContextToolRuntime } from "@deepagent-code/core/context-federation/tool-runtime"
import { Effect, Layer } from "effect"
import { ContextQueryFacade } from "./context-query-facade"

/** Adapts the host graph facades to Core's canonical V2 tool seam for one Location instance. */
export function layer(ctx: InstanceContext) {
  return Layer.effect(
    ContextToolRuntime.Service,
    Effect.gen(function* () {
      const codeIntel = yield* CodeIntelFacade.Service
      const contextQuery = yield* ContextQueryFacade.Service
      return ContextToolRuntime.Service.of({
        codeIntel: (input) =>
          codeIntel.execute({ request: input.request, sessionId: input.sessionID, agent: input.agent }).pipe(
            Effect.provideService(InstanceRef, ctx),
            Effect.match({
              onFailure: (error) => JSON.stringify({ schemaVersion: 2, error: { reason: codeIntelReason(error) } }),
              onSuccess: JSON.stringify,
            }),
          ),
        contextQuery: (input) =>
          contextQuery.execute({ request: input.request, sessionId: input.sessionID, agent: input.agent }).pipe(
            Effect.provideService(InstanceRef, ctx),
            Effect.match({
              onFailure: (error) => JSON.stringify({ schemaVersion: 1, error: { reason: contextQueryReason(error) } }),
              onSuccess: JSON.stringify,
            }),
          ),
      })
    }),
  )
}

function codeIntelReason(error: CodeIntelFacade.Error) {
  if (error._tag === "CodeQuery.InvalidQueryError") return error.reason
  if (error._tag === "CodeIntelFacade.CursorError") return "cursor_expired_or_invalid"
  if (error._tag === "CodeIntelFacade.AuthorizationUnavailableError") return "authorization_unavailable"
  if (error._tag === "CodeIntelFacade.ArtifactUnavailableError") return "audit_storage_unavailable"
  return "location_index_unavailable"
}

function contextQueryReason(error: ContextQueryFacade.Error) {
  if (error._tag === "FederatedContextQuery.InvalidQueryError") return error.reason
  if (error._tag === "ContextQueryFacade.AuthorizationUnavailableError") return "authorization_unavailable"
  if (error._tag === "ContextQueryFacade.ArtifactUnavailableError") return "audit_storage_unavailable"
  if (error._tag === "ContextQueryFacade.TokenError") return "ref_cursor_expired_or_invalid"
  return "federated_context_unavailable"
}
