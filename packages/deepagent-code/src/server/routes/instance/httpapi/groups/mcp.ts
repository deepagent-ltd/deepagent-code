import { MCP } from "@/mcp"
import { McpAppResource } from "@/mcp/app-resource"
import { ConfigMCPV1 } from "@deepagent-code/core/v1/config/mcp"
import { McpAppInvocationSchema } from "@deepagent-code/core/session/mcp-app-invocation.schema"
import { Schema } from "effect"
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpApiMiddleware,
  OpenApi,
} from "effect/unstable/httpapi"
import { McpServerNotFoundError, ServiceUnavailableError } from "../errors"
import { Authorization } from "../middleware/authorization"
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

export class McpAuthenticationRequired extends Schema.ErrorClass<McpAuthenticationRequired>(
  "McpAuthenticationRequired",
)({ error: Schema.String }, { httpApiStatus: 401 }) {}

// Transport authorization wraps workspace routing; a proxy must not bypass it.
// Only mutation endpoints declare the 401 schema, preserving read contracts.
export class McpMutationAuthorization extends HttpApiMiddleware.Service<McpMutationAuthorization>()(
  "@deepagent-code/McpMutationAuthorization",
) {}

export const AuthStartResponse = Schema.Struct({
  authorizationUrl: Schema.String,
  oauthState: Schema.String,
})
export const AuthCallbackPayload = Schema.Struct({
  code: Schema.NonEmptyString.check(Schema.isMaxLength(8192)),
  oauthState: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  iss: Schema.optional(Schema.NonEmptyString.check(Schema.isMaxLength(8192))),
})
export class OAuthFlowApiError extends Schema.ErrorClass<OAuthFlowApiError>("McpOAuthFlowError")(
  { error: Schema.String },
  { httpApiStatus: 409 },
) {}
export const AuthRemoveResponse = Schema.Struct({
  success: Schema.Literal(true),
})
const SecretName = Schema.NonEmptyString.check(Schema.isMaxLength(256))
const SecretPath = Schema.NonEmptyString.check(Schema.isMaxLength(4096))
const SecretPreviewID = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/))
const SecretTimestamp = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
export const SecretMigrationPreview = Schema.Struct({
  name: SecretName,
  source: SecretPath,
  previewID: SecretPreviewID,
  fields: Schema.Array(Schema.Struct({ field: Schema.Literals(["environment", "headers", "oauth"]), key: SecretName })),
})
export const SecretMigrationCommit = Schema.Struct({ previewID: SecretPreviewID, requestID: SecretName })
export const SecretMigrationReceipt = Schema.Struct({
  requestID: SecretName,
  name: SecretName,
  state: Schema.Literals(["prepared", "stored", "committed", "changed"]),
  moved: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(32)),
})
export const SecretInitialized = Schema.Struct({ name: SecretName, source: SecretPath })
export const BindingRepairPreview = Schema.Struct({
  name: SecretName,
  source: SecretPath,
  previewID: SecretPreviewID,
  old: Schema.Struct({
    securityNamespaceId: SecretName,
    locationKey: SecretName,
    projectScopeKey: SecretName,
    indexSpaceId: SecretName,
    canonicalRoot: SecretPath,
    observedProjectId: Schema.optional(SecretName),
    locationCreatedAt: SecretTimestamp,
    projectCreatedAt: SecretTimestamp,
    projectIdentityHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    locationObservedProjectId: Schema.NullOr(SecretName),
    projectObservedProjectId: Schema.NullOr(SecretName),
  }),
  nextObservedProjectId: SecretName,
}).annotate({ identifier: "McpBindingRepairPreview" })
export const BindingRepairCommand = Schema.Struct({ previewID: SecretPreviewID })
export const BindingRepaired = Schema.Struct({
  name: SecretName,
  source: SecretPath,
  state: Schema.Literal("repaired"),
})
export class SecretUnavailableError extends Schema.ErrorClass<SecretUnavailableError>("McpSecretUnavailableError")(
  { code: Schema.Literal("unavailable"), error: Schema.String },
  { httpApiStatus: 503 },
) {}
export class ConfigRemovalError extends Schema.ErrorClass<ConfigRemovalError>("McpConfigRemovalError")(
  { code: Schema.Literals(["readonly", "changed", "unknown"]), error: Schema.String },
  { httpApiStatus: 409 },
) {}
export class SecretOperationError extends Schema.ErrorClass<SecretOperationError>("McpSecretOperationError")(
  { code: Schema.Literals(["invalid", "changed", "unknown", "capacity", "work_unsettled"]), error: Schema.String },
  { httpApiStatus: 409 },
) {}
export class UnsupportedOAuthError extends Schema.ErrorClass<UnsupportedOAuthError>("McpUnsupportedOAuthError")(
  { error: Schema.String },
  { httpApiStatus: 400 },
) {}

export class McpAppOperationError extends Schema.ErrorClass<McpAppOperationError>("McpAppOperationError")(
  { code: McpAppResource.Error.fields.reason, error: Schema.String },
  { httpApiStatus: 409 },
) {}

export class McpAppInvocationOperationError extends Schema.ErrorClass<McpAppInvocationOperationError>("McpAppInvocationOperationError")(
  { code: McpAppInvocationSchema.ErrorCode, error: Schema.String },
  { httpApiStatus: 409 },
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
  removeConfig: "/mcp/:name/config",
  credentialsInitialize: "/mcp/:name/credentials/initialize",
  credentialsPreview: "/mcp/:name/credentials/preview",
  credentialsCommit: "/mcp/:name/credentials/commit",
  credentialsStatus: "/mcp/:name/credentials/:requestID",
  credentialsReconcile: "/mcp/:name/credentials/:requestID/reconcile",
  bindingPreview: "/mcp/:name/binding/preview",
  bindingRepair: "/mcp/:name/binding/repair",
  apps: "/mcp/apps",
  appOpen: "/mcp/apps/open",
  appCheck: "/mcp/apps/check",
  appClose: "/mcp/apps/close",
  appInvoke: "/mcp/apps/invoke",
  appInvocationStatus: "/mcp/apps/invocations/status",
  appInvocationResult: "/mcp/apps/invocations/result",
  appInvocationList: "/mcp/apps/invocations/list",
  appViewTools: "/mcp/apps/tools",
} as const

export const McpApi = HttpApi.make("mcp")
  .add(
    HttpApiGroup.make("mcp")
      .add(
        HttpApiEndpoint.get("apps", McpPaths.apps, {
          query: WorkspaceRoutingQuery,
          success: Schema.Array(McpAppResource.Descriptor),
          error: McpAppOperationError,
        }).annotateMerge(OpenApi.annotations({ identifier: "mcp.apps", description: "List current MCP App descriptors. Does not read remote UI resources." })),
        HttpApiEndpoint.post("appOpen", McpPaths.appOpen, {
          query: WorkspaceRoutingQuery,
          payload: McpAppResource.ReadInput,
          success: McpAppResource.View,
          error: [McpAppOperationError, McpAuthenticationRequired],
        }).annotateMerge(OpenApi.annotations({ identifier: "mcp.appOpen", description: "Read one explicitly approved UI resource from its current server/tool snapshot. Does not authorize tool execution." })),
        HttpApiEndpoint.post("appCheck", McpPaths.appCheck, {
          query: WorkspaceRoutingQuery,
          payload: McpAppResource.ViewInput,
          success: McpAppResource.Descriptor,
          error: [McpAppOperationError, McpAuthenticationRequired],
        }).annotateMerge(OpenApi.annotations({ identifier: "mcp.appCheck", description: "Check that an open MCP App still belongs to the current connection, source and tool snapshot." })),
        HttpApiEndpoint.post("appClose", McpPaths.appClose, {
          query: WorkspaceRoutingQuery,
          payload: McpAppResource.ViewInput,
          success: Schema.Boolean,
          error: [McpAppOperationError, McpAuthenticationRequired],
        }).annotateMerge(OpenApi.annotations({ identifier: "mcp.appClose", description: "Invalidate an MCP App view. Does not perform any remote operation." })),
        HttpApiEndpoint.post("appInvoke", McpPaths.appInvoke, {
          query: WorkspaceRoutingQuery,
          payload: McpAppInvocationSchema.InvokeInput,
          success: McpAppInvocationSchema.Status,
          error: [McpAppInvocationOperationError, McpAuthenticationRequired],
        }).annotateMerge(OpenApi.annotations({ identifier: "mcp.appInvoke", description: "Durably admit one exact tool invocation from the current Session-bound MCP App. Execution uses the original Session runner and permission flow." })),
        HttpApiEndpoint.post("appViewTools", McpPaths.appViewTools, {
          query: WorkspaceRoutingQuery,
          payload: McpAppResource.ViewToolsInput,
          success: McpAppResource.ViewTools,
          error: [McpAppInvocationOperationError, McpAuthenticationRequired],
        }).annotateMerge(OpenApi.annotations({ identifier: "mcp.appViewTools", description: "Read only the exact App-visible tools from the current view's original server connection and Session." })),
        HttpApiEndpoint.post("appInvocationStatus", McpPaths.appInvocationStatus, {
          query: WorkspaceRoutingQuery,
          payload: McpAppInvocationSchema.StatusInput,
          success: McpAppInvocationSchema.Status,
          error: [McpAppInvocationOperationError, McpAuthenticationRequired],
        }).annotateMerge(OpenApi.annotations({ identifier: "mcp.appInvocationStatus", description: "Read an admitted MCP App invocation without executing or retrying it." })),
        HttpApiEndpoint.post("appInvocationResult", McpPaths.appInvocationResult, {
          query: WorkspaceRoutingQuery,
          payload: McpAppInvocationSchema.ResultInput,
          success: McpAppInvocationSchema.Result,
          error: [McpAppInvocationOperationError, McpAuthenticationRequired],
        }).annotateMerge(OpenApi.annotations({ identifier: "mcp.appInvocationResult", description: "Read the exact original tool result only for its current bound MCP App view." })),
        HttpApiEndpoint.post("appInvocationList", McpPaths.appInvocationList, {
          query: WorkspaceRoutingQuery,
          payload: McpAppInvocationSchema.ListInput,
          success: Schema.Array(McpAppInvocationSchema.Status),
          error: [McpAppInvocationOperationError, McpAuthenticationRequired],
        }).annotateMerge(OpenApi.annotations({ identifier: "mcp.appInvocationList", description: "Read Session MCP App invocation status, excluding raw private App result metadata." })),
        HttpApiEndpoint.get("status", McpPaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Record(Schema.String, MCP.Status), "MCP server status"),
          error: ServiceUnavailableError,
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
          error: [HttpApiError.BadRequest, McpAuthenticationRequired],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.add",
            summary: "Add MCP server",
            description: "Dynamically add a new Model Context Protocol (MCP) server to the system.",
          }),
        ),
        HttpApiEndpoint.delete("removeConfig", McpPaths.removeConfig, {
          params: { name: SecretName },
          query: WorkspaceRoutingQuery,
          success: Schema.Struct({ removed: Schema.Literal(true) }),
          error: [McpAuthenticationRequired, ConfigRemovalError, McpServerNotFoundError, ServiceUnavailableError],
        }).annotateMerge(OpenApi.annotations({
          identifier: "mcp.removeConfig",
          summary: "Remove one writable global MCP configuration",
          description: "Disconnect the original scoped server and delete only its declarative global JSONC key. Other source layers and shared credentials are retained; surviving or changed sources refuse success.",
        })),
        HttpApiEndpoint.get("catalog", McpPaths.catalog, {
          query: WorkspaceRoutingQuery,
          success: described(CatalogList, "Preset MCP catalog (metadata only; nothing is connected)"),
          error: ServiceUnavailableError,
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
          error: [McpServerNotFoundError, CatalogInstantiateApiError, McpAuthenticationRequired],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.catalogEnable",
            summary: "Enable a preset MCP catalog entry",
            description:
              "Instantiate a preset catalog entry (with filled params + secure-storage credential references) into a cfg.mcp entry and connect it.",
          }),
        ),
        HttpApiEndpoint.post("credentialsInitialize", McpPaths.credentialsInitialize, {
          params: { name: SecretName },
          query: WorkspaceRoutingQuery,
          success: SecretInitialized,
          error: [McpAuthenticationRequired, SecretUnavailableError, SecretOperationError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.credentials.initialize",
            summary: "Explicit scoped MCP credentialsInitialize",
          }),
        ),
        HttpApiEndpoint.get("credentialsPreview", McpPaths.credentialsPreview, {
          params: { name: SecretName },
          query: WorkspaceRoutingQuery,
          success: SecretMigrationPreview,
          error: [McpAuthenticationRequired, SecretUnavailableError, SecretOperationError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.credentials.preview",
            summary: "Explicit scoped MCP credentialsPreview",
          }),
        ),
        HttpApiEndpoint.post("credentialsCommit", McpPaths.credentialsCommit, {
          params: { name: SecretName },
          query: WorkspaceRoutingQuery,
          payload: SecretMigrationCommit,
          success: SecretMigrationReceipt,
          error: [McpAuthenticationRequired, SecretUnavailableError, SecretOperationError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.credentials.commit",
            summary: "Explicit scoped MCP credentialsCommit",
          }),
        ),
        HttpApiEndpoint.get("credentialsStatus", McpPaths.credentialsStatus, {
          params: { name: SecretName, requestID: SecretName },
          query: WorkspaceRoutingQuery,
          success: SecretMigrationReceipt,
          error: [McpAuthenticationRequired, SecretUnavailableError, SecretOperationError, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.credentials.status",
            summary: "Explicit scoped MCP credentialsStatus",
          }),
        ),
        HttpApiEndpoint.post("credentialsReconcile", McpPaths.credentialsReconcile, {
          params: { name: SecretName, requestID: SecretName },
          query: WorkspaceRoutingQuery,
          success: SecretMigrationReceipt,
          error: [McpAuthenticationRequired, SecretUnavailableError, SecretOperationError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.credentials.reconcile",
            summary: "Explicit scoped MCP credentialsReconcile",
          }),
        ),
        HttpApiEndpoint.get("bindingPreview", McpPaths.bindingPreview, {
          params: { name: SecretName },
          query: WorkspaceRoutingQuery,
          success: BindingRepairPreview,
          error: [McpAuthenticationRequired, SecretUnavailableError, SecretOperationError],
        }).annotateMerge(
          OpenApi.annotations({ identifier: "mcp.binding.preview", summary: "Explicit scoped MCP bindingPreview" }),
        ),
        HttpApiEndpoint.post("bindingRepair", McpPaths.bindingRepair, {
          params: { name: SecretName },
          query: WorkspaceRoutingQuery,
          payload: BindingRepairCommand,
          success: BindingRepaired,
          error: [McpAuthenticationRequired, SecretUnavailableError, SecretOperationError],
        }).annotateMerge(
          OpenApi.annotations({ identifier: "mcp.binding.repair", summary: "Explicit scoped MCP bindingRepair" }),
        ),
        HttpApiEndpoint.post("authStart", McpPaths.auth, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(AuthStartResponse, "OAuth flow started"),
          error: [UnsupportedOAuthError, McpServerNotFoundError, OAuthFlowApiError, McpAuthenticationRequired],
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
          error: [HttpApiError.BadRequest, McpServerNotFoundError, OAuthFlowApiError, McpAuthenticationRequired],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.auth.callback",
            summary: "Complete MCP OAuth",
            description:
              "Complete OAuth using the authorization code and the exact oauthState returned by auth.start and the authorization response iss when supplied or required by its metadata. Missing state is rejected with 400; stale or mismatched state is rejected with 409 without consuming the current flow. Restart authentication when upgrading a code-only client.",
          }),
        ),
        HttpApiEndpoint.post("authAuthenticate", McpPaths.authAuthenticate, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(MCP.Status, "OAuth authentication completed"),
          error: [UnsupportedOAuthError, McpServerNotFoundError, OAuthFlowApiError, McpAuthenticationRequired],
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
          error: [McpServerNotFoundError, OAuthFlowApiError, McpAuthenticationRequired],
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
          error: [McpServerNotFoundError, OAuthFlowApiError, McpAuthenticationRequired],
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
          error: [McpServerNotFoundError, McpAuthenticationRequired],
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
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization)
      .middleware(McpMutationAuthorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "deepagent-code experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
