import { MCP } from "@/mcp"
import { ConfigMCPV1 } from "@deepagent-code/core/v1/config/mcp"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { McpServerNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

export const AddPayload = Schema.Struct({
  name: Schema.String,
  config: ConfigMCPV1.Info,
})

export const StatusMap = Schema.Record(Schema.String, MCP.Status)

// M1 (S1-v3.4): preset catalog exposure. The catalog is metadata only; these schemas mirror
// the McpCatalogEntry shape (credentials by key-name, never values) for the one-click UI.
export const CatalogCredentialSpec = Schema.Struct({
  key: Schema.String,
  description: Schema.String,
  required: Schema.Boolean,
  secret: Schema.Boolean,
})
export const CatalogParamSpec = Schema.Struct({
  key: Schema.String,
  description: Schema.String,
  required: Schema.Boolean,
  multi: Schema.optional(Schema.Boolean),
})
export const CatalogEntry = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  direction: Schema.Literals(["git_platform", "files_search", "db_readonly", "browser_fetch"]),
  source: Schema.Literals(["opensource", "adapted", "self"]),
  repo: Schema.optional(Schema.String),
  upstreamPin: Schema.optional(Schema.String),
  transport: Schema.Literals(["local", "remote"]),
  credentials: Schema.Array(CatalogCredentialSpec),
  params: Schema.Array(CatalogParamSpec),
  riskTier: Schema.Literals(["read_only", "write_guarded", "external_fetch"]),
  defaultReadOnly: Schema.Boolean,
  defaultEnabled: Schema.Boolean,
})
export const CatalogList = Schema.Array(CatalogEntry)
// credentialRefs map a credential key → a secure-storage REFERENCE the caller already resolved
// (never a raw secret in the request body where avoidable; values are not persisted to the config repo).
export const CatalogEnablePayload = Schema.Struct({
  id: Schema.String,
  params: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  credentialRefs: Schema.Record(Schema.String, Schema.String),
})
// Result carries the instantiated name+config so the caller can persist it to cfg.mcp (durable),
// matching the manual-add flow; the backend only connected it in-memory.
export const CatalogEnableResult = Schema.Struct({
  status: StatusMap,
  name: Schema.String,
  config: ConfigMCPV1.Info,
})
export class CatalogInstantiateApiError extends Schema.ErrorClass<CatalogInstantiateApiError>(
  "McpCatalogInstantiateError",
)({ error: Schema.String }, { httpApiStatus: 400 }) {}

export const AuthStartResponse = Schema.Struct({
  authorizationUrl: Schema.String,
  oauthState: Schema.String,
})
export const AuthCallbackPayload = Schema.Struct({
  code: Schema.String,
})
export const AuthRemoveResponse = Schema.Struct({
  success: Schema.Literal(true),
})
export class UnsupportedOAuthError extends Schema.ErrorClass<UnsupportedOAuthError>("McpUnsupportedOAuthError")(
  { error: Schema.String },
  { httpApiStatus: 400 },
) {}

export const McpPaths = {
  status: "/mcp",
  catalog: "/mcp/catalog",
  catalogEnable: "/mcp/catalog/enable",
  auth: "/mcp/:name/auth",
  authCallback: "/mcp/:name/auth/callback",
  authAuthenticate: "/mcp/:name/auth/authenticate",
  connect: "/mcp/:name/connect",
  disconnect: "/mcp/:name/disconnect",
} as const

export const McpApi = HttpApi.make("mcp")
  .add(
    HttpApiGroup.make("mcp")
      .add(
        HttpApiEndpoint.get("status", McpPaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Record(Schema.String, MCP.Status), "MCP server status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.status",
            summary: "Get MCP status",
            description: "Get the status of all Model Context Protocol (MCP) servers.",
          }),
        ),
        HttpApiEndpoint.post("add", McpPaths.status, {
          query: WorkspaceRoutingQuery,
          payload: AddPayload,
          success: described(StatusMap, "MCP server added successfully"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.add",
            summary: "Add MCP server",
            description: "Dynamically add a new Model Context Protocol (MCP) server to the system.",
          }),
        ),
        HttpApiEndpoint.get("catalog", McpPaths.catalog, {
          query: WorkspaceRoutingQuery,
          success: described(CatalogList, "Preset MCP catalog (metadata only; nothing is connected)"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.catalog",
            summary: "List preset MCP catalog",
            description:
              "List the vetted preset MCP servers. Metadata only — no server is connected until explicitly enabled.",
          }),
        ),
        HttpApiEndpoint.post("catalogEnable", McpPaths.catalogEnable, {
          query: WorkspaceRoutingQuery,
          payload: CatalogEnablePayload,
          success: described(CatalogEnableResult, "Catalog entry enabled and connected"),
          error: [McpServerNotFoundError, CatalogInstantiateApiError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.catalogEnable",
            summary: "Enable a preset MCP catalog entry",
            description:
              "Instantiate a preset catalog entry (with filled params + secure-storage credential references) into a cfg.mcp entry and connect it.",
          }),
        ),
        HttpApiEndpoint.post("authStart", McpPaths.auth, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(AuthStartResponse, "OAuth flow started"),
          error: [UnsupportedOAuthError, McpServerNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.auth.start",
            summary: "Start MCP OAuth",
            description: "Start OAuth authentication flow for a Model Context Protocol (MCP) server.",
          }),
        ),
        HttpApiEndpoint.post("authCallback", McpPaths.authCallback, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: AuthCallbackPayload,
          success: described(MCP.Status, "OAuth authentication completed"),
          error: [HttpApiError.BadRequest, McpServerNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.auth.callback",
            summary: "Complete MCP OAuth",
            description:
              "Complete OAuth authentication for a Model Context Protocol (MCP) server using the authorization code.",
          }),
        ),
        HttpApiEndpoint.post("authAuthenticate", McpPaths.authAuthenticate, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(MCP.Status, "OAuth authentication completed"),
          error: [UnsupportedOAuthError, McpServerNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.auth.authenticate",
            summary: "Authenticate MCP OAuth",
            description: "Start OAuth flow and wait for callback (opens browser).",
          }),
        ),
        HttpApiEndpoint.delete("authRemove", McpPaths.auth, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(AuthRemoveResponse, "OAuth credentials removed"),
          error: McpServerNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.auth.remove",
            summary: "Remove MCP OAuth",
            description: "Remove OAuth credentials for an MCP server.",
          }),
        ),
        HttpApiEndpoint.post("connect", McpPaths.connect, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "MCP server connected successfully"),
          error: McpServerNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.connect",
            description: "Connect an MCP server.",
          }),
        ),
        HttpApiEndpoint.post("disconnect", McpPaths.disconnect, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "MCP server disconnected successfully"),
          error: McpServerNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.disconnect",
            description: "Disconnect an MCP server.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "mcp",
          description: "Experimental HttpApi MCP routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "deepagent-code experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
