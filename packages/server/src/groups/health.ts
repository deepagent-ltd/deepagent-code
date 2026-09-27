import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const HealthGroup = HttpApiGroup.make("server.health")
  .add(
    HttpApiEndpoint.get("health.get", "/api/health", {
      success: Schema.Struct({ healthy: Schema.Literal(true) }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.health.get",
        summary: "Check server health",
        description: "Check whether the API server is ready to accept requests.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("health.composition", "/health/composition", {
      success: Schema.Struct({
        version: Schema.Literal(1),
        digest: Schema.String,
        qualification: Schema.Literal("unqualified"),
        sessionOwner: Schema.Literal("core/default-session-runtime"),
        locationHost: Schema.Struct({
          host: Schema.Literal("core/default-location-host"),
          mcpBridge: Schema.Literal(false),
          pluginBridge: Schema.Literal(false),
        }),
        database: Schema.Struct({ path: Schema.String }),
      }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.health.composition",
        summary: "Inspect bare Core composition",
        description: "Reports the unqualified Core runtime used by standalone serve and its absent app bridges.",
      }),
    ),
  )
