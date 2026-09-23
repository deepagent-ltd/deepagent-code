import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { Authorization } from "../middleware/authorization"

export const TenantCreate = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  directory: Schema.String,
  model_allowlist: Schema.Array(Schema.String),
  tier: Schema.Literals(["passthrough", "context", "full"]),
  permission_policy: Schema.optional(PermissionV2.Ruleset),
  quota_requests_per_minute: Schema.Int,
  quota_tokens_per_day: Schema.Int,
  lane_limit: Schema.Int,
  deadline_ms: Schema.Int,
  enabled: Schema.optional(Schema.Boolean),
})

export const TenantUpdate = Schema.Struct({
  model_allowlist: Schema.optional(Schema.Array(Schema.String)),
  tier: Schema.optional(Schema.Literals(["passthrough", "context", "full"])),
  permission_policy: Schema.optional(PermissionV2.Ruleset),
  quota_requests_per_minute: Schema.optional(Schema.Int),
  quota_tokens_per_day: Schema.optional(Schema.Int),
  lane_limit: Schema.optional(Schema.Int),
  deadline_ms: Schema.optional(Schema.Int),
  enabled: Schema.optional(Schema.Boolean),
})

const TenantParams = Schema.Struct({ tenantID: Schema.String })
const TenantQuery = Schema.Struct({ tenant: Schema.optional(Schema.String), limit: Schema.optional(Schema.Int) })

export const GatewayAdminApi = HttpApi.make("gateway-admin").add(
  HttpApiGroup.make("proxyAdmin")
    .add(HttpApiEndpoint.post("tenantCreate", "/proxy/admin/tenants", {
      payload: TenantCreate, success: Schema.Unknown,
    }).annotateMerge(OpenApi.annotations({ summary: "Provision a proxy tenant" })))
    .add(HttpApiEndpoint.get("tenantList", "/proxy/admin/tenants", {
      success: Schema.Unknown,
    }).annotateMerge(OpenApi.annotations({ summary: "List proxy tenants" })))
    .add(HttpApiEndpoint.patch("tenantUpdate", "/proxy/admin/tenants/:tenantID", {
      params: TenantParams, payload: TenantUpdate, success: Schema.Unknown,
    }).annotateMerge(OpenApi.annotations({ summary: "Update a proxy tenant" })))
    .add(HttpApiEndpoint.get("ledgerList", "/proxy/admin/ledger", {
      query: TenantQuery, success: Schema.Unknown,
    }).annotateMerge(OpenApi.annotations({ summary: "Export proxy request ledger" })))
    .add(HttpApiEndpoint.get("laneList", "/proxy/admin/lanes", {
      query: TenantQuery, success: Schema.Unknown,
    }).annotateMerge(OpenApi.annotations({ summary: "List proxy conversation lanes" }))),
).middleware(Authorization)
