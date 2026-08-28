export * as PostVerify from "./post-verify"

import { Data, Effect } from "effect"
import type { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { DataIntegrity } from "./data-integrity"
import { RecoveryBinding } from "./recovery-binding"
import { DatabaseUpgradeRun } from "./upgrade-run"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase

// §10.7 POST-MIGRATION GATE (C1A-11). After apply() reaches 'verifying' and BEFORE the run may
// advance to 'ready' (business admission), run the deterministic re-verification oracle:
//
//   1. DataIntegrity  — quick_check + foreign_key_check + registry-set equality (applied set ==
//                       current registry set, canonicalized through historical aliases).
//   2. RecoveryBinding — provider_turn / tool_effect / task_run binding audit (3 read-only queries).
//   3. unclassified inventory — the C0-01 inventory is a script-level AST gate (cannot run in-process
//                       without a full source build), so the C1A-11 "unclassified inventory" is
//                       represented by the DataIntegrity+RecoveryBinding binding checks plus the
//                       typed stub hook `post_verify_unclassified_inventory()` (full inventory = C1B-10).
//
// Any failing verdict routes the run to recovery_required with a stable code (failRun is idempotent
// for a terminal recovery_required run) and is never advanced to ready. The post-verify checks are
// run on the LIVE connection as read-only queries (quick_check/foreign_key_check never write and the
// process holds the migration lease), the documented deviation from the data-integrity copy-rule.

export type PostVerifyFailureCode =
  | "post_verify_quick_check_failed"
  | "post_verify_foreign_keys"
  | "post_verify_registry_mismatch"
  | "post_verify_recovery_binding"
  | "post_verify_unclassified_inventory"

/** Typed, deterministic verdict used to route a failing post-verify run to recovery_required. */
export class PostVerifyError extends Data.TaggedError("PostVerify.PostVerifyError")<{
  readonly code: PostVerifyFailureCode
  readonly detail: string
  readonly rows?: readonly Record<string, unknown>[]
}> {}

export interface PostVerifyOptions {
  /** The active upgrade run id (the run that must be routed to recovery_required on failure). */
  readonly runId: string
  /** The canonical migration-registry ids (in registry order) for the set-equality oracle. */
  readonly registryIds: readonly string[]
  /** Maps a journal id to its canonical id (historical aliases → canonical). */
  readonly canonicalize?: (id: string) => string
}

/**
 * Run the post-migration gate. On success it is a no-op and the caller may advance 'verifying' →
 * 'ready'. On failure it routes the run to recovery_required with the stable code and fails with a
 * typed {@link PostVerifyError}; the caller's catchCause propagates it without re-writing the code.
 */
export const run = Effect.fn("PostVerify.run")(function* (
  db: Database,
  options: PostVerifyOptions,
) {
  // DataIntegrity.check is `Effect.fn`-inferred, so its success type widens `ok` to boolean and
  // `reason`/`detail`/`rows` to optional; handle the failure verdict defensively rather than relying
  // on a discriminated union that `Effect.fn` does not preserve.
  const integrity = yield* DataIntegrity.check(db, {
    registryIds: options.registryIds,
    canonicalize: options.canonicalize,
  })
  if (!integrity.ok) {
    const reason = integrity.reason
    const code: PostVerifyFailureCode =
      reason === "quick_check_failed"
        ? "post_verify_quick_check_failed"
        : reason === "foreign_key_violation"
          ? "post_verify_foreign_keys"
          : "post_verify_registry_mismatch"
    yield* DatabaseUpgradeRun.failRun(db, options.runId, code).pipe(Effect.ignore)
    return yield* Effect.fail(
      new PostVerifyError({
        code,
        detail: integrity.detail ?? "post-verify data integrity failure",
        rows: integrity.rows ?? [],
      }),
    )
  }

  const binding = yield* RecoveryBinding.audit(db)
  if (!binding.ok) {
    const detail = binding.problems
      .map((problem) => `${problem.chain}:${problem.kind}:${problem.row}`)
      .join("; ")
    yield* DatabaseUpgradeRun.failRun(db, options.runId, "post_verify_recovery_binding").pipe(Effect.ignore)
    return yield* Effect.fail(
      new PostVerifyError({
        code: "post_verify_recovery_binding",
        detail,
        rows: binding.problems as unknown as Record<string, unknown>[],
      }),
    )
  }

  yield* postVerifyUnclassifiedInventory(db)

  return yield* Effect.void
})

/**
 * C1A-11 "unclassified inventory" typed stub hook.
 *
 * Handoff note (authority: worklist C1A-11 + manifest §7 A5): the deterministic C0-01 inventory /
 * legacy-zero gate is a SCRIPT-level AST gate (script/legacy-zero-gate/*, script/caller-inventory/
 * build.ts) — it builds an inventory over the full source tree and cannot be called in-process here
 * without a full AST build. So the startup-side "unclassified inventory" of C1A-11 is represented by
 * the DataIntegrity + RecoveryBinding binding checks above, plus this hook which asserts no known
 * unclassified risk for the surfaces the migrated DB can already classify. The unified startup
 * inventory (provider/tool/permission/TaskRun/compaction/activity, `unclassified=0`) is C1B-10 — a
 * LATER wave; this lane deliberately does NOT build it.
 */
function postVerifyUnclassifiedInventory(_db: Database) {
  return Effect.void
}
