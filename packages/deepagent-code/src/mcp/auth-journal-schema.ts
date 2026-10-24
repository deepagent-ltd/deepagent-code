import { Schema } from "effect"
import { McpAuth } from "./auth"
import { McpOAuthState } from "./oauth-state"

export const VERSION = 2
export const BASE_SQL_SHA256 = "8ef9248c1aede86abf62f1acda983e62a66b90f3fcc983f03b919b33c449447f"
export const LIMITS = Object.freeze({
  slots: 256,
  operations: 1024,
  activeFlows: 64,
  bindingBytes: 8192,
  credentialBytes: 65536,
  flowBytes: 65536,
  outcomeBytes: 2048,
  logicalBytes: 4194304,
  slotCharge: 512,
  operationCharge: 1024,
  extensionCharge: 512,
  lifetimeMs: 300000,
  pageBytes: 4096,
  maxPages: 4096,
})

export class Error extends globalThis.Error {
  readonly _tag = "McpAuthJournalError"
  constructor(
    readonly reason: "unavailable" | "invalid" | "capacity" | "changed" | "conflict" | "unknown" | "expired" | "legacy_unverified",
  ) {
    super(reason === "legacy_unverified" ? "Legacy MCP credentials require explicit re-entry before use"
      : `MCP authentication journal ${reason}`)
  }
}

export const Tag = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const Integer = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
)
export const Positive = Integer.check(Schema.isGreaterThanOrEqualTo(1))
const Label = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
export const Principal = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local"), selectionRevision: Integer }),
  Schema.Struct({
    kind: Schema.Literal("account"),
    id: Label,
    issuer: McpOAuthState.Issuer,
    orgID: Schema.NullOr(Label),
    identityGeneration: Tag,
    selectionRevision: Integer,
  }),
])
export const Binding = Schema.Struct({
  version: Schema.Literal(1),
  installationID: Label,
  namespace: Label,
  location: Label,
  project: Label,
  rootTag: Tag,
  principal: Principal,
  name: Label,
  resource: McpOAuthState.Uri,
  sourceTag: Tag,
  configurationTag: Tag,
  credentialTag: Tag,
})
export type Binding = typeof Binding.Type
export const Credentials = Schema.Struct({
  tokens: Schema.optional(McpAuth.Tokens),
  clientInfo: Schema.optional(McpAuth.ClientInfo),
})
export type Credentials = typeof Credentials.Type
export const Flow = Schema.Struct({
  version: Schema.Literal(1),
  id: Tag,
  owner: Tag,
  state: Tag,
  phase: Schema.Literals(["preparing", "awaiting_callback", "connected", "revoked", "expired", "unknown"]),
  createdAt: Integer,
  expiresAt: Integer,
  redirectUri: McpOAuthState.Uri,
  verifier: Schema.optional(Schema.String.check(Schema.isMinLength(43), Schema.isMaxLength(128))),
  discovery: Schema.optional(McpOAuthState.Discovery),
  discoveryTag: Schema.optional(Tag),
})
export type Flow = typeof Flow.Type
export const Slot = Schema.Struct({
  slot_key: Tag,
  binding: Schema.String,
  generation: Tag,
  revision: Positive,
  credential_revision: Integer,
  credentials: Schema.String,
  flow: Schema.String,
  created_at: Integer,
  updated_at: Integer,
})
export type Slot = typeof Slot.Type
export const Kind = Schema.Literals(["registration", "exchange", "refresh"])
export type Kind = typeof Kind.Type
export const Operation = Schema.Struct({
  operation_id: Tag,
  slot_key: Tag,
  flow_id: Tag,
  owner_id: Tag,
  generation: Tag,
  source_revision: Schema.NullOr(Positive),
  kind: Kind,
  phase: Schema.Literals(["prepared", "dispatched", "committed", "rejected", "unknown", "revoked"]),
  request_tag: Tag,
  endpoint_tag: Tag,
  created_at: Integer,
  deadline_at: Integer,
  dispatched_at: Schema.NullOr(Integer),
  settled_at: Schema.NullOr(Integer),
  outcome: Schema.String,
})
export type Operation = typeof Operation.Type
export const Outcome = Schema.Struct({
  code: Schema.optional(
    Schema.Literals(["network", "revoked", "expired", "rejected", "invalid_response", "storage", "committed"]),
  ),
  status: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 100, maximum: 599 }))),
})
export type Outcome = typeof Outcome.Type

// Frozen private v1 migration. Changing an applied body requires a forward version.
export const SQL = `CREATE TABLE mcp_auth_meta (
 id INTEGER NOT NULL PRIMARY KEY CHECK(typeof(id)='integer' AND id=1),
 version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version=1),
 installation_tag TEXT NOT NULL CHECK(typeof(installation_tag)='text' AND length(installation_tag)=64 AND installation_tag NOT GLOB '*[^0-9a-f]*'),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0 AND created_at<=9007199254740991)
);
CREATE TABLE mcp_auth_slot (
 slot_key TEXT NOT NULL PRIMARY KEY CHECK(typeof(slot_key)='text' AND length(slot_key)=64 AND slot_key NOT GLOB '*[^0-9a-f]*'),
 binding TEXT NOT NULL CHECK(typeof(binding)='text' AND json_valid(binding) AND json_type(binding)='object' AND length(CAST(binding AS BLOB)) BETWEEN 2 AND 8192),
 generation TEXT NOT NULL CHECK(typeof(generation)='text' AND length(generation)=64 AND generation NOT GLOB '*[^0-9a-f]*'),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 credential_revision INTEGER NOT NULL CHECK(typeof(credential_revision)='integer' AND credential_revision BETWEEN 0 AND 9007199254740991),
 credentials TEXT NOT NULL CHECK(typeof(credentials)='text' AND json_valid(credentials) AND json_type(credentials)='object' AND length(CAST(credentials AS BLOB)) BETWEEN 2 AND 65536),
 flow TEXT NOT NULL CHECK(typeof(flow)='text' AND json_valid(flow) AND json_type(flow) IN ('object','null') AND length(CAST(flow AS BLOB)) BETWEEN 4 AND 65536),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
 updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN created_at AND 9007199254740991)
);
CREATE TABLE mcp_oauth_operation (
 operation_id TEXT NOT NULL PRIMARY KEY CHECK(typeof(operation_id)='text' AND length(operation_id)=64 AND operation_id NOT GLOB '*[^0-9a-f]*'),
 slot_key TEXT NOT NULL REFERENCES mcp_auth_slot(slot_key),
 flow_id TEXT NOT NULL CHECK(typeof(flow_id)='text' AND length(flow_id)=64 AND flow_id NOT GLOB '*[^0-9a-f]*'),
 owner_id TEXT NOT NULL CHECK(typeof(owner_id)='text' AND length(owner_id)=64 AND owner_id NOT GLOB '*[^0-9a-f]*'),
 generation TEXT NOT NULL CHECK(typeof(generation)='text' AND length(generation)=64 AND generation NOT GLOB '*[^0-9a-f]*'),
 source_revision INTEGER CHECK(source_revision IS NULL OR (typeof(source_revision)='integer' AND source_revision BETWEEN 1 AND 9007199254740991)),
 kind TEXT NOT NULL CHECK(typeof(kind)='text' AND kind IN ('registration','exchange','refresh')),
 phase TEXT NOT NULL CHECK(typeof(phase)='text' AND phase IN ('prepared','dispatched','committed','rejected','unknown','revoked')),
 request_tag TEXT NOT NULL CHECK(typeof(request_tag)='text' AND length(request_tag)=64 AND request_tag NOT GLOB '*[^0-9a-f]*'),
 endpoint_tag TEXT NOT NULL CHECK(typeof(endpoint_tag)='text' AND length(endpoint_tag)=64 AND endpoint_tag NOT GLOB '*[^0-9a-f]*'),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
 deadline_at INTEGER NOT NULL CHECK(typeof(deadline_at)='integer' AND deadline_at>=created_at AND deadline_at<=9007199254740991 AND deadline_at-created_at<=300000),
 dispatched_at INTEGER CHECK(dispatched_at IS NULL OR (typeof(dispatched_at)='integer' AND dispatched_at BETWEEN created_at AND deadline_at)),
 settled_at INTEGER CHECK(settled_at IS NULL OR (typeof(settled_at)='integer' AND settled_at BETWEEN created_at AND 9007199254740991)),
 outcome TEXT NOT NULL CHECK(typeof(outcome)='text' AND json_valid(outcome) AND json_type(outcome)='object' AND length(CAST(outcome AS BLOB)) BETWEEN 2 AND 2048),
 CHECK((phase='prepared' AND dispatched_at IS NULL) OR (phase IN ('dispatched','committed','rejected','unknown') AND dispatched_at IS NOT NULL) OR phase='revoked'),
 CHECK((phase IN ('prepared','dispatched') AND settled_at IS NULL) OR (phase IN ('committed','rejected','unknown','revoked') AND settled_at IS NOT NULL)),
 CHECK(settled_at IS NULL OR dispatched_at IS NULL OR settled_at>=dispatched_at),
 CHECK((kind='refresh' AND source_revision IS NOT NULL) OR (kind IN ('registration','exchange') AND source_revision IS NULL))
);
CREATE INDEX mcp_oauth_operation_slot_idx ON mcp_oauth_operation(slot_key,created_at,operation_id);
CREATE UNIQUE INDEX mcp_oauth_flow_kind_idx ON mcp_oauth_operation(slot_key,flow_id,kind) WHERE kind IN ('registration','exchange');
CREATE UNIQUE INDEX mcp_oauth_refresh_source_idx ON mcp_oauth_operation(slot_key,source_revision) WHERE kind='refresh';
`

// Additive private v2 forward. The v1 body and every existing secret/operation row stay unchanged.
export const EXTENSION_SQL = `CREATE TABLE mcp_auth_extension (
 id INTEGER NOT NULL PRIMARY KEY CHECK(typeof(id)='integer' AND id=1),
 version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version=2),
 base_schema_sha256 TEXT NOT NULL CHECK(typeof(base_schema_sha256)='text' AND base_schema_sha256='8ef9248c1aede86abf62f1acda983e62a66b90f3fcc983f03b919b33c449447f'),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991)
);`

export function decodeSlot(input: unknown) {
  const row = Schema.decodeUnknownSync(Slot, { onExcessProperty: "error" })(input)
  const binding = Schema.decodeUnknownSync(Schema.fromJsonString(Binding), { onExcessProperty: "error" })(row.binding)
  const credentials = Schema.decodeUnknownSync(Schema.fromJsonString(Credentials), { onExcessProperty: "error" })(
    row.credentials,
  )
  const flow = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.NullOr(Flow)), { onExcessProperty: "error" })(
    row.flow,
  )
  if (
    row.updated_at < row.created_at ||
    (flow && (flow.expiresAt < flow.createdAt || flow.expiresAt - flow.createdAt > LIMITS.lifetimeMs))
  )
    throw new Error("invalid")
  if (flow?.phase === "awaiting_callback" && (!flow.verifier || !flow.discovery || !flow.discoveryTag))
    throw new Error("invalid")
  if (credentials.tokens && !credentials.tokens.issuer) throw new Error("invalid")
  if (credentials.clientInfo && !credentials.clientInfo.issuer) throw new Error("invalid")
  return { row, binding, credentials, flow }
}

export function decodeOperation(input: unknown) {
  const row = Schema.decodeUnknownSync(Operation, { onExcessProperty: "error" })(input)
  const outcome = Schema.decodeUnknownSync(Schema.fromJsonString(Outcome), { onExcessProperty: "error" })(row.outcome)
  if (
    row.deadline_at < row.created_at ||
    row.deadline_at - row.created_at > LIMITS.lifetimeMs ||
    (row.dispatched_at !== null && (row.dispatched_at < row.created_at || row.dispatched_at > row.deadline_at)) ||
    (row.settled_at !== null && row.settled_at < (row.dispatched_at ?? row.created_at)) ||
    (row.kind === "refresh" ? row.source_revision === null : row.source_revision !== null)
  )
    throw new Error("invalid")
  return { row, outcome }
}

export * as McpAuthJournalSchema from "./auth-journal-schema"
