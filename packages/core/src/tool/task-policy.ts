import { and, count, eq } from "drizzle-orm"
import { Effect, Schema, Semaphore } from "effect"
import type { AgentV2 } from "../agent"
import type { Database } from "../database/database"
import {
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_FANOUT,
  DEFAULT_OUTPUT_SCHEMA_BY_AGENT,
  OrchestrationSchemas,
  type OrchestrationSchemaName,
} from "../deepagent/orchestration"
import type { PermissionSchema } from "../permission/schema"
import type { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { SessionV2TaskCallAdmissionTable } from "../session/sql"
import { SessionV1 } from "../v1/session"
import { Wildcard } from "../util/wildcard"

export const MAX_SUBAGENT_FANOUT = DEFAULT_MAX_FANOUT
export const MAX_SUBAGENT_CONCURRENCY = DEFAULT_MAX_CONCURRENCY
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 30 * 60_000

const taskSlots = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>()

/**
 * C-P2-08 durable fan-out admission: one assistant message may start at most MAX_SUBAGENT_FANOUT
 * subagents, enforced against the `session_v2_task_call_admission` ledger so the count survives
 * process restarts and concurrent admissions. Exact tool-call retries do not consume another slot
 * (the globally unique tool_call_id row is the retry identity); a tool call id already recorded
 * against a DIFFERENT (session, message) batch is a conflicting reuse and refuses. The
 * check-then-insert runs inside one IMMEDIATE transaction, so racing admissions of the same batch
 * serialize and can never both fit under the cap.
 */
export const admitTaskCall = Effect.fn("TaskPolicy.admitTaskCall")(function* (
  db: Database.Interface["db"],
  input: {
    readonly sessionID: SessionSchema.ID
    readonly assistantMessageID: SessionMessage.ID
    readonly toolCallID: string
  },
) {
  // The ledger column speaks the V1 wire MessageID brand; both are `msg`-prefixed strings, so
  // conversion is a checked make() (task-run.ts wireMessageID convention).
  const wireMessageID = SessionV1.MessageID.make(input.assistantMessageID)
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const admitted = yield* tx
            .select({
              session_id: SessionV2TaskCallAdmissionTable.session_id,
              assistant_message_id: SessionV2TaskCallAdmissionTable.assistant_message_id,
            })
            .from(SessionV2TaskCallAdmissionTable)
            .where(eq(SessionV2TaskCallAdmissionTable.tool_call_id, input.toolCallID))
            .get()
            .pipe(Effect.orDie)
          if (admitted !== undefined)
            return (
              String(admitted.session_id) === String(input.sessionID) &&
              String(admitted.assistant_message_id) === String(wireMessageID)
            )
          const batch = yield* tx
            .select({ total: count() })
            .from(SessionV2TaskCallAdmissionTable)
            .where(
              and(
                eq(SessionV2TaskCallAdmissionTable.session_id, input.sessionID),
                eq(SessionV2TaskCallAdmissionTable.assistant_message_id, wireMessageID),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if ((batch?.total ?? 0) >= MAX_SUBAGENT_FANOUT) return false
          yield* tx
            .insert(SessionV2TaskCallAdmissionTable)
            .values({
              session_id: input.sessionID,
              assistant_message_id: wireMessageID,
              tool_call_id: input.toolCallID,
              created_at: Date.now(),
            })
            .run()
            .pipe(Effect.orDie)
          return true
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

/** Parent restrictions become child denies; delegation can never turn ask/deny into allow. */
export const inheritedTaskPermissions = (...rulesets: readonly PermissionSchema.Ruleset[]): PermissionSchema.Ruleset =>
  rulesets
    .flat()
    .filter((rule) => rule.effect !== "allow")
    .map((rule) => ({ action: rule.action, resource: rule.resource, effect: "deny" as const }))

const safeSharedWorkspaceActions = new Set([
  "read",
  "glob",
  "grep",
  "git_read",
  "webfetch",
  "websearch",
  "skill",
  "code_intel",
  "context_query",
  "capability_search",
  "capability.read",
  "question",
  "task",
  "plan",
  "external_directory",
])
const workspaceMutationActions = ["bash", "edit", "write", "apply_patch", "apply_patch_chunk"]

/** Fail closed while Core task children share their parent's workspace. */
export function canRunInSharedWorkspace(rules: PermissionSchema.Ruleset) {
  if (workspaceMutationActions.some((action) => !isActionWhollyDenied(action, rules))) return false
  return !rules.some(
    (rule) =>
      rule.effect !== "deny" &&
      rule.action !== "*" &&
      !safeSharedWorkspaceActions.has(rule.action) &&
      !workspaceMutationActions.includes(rule.action),
  )
}

/**
 * Workspace classification at launch: agents whose permissions cannot run safely in the shared
 * parent workspace (any non-denied mutation capability) get a run-owned isolated worktree; the
 * `shared_workspace_write` fail-closed refusal is replaced by this isolation — writes land in
 * the worktree, never the parent checkout.
 */
export function resolveWorkspaceMode(agent: Pick<AgentV2.Info, "permissions">) {
  return canRunInSharedWorkspace(agent.permissions) ? ("shared" as const) : ("worktree" as const)
}

/** Launch refusals (hidden/primary); workspace classification itself is {@link resolveWorkspaceMode}. */
export function taskLaunchRestriction(agent: Pick<AgentV2.Info, "hidden" | "mode" | "permissions">) {
  if (agent.hidden) return "hidden" as const
  if (agent.mode === "primary") return "primary" as const
}

export function withTaskConcurrency<A, E, R>(sessionID: string, effect: Effect.Effect<A, E, R>) {
  return Effect.suspend(() => {
    const current = taskSlots.get(sessionID)
    const entry = current ?? { semaphore: Semaphore.makeUnsafe(MAX_SUBAGENT_CONCURRENCY), users: 0 }
    if (!current) taskSlots.set(sessionID, entry)
    entry.users++
    return entry.semaphore.withPermit(effect).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          entry.users--
          if (entry.users === 0) taskSlots.delete(sessionID)
        }),
      ),
    )
  })
}

export function resolveOutputSchema(
  outputSchema: string | Record<string, unknown> | undefined,
  subagentType: string,
): Record<string, unknown> | undefined {
  if (typeof outputSchema === "object") return outputSchema
  const name =
    outputSchema === undefined || outputSchema.trim() === "default" || outputSchema.trim() === "auto"
      ? DEFAULT_OUTPUT_SCHEMA_BY_AGENT[subagentType]
      : outputSchema.trim()
  if (!name || !(name in OrchestrationSchemas)) return undefined
  const document = Schema.toJsonSchemaDocument(OrchestrationSchemas[name as OrchestrationSchemaName])
  if (Object.keys(document.definitions).length === 0) return document.schema as Record<string, unknown>
  return { ...document.schema, $defs: document.definitions } as Record<string, unknown>
}

function isActionWhollyDenied(action: string, rules: PermissionSchema.Ruleset) {
  const rule = rules.findLast((rule) => Wildcard.match(action, rule.action))
  return rule?.resource === "*" && rule.effect === "deny"
}
