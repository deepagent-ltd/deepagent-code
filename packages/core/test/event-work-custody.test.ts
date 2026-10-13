import { expect, test } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { EventWorkController } from "../src/deepagent/event-work-controller"
import { EventWorkDagPolicy } from "../src/deepagent/event-work-dag.policy"
import { EventWorkNodeAuthority } from "../src/deepagent/event-work-node-authority"
import { EventWorkPlacement } from "../src/deepagent/event-work-placement"
import { WorkAuthorityPolicy } from "../src/session/work-authority-policy"
import { WorkCommandSchema } from "../src/session/work-command.schema"
import { WorkWriteStageSchema } from "../src/session/work-write-stage.schema"
import { code, configure, isolated, terminal } from "./fixture/event-work-dag"

// This is an actual file SQLite admission/accounting test using official migrations and
// controlled source facts. It starts no model/Native runner and cannot qualify a write graph.
test("E2 reserves existing command/stage debt once and unknown baseline/workspaces never refund capacity", () => isolated(async (f) => {
  await f.run(Effect.gen(function* () {
    const budget = { ...WorkAuthorityPolicy.DEEPSEEK_PROJECT_PROFILE.budget, maxProviderDispatches: 1, maxToolCalls: 1,
      maxTotalTokens: 1_052_672, hourTokensMax: 1_052_672, maxChildren: 0 }
    const env = yield* configure(f.directory, { version: 1, id: "custody-budget", maxConcurrent: 1, nodes: [
      { id: "inspect", agentID: "auto", instruction: "Inspect only.", dependencies: [], toolIDs: ["read"], budget, requiresWriteIsolation: false },
    ] })
    yield* terminal
    const receipt = yield* env.db.get<{ event_id: string }>("SELECT event_id FROM event_work_receipt")
    const root = yield* EventWorkController.prepare(env.db, { eventID: receipt!.event_id })
    const prepared = yield* EventWorkNodeAuthority.readPreparation(env.db, { controllerID: root.controller.controllerID,
      nodeID: "inspect", expectedRevision: root.controller.revision })
    if (prepared.rootWork.binding.schemaVersion !== "work-execution.v2") throw new Error("EXPECTED_V2_CUSTODY_FIXTURE")
    const started = yield* EventWorkController.beginBaseline(env.db, { controllerID: root.controller.controllerID,
      nodeID: "inspect", expectedRevision: prepared.controller.revision, originalCommit: "a".repeat(40),
      rootIdentity: prepared.rootWork.binding.projectScope.rootIdentity })
    expect(started.controller.baseline!.state).toBe("preparing")
    for (let index = 0; index < 5; index++) yield* env.db.run(sql`INSERT INTO event_task_workspace
      (event_id,task_id,generation,operation_key,repository_root,base_commit,branch,directory,state,error,time_created)
      VALUES(${receipt!.event_id},${`retained-${index}`},0,${`custody:${index}`},${f.directory},${"a".repeat(40)},
        ${`deepagent-code/event-${index.toString().padStart(24,"0")}`},${`${f.directory}/retained-${index}`},'ready','formal_physical_unknown',1)`)
    const capacity = yield* env.db.transaction((tx) => EventWorkNodeAuthority.requireWorkspaceCapacity(tx))
    expect(capacity.workspaces).toBe(5)
    expect(capacity.reservedBytes).toBe(5 * EventWorkPlacement.WORKSPACE_CUSTODY_RESERVATION_BYTES + EventWorkPlacement.BASELINE_CUSTODY_RESERVATION_BYTES)
    yield* EventWorkController.markBaselineUnknown(env.db, { controllerID: root.controller.controllerID,
      preparingHash: EventWorkDagPolicy.hash(started.controller.baseline) })
    expect(yield* env.db.transaction((tx) => EventWorkNodeAuthority.requireWorkspaceCapacity(tx))).toEqual(capacity)
    yield* env.db.run(sql`INSERT INTO event_task_workspace
      (event_id,task_id,generation,operation_key,repository_root,base_commit,branch,directory,state,time_created)
      VALUES(${receipt!.event_id},'sixth',0,'custody:sixth',${f.directory},${"a".repeat(40)},
        ${"deepagent-code/event-" + "6".repeat(24)},${`${f.directory}/sixth`},'retained',1)`)
    expect(code(yield* env.db.transaction((tx) => EventWorkNodeAuthority.requireWorkspaceCapacity(tx)).pipe(Effect.exit))).toBe("EVENT_DAG_CAPACITY")
    expect(yield* env.db.get("SELECT count(*) n FROM event_task_workspace WHERE error='formal_physical_unknown'")).toEqual({ n: 5 })
    expect(yield* env.db.get("SELECT count(*) n FROM work_dispatch_reservation")).toEqual({ n: 0 })
  }))
}), 60_000)

test("E2 refuses admission when an observed external meter exceeds its fixed partition", () => isolated(async (f) => {
  await f.run(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db.run(sql`INSERT INTO work_command_meter VALUES('custody-instance',0,${WorkCommandSchema.MAX_CUSTODY_BYTES + 1},0,1,1)`)
    expect(code(yield* db.transaction((tx) => EventWorkNodeAuthority.requireWorkspaceCapacity(tx)).pipe(Effect.exit))).toBe("EVENT_DAG_CAPACITY")
    yield* db.run(sql`UPDATE work_command_meter SET retained_bytes=${WorkCommandSchema.MAX_CUSTODY_BYTES},revision=revision+1`)
    yield* db.run(sql`INSERT INTO work_write_stage_meter VALUES('custody-instance',0,${WorkWriteStageSchema.MAX_RETAINED_BYTES + 1},0,1,1)`)
    expect(code(yield* db.transaction((tx) => EventWorkNodeAuthority.requireWorkspaceCapacity(tx)).pipe(Effect.exit))).toBe("EVENT_DAG_CAPACITY")
    expect(yield* db.get("SELECT count(*) n FROM work_execution")).toEqual({ n: 0 })
  }))
}), 60_000)
