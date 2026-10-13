export * as ConfigMCPV1 from "./mcp"

import { Schema } from "effect"
import { PositiveInt } from "../../schema"

// M7 (S1-v3.4): risk tier persisted on a connected MCP server. ⚠️ This field is DISPLAY metadata
// only and is NOT the gate's trust source: it is attacker-writable (the `add` endpoint forwards
// client config; project-local config is auto-merged + not gitignored). The live permission gate
// IGNORES this field and re-derives the tier at runtime by structurally matching the server config
// against the preset catalog templates (deepagent-code `McpCatalog.deriveTier`). A hand-added or
// tampered server that does not match a catalog template derives no tier → the gate fails closed to
// `ask`. read_only (catalog-matched) → auto-allow; write_guarded / external_fetch → ask per call.
export const RiskTier = Schema.Literals(["read_only", "write_guarded", "external_fetch"]).annotate({
  description:
    "Display-only risk tier persisted by the preset catalog. NOT trusted for permission decisions — the gate re-derives the tier by matching the live config against the catalog. Absent/non-matching servers fail closed to ask.",
})
export type RiskTier = Schema.Schema.Type<typeof RiskTier>

export const Protocol = Schema.Literals(["legacy", "auto", "2026-07-28"]).annotate({
  description:
    "MCP protocol negotiation. Defaults to legacy; auto explicitly probes; 2026-07-28 requires modern support without fallback.",
})
export type Protocol = Schema.Schema.Type<typeof Protocol>

export const Local = Schema.Struct({
  type: Schema.Literal("local").annotate({ description: "Type of MCP server connection" }),
  command: Schema.mutable(Schema.Array(Schema.String)).annotate({
    description: "Command and arguments to run the MCP server",
  }),
  environment: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description:
      "Environment variables to set when running the MCP server. M-CRED (S1-v3.5): a value may be a literal, a `${VAR}` / `${VAR:-default}` env reference resolved from the process environment at connect time, or a `secret://<account>` keychain handle resolved from the OS keychain at connect time. Secret credentials are stored as references/handles — never as plaintext in this file. A missing `${VAR}` warns (by name) but does not block.",
  }),
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable or disable the MCP server on startup",
  }),
  timeout: Schema.optional(PositiveInt).annotate({
    description: "Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified.",
  }),
  riskTier: Schema.optional(RiskTier),
  protocol: Schema.optional(Protocol),
}).annotate({ identifier: "McpLocalConfig" })
export type Local = Schema.Schema.Type<typeof Local>

export const OAuth = Schema.Struct({
  clientId: Schema.optional(Schema.String).annotate({
    description: "OAuth client ID. If not provided, dynamic client registration (RFC 7591) will be attempted.",
  }),
  clientSecret: Schema.optional(Schema.String).annotate({
    description: "OAuth client secret (if required by the authorization server)",
  }),
  expectedIssuer: Schema.optional(Schema.String.check(Schema.isMaxLength(8192))).annotate({
    description:
      "Exact OAuth authorization-server issuer for a pre-registered client. Required before sending a configured client secret; discovery cannot silently select another issuer.",
  }),
  scope: Schema.optional(Schema.String).annotate({ description: "OAuth scopes to request during authorization" }),
  callbackPort: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))).annotate({
    description:
      "Exact port for the local OAuth callback server. Static client IDs default to 19876; a new dynamic registration without an explicit address uses an OS-assigned port. Existing registered clients reuse their verified URI. Ignored if redirectUri is set.",
  }),
  redirectUri: Schema.optional(Schema.String).annotate({
    description:
      "Exact OAuth redirect URI. HTTP loopback addresses use an owned local listener; HTTPS or non-loopback addresses require explicit manual callback completion. Existing registrations are never silently moved to another URI.",
  }),
}).annotate({ identifier: "McpOAuthConfig" })
export type OAuth = Schema.Schema.Type<typeof OAuth>

export const Remote = Schema.Struct({
  type: Schema.Literal("remote").annotate({ description: "Type of MCP server connection" }),
  url: Schema.String.annotate({ description: "URL of the remote MCP server" }),
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable or disable the MCP server on startup",
  }),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description:
      "Headers to send with the request. M-CRED (S1-v3.5): a value may be a literal, a `${VAR}` / `${VAR:-default}` env reference resolved from the process environment at connect time, or a `secret://<account>` keychain handle resolved from the OS keychain at connect time. Secret-bearing headers (e.g. Authorization) are stored as references/handles — never as plaintext in this file. A missing `${VAR}` warns (by name) but does not block.",
  }),
  oauth: Schema.optional(Schema.Union([OAuth, Schema.Literal(false)])).annotate({
    description: "OAuth authentication configuration for the MCP server. Set to false to disable OAuth auto-detection.",
  }),
  timeout: Schema.optional(PositiveInt).annotate({
    description: "Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified.",
  }),
  riskTier: Schema.optional(RiskTier),
  protocol: Schema.optional(Protocol),
}).annotate({ identifier: "McpRemoteConfig" })
export type Remote = Schema.Schema.Type<typeof Remote>

export const Info = Schema.Union([Local, Remote]).annotate({ discriminator: "type" })
export type Info = Schema.Schema.Type<typeof Info>
