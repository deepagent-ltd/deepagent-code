/**
 * Per-entry ownership declarations backing the seven-dimension classification.
 *
 * Every non-unclassified verdict must survive machine verification of its
 * requirements against the real import graph and AST shapes of the alpha tree;
 * a requirement that cannot be met demotes the dimension to "unclassified"
 * together with an explicit reason. Nothing here may be inferred by guessing:
 * dimensions without provable requirements stay open by design (C0-01 freeze).
 */
import type { Dimension, Requirement } from "./types"
import { RULE_PACKS } from "./rules"

export type VerdictRule = {
  readonly verdict: Exclude<import("./types").Verdict, "unclassified">
  readonly requirements: readonly Requirement[]
}

export type EntryRules = Readonly<Partial<Record<Dimension, VerdictRule>>>

const PROMPT_PATH_SUFFIX = "packages/deepagent-code/src/session/prompt.ts"

const RULES: ReadonlyArray<{ readonly match: (id: string) => boolean; readonly rules: EntryRules }> = [
  // C7-05 successor: the V2 admission path is ON by default and is the single writer — the
  // legacy GlobalBus mirror inside the bridge is a flag-gated (kill-switch OFF) fallback, so
  // the entry is the V2 authority (the runtime double-write=0 proof lives in the flag-gated
  // suites; the static rule reclassifies event.v2-bridge away from double_write).
  {
    match: (id) => id === "event.v2-bridge",
    rules: {
      event_producer_consumer: {
        verdict: "v2",
        requirements: [
          { kind: "importOf", fileSuffix: "src/event-v2-bridge.ts", specifierSuffix: "@deepagent-code/core/event" },
          { kind: "importOf", fileSuffix: "src/event-v2-bridge.ts", specifierSuffix: "@/bus/global" },
          { kind: "callChain", chain: "events.publish", fileSuffix: "src/event-v2-bridge.ts" },
          { kind: "callChain", chain: "isEventV2AdmissionEnabled", fileSuffix: "src/event-v2-bridge.ts" },
        ],
      },
    },
  },
  // Known legacy-only production path: IM server-side agents execute strictly through
  // the legacy SessionPrompt service (its own source documents this contract).
  {
    match: (id) => id === "im.agent-executor",
    rules: {
      execution_owner: {
        verdict: "legacy",
        requirements: [
          { kind: "reach", pathSuffix: PROMPT_PATH_SUFFIX },
          { kind: "callChain", chain: "promptOrSteer", fileSuffix: PROMPT_PATH_SUFFIX },
        ],
      },
    },
  },
  // The V2 tool registry is the policy-filtered registration/materialization writer.
  {
    match: (id) => id === "tools.v2-registry",
    rules: {
      provider_tool_writer: {
        verdict: "v2",
        requirements: [
          { kind: "reach", pathSuffix: "packages/core/src/tool/registry.ts" },
          { kind: "callChain", chain: "register", fileSuffix: "tool/registry.ts" },
          { kind: "callChain", chain: "materialize", fileSuffix: "tool/registry.ts" },
        ],
      },
    },
  },
  // Provider-plane modules are configuration/schema authorities that only read into
  // the provider/tool writer dimension; the stream bridge adapts to the vendor SDK.
  {
    match: (id) => id === "provider.model-catalog-parse",
    rules: {
      provider_tool_writer: {
        verdict: "read_only",
        requirements: [{ kind: "reach", pathSuffix: "packages/core/src/model.ts" }],
      },
    },
  },
  {
    match: (id) => id === "provider.provider-v2-schema",
    rules: {
      provider_tool_writer: {
        verdict: "read_only",
        requirements: [{ kind: "reach", pathSuffix: "packages/core/src/provider.ts" }],
      },
    },
  },
  {
    match: (id) => id === "provider.catalog-loader",
    rules: {
      provider_tool_writer: {
        verdict: "read_only",
        requirements: [{ kind: "reach", pathSuffix: "packages/core/src/catalog.ts" }],
      },
    },
  },
  {
    match: (id) => id === "provider.model-request-resolver",
    rules: {
      provider_tool_writer: {
        verdict: "read_only",
        requirements: [{ kind: "reach", pathSuffix: "packages/core/src/model-request.ts" }],
      },
    },
  },
  {
    match: (id) => id === "provider.aisdk-stream-bridge",
    rules: {
      provider_tool_writer: {
        verdict: "adapter",
        requirements: [
          { kind: "reach", pathSuffix: "packages/core/src/aisdk.ts" },
          { kind: "importOf", fileSuffix: "src/aisdk.ts", specifierSuffix: "@ai-sdk/provider" },
        ],
      },
    },
  },
  // Recovery face: V2 restart service owns recovery descriptors; database binding only
  // classifies/replays evidence read-only; the task recovery tool is the legacy path.
  {
    match: (id) => id === "recovery.session-execution-restart",
    rules: {
      recovery_owner: {
        verdict: "v2",
        requirements: [{ kind: "reach", pathSuffix: "packages/core/src/session/execution/restart.ts" }],
      },
    },
  },
  {
    match: (id) => id === "recovery.database-binding",
    rules: {
      recovery_owner: {
        verdict: "read_only",
        // NEW-P3-F rule: the entry's OWN module is the read fact. `database.ts` is not in the
        // closure since de09e5b17 (recovery-binding.ts imports the drizzle type directly); the
        // classifier still reads via its injected db — read-only, no write path.
        requirements: [{ kind: "reach", pathSuffix: "packages/core/src/database/recovery-binding.ts" }],
      },
    },
  },
  {
    match: (id) => id === "recovery.task-recovery-tool",
    rules: {
      recovery_owner: {
        verdict: "legacy",
        requirements: [{ kind: "reach", pathSuffix: "packages/deepagent-code/src/tool/task_recovery.ts" }],
      },
    },
  },
  {
    match: (id) => id === "recovery.provider-owner-runtime",
    rules: {
      recovery_owner: {
        verdict: "adapter",
        requirements: [{ kind: "reach", pathSuffix: "packages/deepagent-code/src/context-federation/provider-owner-runtime.ts" }],
      },
    },
  },
  ...RULE_PACKS,
]

/** Rules matching a given entry id (first match wins per dimension across all packs). */
export function rulesForEntry(id: string): EntryRules {
  const merged: Record<string, VerdictRule> = {}
  for (const pack of RULES) {
    if (!pack.match(id)) continue
    for (const [dimension, rule] of Object.entries(pack.rules)) {
      if (!merged[dimension]) merged[dimension] = rule as typeof merged[string]
    }
  }
  return merged as EntryRules
}

/**
 * Reason attached to every owner dimension left unclassified. Shared wording keeps the
 * report auditable; lane owners re-classify once their authority migration completes.
 */
export const OPEN_OWNER_REASON =
  "no statically provable single owner at this freeze point; owner decision belongs to the corresponding beta lane and must not be guessed"
