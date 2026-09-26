import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { IMExternalDelivery } from "@deepagent-code/core/im/external-delivery"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

// V4.0 §E1 — per-workspace trusted-sources HTTP surface. Exposes the WorkspaceConfig store so an
// operator can read and replace the L1 trust gate for a workspace without touching the database
// directly. workspaceID is a PATH param (the config target); the routing query selects local/remote.

const root = "/workspace"

export const TrustedSourcesResult = Schema.Struct({
  trustedSources: Schema.Array(DeepAgentEvent.EventSource),
}).annotate({ identifier: "TrustedSourcesResult" })

export const TrustedSourcesInput = Schema.Struct({
  trustedSources: Schema.Array(DeepAgentEvent.EventSource),
}).annotate({ identifier: "TrustedSourcesInput" })

export const ExternalChannelsResult = Schema.Struct({
  externalChannels: Schema.Array(IMExternalDelivery.Target),
}).annotate({ identifier: "ExternalChannelsResult" })

export const ExternalChannelsInput = Schema.Struct({
  externalChannels: Schema.Array(IMExternalDelivery.Target),
}).annotate({ identifier: "ExternalChannelsInput" })

export const WorkspaceConfigApi = HttpApi.make("workspaceConfig").add(
  HttpApiGroup.make("workspaceConfig")
    .add(
      HttpApiEndpoint.get("getTrustedSources", `${root}/:workspaceID/config/trusted-sources`, {
        params: { workspaceID: Schema.String },
        query: WorkspaceRoutingQuery,
        success: described(
          TrustedSourcesResult,
          "Current trusted sources for the workspace (DEFAULT_TRUSTED_SOURCES when unset)",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "workspaceConfig.trustedSources.get",
          summary: "Get trusted event sources",
          description:
            'V4.0 §E1: return the resolved trusted event sources list for a workspace. Returns DEFAULT_TRUSTED_SOURCES (["im","system","schedule"]) when no config row exists.',
        }),
      ),
    )
    .add(
      HttpApiEndpoint.put("putTrustedSources", `${root}/:workspaceID/config/trusted-sources`, {
        params: { workspaceID: Schema.String },
        query: WorkspaceRoutingQuery,
        payload: TrustedSourcesInput,
        success: described(TrustedSourcesResult, "Updated trusted sources for the workspace"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "workspaceConfig.trustedSources.put",
          summary: "Replace trusted event sources",
          description:
            'V4.0 §E1: replace the trusted event sources list for a workspace. Each entry must be a valid DeepAgentEvent.EventSource ("im"|"git"|"ci"|"pr"|"monitor"|"schedule"|"system"). Invalid sources are rejected with 400 at the schema boundary.',
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("getExternalChannels", `${root}/:workspaceID/config/external-channels`, {
        params: { workspaceID: Schema.String },
        query: WorkspaceRoutingQuery,
        success: ExternalChannelsResult,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "workspaceConfig.externalChannels.get",
          summary: "Get external IM channel bindings",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.put("putExternalChannels", `${root}/:workspaceID/config/external-channels`, {
        params: { workspaceID: Schema.String },
        query: WorkspaceRoutingQuery,
        payload: ExternalChannelsInput,
        success: ExternalChannelsResult,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "workspaceConfig.externalChannels.put",
          summary: "Replace external IM channel bindings",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "workspaceConfig",
        description: "V4.0 workspace configuration routes (trusted sources).",
      }),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
