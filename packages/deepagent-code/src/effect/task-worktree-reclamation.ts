export * as TaskWorktreeReclamation from "./task-worktree-reclamation"

import { Effect, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { TaskWorkspace } from "@deepagent-code/core/session/task-workspace"
import * as Log from "@deepagent-code/core/util/log"

// C-P2-08 — startup reclamation of stale retained run-owned worktrees.
//
// WS4b-S2 made task timeouts RETAIN the run-owned worktree (the resume-by-task_id pointer must
// stay real), but nothing ever reclaimed that retention debt. This module is the reclaim side:
// building the layer = one sweep at process boot (same layer-build-means-boot convention as the
// C1B RecoveryExecutor startup drain), scanning the durable task_run ledger — never a new
// process, never a timer — for RUN-owned worktrees whose run is terminal and whose settle is
// older than the retention grace (TaskWorkspace.DEFAULT_WORKTREE_RETENTION_MS, 7 days; override
// with DEEPAGENT_CODE_TASK_WORKTREE_RETENTION_MS in milliseconds). Inside the grace the sweep
// touches nothing; `recovery_required` runs are never terminal, so a recoverable run is never
// reclaimed. Past the grace the worktree and its deepagent-code/task-* branch are deleted and
// the receipt settles to `reclaimed`, so resume-by-task_id answers with an honest refusal.
//
// The sweep NEVER fails the boot: per-row failures keep their rows `retained` as cleanup debt and
// the next boot retries (TaskWorkspace.reclaimStale is best-effort per row by contract).

const log = Log.create({ service: "task-worktree-reclamation" })

export const layer: Layer.Layer<never, never, Database.Service> = Layer.effectDiscard(
  Effect.gen(function* () {
    const database = yield* Database.Service
    const report = yield* TaskWorkspace.reclaimStale(database.db).pipe(
      Effect.catchCause((cause): Effect.Effect<TaskWorkspace.ReclaimStaleReport> =>
        Effect.logWarning("task worktree reclamation sweep failed", { cause: cause }).pipe(
          Effect.as({ scanned: 0, reclaimed: 0, failed: [] }),
        ),
      ),
    )
    if (report.reclaimed > 0 || report.failed.length > 0)
      log.info("task_worktree_reclamation_sweep", {
        scanned: report.scanned,
        reclaimed: report.reclaimed,
        failed: report.failed.length,
      })
  }),
)
