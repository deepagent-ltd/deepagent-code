export * as EventArtifactNativeFault from "@test/installation/fixture/event-artifact-native-fault"

import fs from "node:fs/promises"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventWorkController } from "@deepagent-code/core/deepagent/event-work-controller"
import { EventWorkNodeAuthority } from "@deepagent-code/core/deepagent/event-work-node-authority"
import { WorkToolPolicy } from "@deepagent-code/core/session/work-tool-policy"
import { AppRuntime } from "@/effect/app-runtime"
import { Service } from "@/installation/work-execution-profile"
import { ServerAuth } from "@/server/auth"
import { cmd } from "@/cli/cmd/cmd"
import { EventDagNativeCrash } from "@test/installation/fixture/event-dag-native-crash"

const Collect = Schema.Struct({
  mode: Schema.Literal("collect"),
  workID: Schema.String.check(Schema.isMinLength(1)),
  expectedProviderCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})

export async function run() {
  const descriptor = process.env.DAC_EVENT_DAG_FAULT_INPUT
  const output = process.env.DAC_EVENT_DAG_FAULT_RESULT
  if (!descriptor || !output) throw new Error("An explicit isolated candidate descriptor and result are required")
  const input: unknown = await Bun.file(descriptor).json()
  const outcome = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const mode = yield* Schema.decodeUnknownEffect(Schema.Struct({ mode: Schema.String }))(input)
      if (mode.mode !== "collect")
        return yield* EventDagNativeCrash.execute(yield* Schema.decodeUnknownEffect(EventDagNativeCrash.Input)(input))
      const request = yield* Schema.decodeUnknownEffect(Collect)(input)
      const database = yield* Database.Service
      const installed = yield* Service
      if (!installed.eventPlacement || !installed.leafProof)
        throw new Error("Original installed Event placement is required")
      const before = yield* census(database.db, request.workID)
      if (before.providers !== request.expectedProviderCount)
        throw new Error("Original provider census changed before collection")
      // The documented retention option applies only after the original Root's
      // startup. It must not cause boot GC to consume the scenario first.
      process.env.DEEPAGENT_CODE_TASK_WORKTREE_RETENTION_MS = "1"
      const collected = yield* installed.eventPlacement
        .collectKnown(request.workID)
        .pipe(Effect.provideService(WorkToolPolicy.LeafProof, installed.leafProof), Effect.exit)
      const after = yield* census(database.db, request.workID)
      const failure = Exit.isFailure(collected)
        ? Schema.decodeUnknownOption(
            Schema.Struct({ code: Schema.optional(Schema.String), _tag: Schema.optional(Schema.String) }),
          )(Cause.squash(collected.cause))
        : Option.none()
      return {
        mode: "collect",
        pid: process.pid,
        success: Exit.isSuccess(collected),
        collected: Exit.isSuccess(collected) ? collected.value : null,
        failure: Option.isSome(failure) ? failure.value : null,
        before,
        after,
      }
    }).pipe(Effect.provide(ServerAuth.Config.defaultLayer), Effect.scoped, Effect.exit),
  )
  await AppRuntime.dispose()
  if (Exit.isFailure(outcome)) {
    await fs.writeFile(output, JSON.stringify({ stage: "collector-entry", failure: Cause.pretty(outcome.cause) }), {
      mode: 0o600,
    })
    process.exitCode = 1
    return
  }
  await fs.writeFile(output, JSON.stringify(outcome.value), { mode: 0o600 })
}

export const DebugCommand = cmd({ command: "debug", handler: run })

function census(db: Database.Interface["db"], workID: string) {
  return Effect.gen(function* () {
    const provider = yield* db.get<{ count: number }>(sql`SELECT count(*) count FROM session_provider_attempt`)
    if (!provider) throw new Error("Isolated provider census is unavailable")
    const ledger = Object.fromEntries(
      yield* Effect.forEach(
        [
          "work_count_acquisition",
          "work_dispatch_reservation",
          "session_input",
          "session_v2_provider_turn_receipt",
          "work_command_intent",
          "work_write_stage",
          "work_command_meter",
          "work_write_stage_meter",
          "work_execution",
        ],
        (table) =>
          db
            .all<Record<string, unknown>>(sql.raw(`SELECT * FROM ${table} ORDER BY rowid`))
            .pipe(Effect.map((rows) => [table, rows] as const)),
      ),
    )
    const authority = yield* EventWorkNodeAuthority.get(db, workID)
    if (!authority) throw new Error("Original node authority is unavailable")
    const controller = yield* db.transaction((tx) => EventWorkController.get(tx, authority.controllerID))
    if (!controller) throw new Error("Original controller custody is unavailable")
    return {
      providers: provider.count,
      ledger,
      capacity: yield* db.transaction((tx) => EventWorkNodeAuthority.requireWorkspaceCapacity(tx)),
      authority,
      controller: controller.controller,
      workspace: yield* db.get<{
        state: string
        error: string | null
      }>(sql`SELECT w.state,w.error FROM event_task_workspace w
        JOIN event_work_node_authority n ON json_extract(n.record,'$.placement.eventID')=w.event_id AND n.node_id=w.task_id
        WHERE n.work_id=${workID} AND w.generation=0`),
    }
  })
}
