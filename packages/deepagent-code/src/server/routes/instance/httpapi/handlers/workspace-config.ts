import { WorkspaceConfig } from "@deepagent-code/core/deepagent/workspace-config"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

// V4.0 §E1 — trusted-sources config handlers. Read/write the L1 trust gate for a workspace via
// WorkspaceConfig.Service. Schema validation in the group rejects unknown EventSource values at
// the decode boundary (→ 400) before the handler is invoked, so handlers only handle the happy path.

export const workspaceConfigHandlers = HttpApiBuilder.group(InstanceHttpApi, "workspaceConfig", (handlers) =>
  Effect.gen(function* () {
    const config = yield* WorkspaceConfig.Service

    return handlers
      // GET /workspace/:workspaceID/config/trusted-sources
      // Returns the resolved trustedSources (DEFAULT_TRUSTED_SOURCES when the workspace has no config row).
      .handle("getTrustedSources", (ctx) =>
        Effect.gen(function* () {
          const resolved = yield* config.get(ctx.params.workspaceID)
          return { trustedSources: [...resolved.trustedSources] }
        }),
      )
      // PUT /workspace/:workspaceID/config/trusted-sources
      // Replaces the trustedSources list. EventSource validation is enforced by the schema (→ 400 on
      // unknown values); the handler writes the validated array directly to WorkspaceConfig.
      .handle("putTrustedSources", (ctx) =>
        Effect.gen(function* () {
          const resolved = yield* config.set(ctx.params.workspaceID, {
            trustedSources: ctx.payload.trustedSources,
          })
          return { trustedSources: [...resolved.trustedSources] }
        }),
      )
  }),
)
