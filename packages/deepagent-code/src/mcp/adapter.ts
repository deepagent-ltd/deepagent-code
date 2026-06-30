import type { RiskTier } from "./catalog"

/**
 * M7 (S1-v3.4): MCP control-plane policy layer (pure helpers).
 *
 * deepagent-code does NOT execute MCP tools or modify any upstream server. This module provides the
 * pure policy helpers the design calls for: deriving a default permission from a server's risk
 * tier, and fail-closed read-only SQL validation.
 *
 * WIRING STATUS:
 *  - `defaultPermissionForTier` / `resolveToolRisk` ARE wired into the live MCP tool permission path.
 *    `session/tools.ts` reads each MCP tool's risk tier (carried via provenance) and gates per tier:
 *    `read_only` → auto-allow; `write_guarded` / `external_fetch` → `ctx.ask`. A non-matching server
 *    resolves to `write_guarded` → ask (fail-closed).
 *  - SECURITY — tier is NOT trusted from persisted config. `mcp/index.ts` DERIVES the tier at
 *    `tools()` time by structurally matching the live server config against the catalog templates
 *    (`McpCatalog.deriveTier`). The persisted `riskTier` field is attacker-writable (the `add`
 *    endpoint forwards client config; project-local config is auto-merged + not gitignored), so it is
 *    ignored by the gate — a server only earns `read_only` auto-allow if its command genuinely matches
 *    the vetted read-only template. Safety comes from the command + this SQL guard, not from a label.
 *  - `assertReadOnlySql` IS invoked on the live read_only DB tool path. `session/tools.ts` extracts
 *    SQL-bearing args (heuristic over known key names, recursing into nested objects) from a
 *    `read_only`-tier tool call and rejects any statement not provably read-only BEFORE execution —
 *    defense-in-depth on top of the server's own `--access-mode=restricted`.
 *  - REMAINING FOLLOW-UP (tracked in §9): the credential secure-storage indirection is NOT yet built.
 *    Today the frontend collects the raw secret and `credentialRefs` carries the actual value, which
 *    `instantiate` splices into env/headers, so secrets live in the connected server's config. The
 *    KEY-NAME-only guarantee holds for the catalog DEFINITION, not yet for the runtime value path.
 *
 * Design invariants these helpers encode:
 *  - dangerous writes fail-closed: anything not provably read-only resolves to `ask`.
 *  - unknown-risk → write_guarded → ask (never silently allowed).
 */

export type PermissionAction = "allow" | "ask" | "deny"

/**
 * Risk tier → default permission action for that server's tools.
 *  - read_only      → allow (the server itself is constrained to reads).
 *  - write_guarded  → ask   (writes must be approved per-call).
 *  - external_fetch → ask   (outbound network: audited + summarized, approved per-call).
 *
 * A server whose risk cannot be determined must be treated as write_guarded by the caller
 * BEFORE reaching here (fail-closed); this function only maps a known tier.
 */
export function defaultPermissionForTier(tier: RiskTier): PermissionAction {
  switch (tier) {
    case "read_only":
      return "allow"
    case "write_guarded":
    case "external_fetch":
      return "ask"
    default: {
      // Exhaustiveness guard: an unrecognized tier is fail-closed.
      const _exhaustive: never = tier
      void _exhaustive
      return "ask"
    }
  }
}

/**
 * Fail-closed risk resolution for an MCP tool whose tier may be unknown. A tool with no
 * resolvable tier is forced to `write_guarded` (→ ask), per M7 acceptance (d).
 */
export function resolveToolRisk(tier: RiskTier | undefined): RiskTier {
  return tier ?? "write_guarded"
}

// SQL statements that mutate data or schema. Read-only DB MCP (M5) must reject these even
// though the server already runs in restricted mode — this is the second, fail-closed layer.
// `INTO` covers `SELECT … INTO new_table` (Postgres table creation that otherwise has a SELECT prefix).
const WRITE_SQL =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|MERGE|REPLACE|UPSERT|COMMENT|VACUUM|REINDEX|CLUSTER|COPY|INTO|CALL|DO|SET|LOCK|REFRESH|PREPARE|EXECUTE|NEXTVAL|SETVAL)\b/i

// Volatile / side-effecting function calls that pass a SELECT prefix but are not safe in read-only mode.
const SIDE_EFFECT_FN =
  /\b(pg_sleep|pg_terminate_backend|pg_cancel_backend|setval|nextval|lo_import|lo_export|dblink|pg_read_file|pg_logical_emit_message)\s*\(/i

// Strip SQL comments (-- line, /* block */) and collapse whitespace before lexical analysis, so a
// write keyword cannot be hidden behind a comment or odd spacing.
const stripSqlComments = (sql: string): string =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim()

// Statements we positively recognize as read-only. Anything else is rejected (fail-closed):
// if we cannot prove a statement is read-only, we do not allow it.
const READ_SQL = /^\s*(WITH\b[\s\S]*\bSELECT\b|SELECT\b|EXPLAIN\b|SHOW\b|TABLE\b|VALUES\b)/i

export interface SqlGuardResult {
  allowed: boolean
  reason?: string
}

/**
 * M5 second-layer read-only SQL guard (fail-closed). Rejects any statement containing a
 * write/DDL keyword, and rejects anything not positively recognized as read-only.
 * Note: this is a coarse lexical guard intended as defense-in-depth on top of the server's
 * own `--access-mode=restricted`; it is deliberately conservative (prefer false-reject).
 */
export function assertReadOnlySql(sql: string): SqlGuardResult {
  // Strip comments first so a write keyword cannot hide behind `--` / block comments.
  const cleaned = stripSqlComments(sql)
  if (cleaned.length === 0) return { allowed: false, reason: "empty SQL" }
  // Reject multi-statement payloads outright (a trailing `;` is fine; an interior one is not).
  const withoutTrailing = cleaned.replace(/;\s*$/, "")
  if (withoutTrailing.includes(";")) {
    return { allowed: false, reason: "multiple statements are not allowed in read-only mode" }
  }
  if (WRITE_SQL.test(withoutTrailing)) {
    return { allowed: false, reason: "write/DDL statements are rejected in read-only mode" }
  }
  if (SIDE_EFFECT_FN.test(withoutTrailing)) {
    return { allowed: false, reason: "side-effecting function calls are rejected in read-only mode" }
  }
  if (!READ_SQL.test(withoutTrailing)) {
    return {
      allowed: false,
      reason: "statement is not provably read-only (only SELECT/EXPLAIN/SHOW/WITH…SELECT allowed)",
    }
  }
  return { allowed: true }
}

export * as McpAdapter from "./adapter"
