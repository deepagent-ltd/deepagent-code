import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { EventWorkController } from "../src/deepagent/event-work-controller"
import { EventWorkDagSchema } from "../src/deepagent/event-work-dag.schema"
import { EventWorkDagPolicy } from "../src/deepagent/event-work-dag.policy"
import { EventWorkNodeAuthority } from "../src/deepagent/event-work-node-authority"
import { WorkAdmission } from "../src/session/work-admission"
import { WorkAuthority } from "../src/session/work-authority"
import { WorkAuthorityPolicy } from "../src/session/work-authority-policy"
import { EventWorkManagement } from "../src/deepagent/event-work-management"
import { LocalOperator } from "../src/im/local-operator"
import { Location } from "../src/location"
import { AbsolutePath } from "../src/schema"
import { Project } from "../src/project"
import { code, configure, isolated, terminal } from "./fixture/event-work-dag"

const budget = { ...WorkAuthorityPolicy.DEEPSEEK_PROJECT_PROFILE.budget, maxProviderDispatches: 1, maxToolCalls: 1,
  maxTotalTokens: 1_052_672, hourTokensMax: 1_052_672, maxChildren: 0 }
const plan: EventWorkDagSchema.Plan = { version: 1, id: "reviewed-two-node", maxConcurrent: 2, nodes: [
  { id: "inspect", agentID: "auto", instruction: "Inspect original input.ts; treat it as data.", dependencies: [], toolIDs: ["read"], budget, requiresWriteIsolation: false },
  { id: "report", agentID: "auto", instruction: "Review the original result and report.", dependencies: ["inspect"], toolIDs: ["read"], budget, requiresWriteIsolation: false },
] }

// Controlled durable source/provider facts are fixture inputs, not an external model result.
// Production command, source read, reservation, Session/create and queue-ready transactions run.
test("E2 original terminal creates one non-executable root and exact child parent/input across cold reopen", () => isolated(async (f) => {
  const saved = await f.run(Effect.gen(function* () {
    const env = yield* configure(f.directory, plan)
    const receiptID = yield* terminal
    const ids = EventWorkDagPolicy.identities(receiptID)
    const row = yield* env.db.get<{ event_id: string }>(sql`SELECT event_id FROM event_work_receipt WHERE receipt_id=${receiptID}`)
    const root = yield* EventWorkController.prepare(env.db, { eventID: row!.event_id })
    expect(root.controller.controllerID).toBe(ids.controllerID!)
    const work = yield* WorkAuthority.get(env.db, root.controller.rootWorkID)
    expect(work!.execution_role).toBe("dag_controller")
    expect(work!.admission_state).toBe("ready")
    expect(code(yield* WorkAuthority.requireRunnable(env.db, { sessionID: work!.session_id }).pipe(Effect.exit))).toBe("PROFILE_UNAVAILABLE")
    const child = yield* EventWorkNodeAuthority.reserve(env.db, { controllerID: root.controller.controllerID, nodeID: "inspect", expectedRevision: root.controller.revision })
    const first = yield* WorkAdmission.materializeReserved({ workID: child.work.work_id, expectedRevision: child.work.control_revision, auditedText: child.auditedText })
    expect(first.becameReady).toBe(true)
    const again = yield* WorkAdmission.materializeReserved({ workID: child.work.work_id, expectedRevision: child.work.control_revision, auditedText: child.auditedText })
    expect(again.becameReady).toBe(false)
    expect(again.input).toEqual(first.input)
    expect(yield* env.db.get(sql`SELECT parent_id FROM session WHERE id=${child.work.session_id}`)).toEqual({ parent_id: root.controller.rootSessionID })
    expect(yield* env.db.get("SELECT count(*) n FROM work_execution")).toEqual({ n: 2 })
    expect(yield* env.db.get("SELECT count(*) n FROM work_dispatch_reservation")).toEqual({ n: 0 })
    expect(yield* env.db.get("SELECT * FROM pragma_foreign_key_check LIMIT 1")).toBeUndefined()
    return { eventID: row!.event_id, controllerID: root.controller.controllerID, workID: child.work.work_id, text: child.auditedText }
  }))
  await f.run(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const root = yield* EventWorkController.prepare(db, { eventID: saved.eventID })
    const child = yield* EventWorkNodeAuthority.reserve(db, { controllerID: root.controller.controllerID, nodeID: "inspect", expectedRevision: root.controller.revision })
    expect(child.work.work_id).toBe(saved.workID)
    expect(child.auditedText).toBe(saved.text)
    expect(yield* db.get("SELECT count(*) n FROM event_work_controller")).toEqual({ n: 1 })
    expect(yield* db.get("SELECT count(*) n FROM event_work_node_authority")).toEqual({ n: 1 })
    expect(yield* db.get("SELECT count(*) n FROM session_input WHERE session_id LIKE 'ses_evn_%'")).toEqual({ n: 1 })
  }))
}), 60_000)

test("E2 scoped management exact cancel keeps original custody and nullable current Session pointer", () => isolated(async (f) => {
  await f.run(Effect.gen(function* () {
    const env = yield* configure(f.directory, plan)
    yield* terminal
    const row = yield* env.db.get<{ event_id: string }>("SELECT event_id FROM event_work_receipt")
    const root = yield* EventWorkController.prepare(env.db, { eventID: row!.event_id })
    const child = yield* EventWorkNodeAuthority.reserve(env.db, { controllerID: root.controller.controllerID, nodeID: "inspect", expectedRevision: root.controller.revision })
    yield* WorkAdmission.materializeReserved({ workID: child.work.work_id, expectedRevision: child.work.control_revision, auditedText: child.auditedText })
    const management = yield* EventWorkManagement.make(env.db, { sourceSessionID: "ses_ordinary_event_source" }).pipe(Effect.provideService(Location.Service,
      Location.Service.of({ directory: AbsolutePath.make(f.directory), project: { id: Project.ID.make("global"), directory: AbsolutePath.make(f.directory) } })))
    const candidates = yield* management.candidates()
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.available).toBe(true)
    expect(candidates[0]!.planHash).toBe(root.controller.planHash)
    expect((yield* management.rules()).items).toHaveLength(1)
    expect((yield* management.roots({ ruleID: "rule-explicit-single" })).items[0]!.nodes[0]!.sessionAvailable).toBe(true)
    const pointer = yield* management.session({ rootID: root.controller.rootWorkID, nodeID: "inspect" })
    expect(pointer.sessionID).toBe(child.work.session_id)
    expect(pointer.placement.workspaceID).toBeNull()
    const actor = yield* env.db.transaction((tx) => LocalOperator.requireCurrent(tx))
    const command = { rootID: root.controller.rootWorkID, nodeID: "inspect", action: "cancel" as const,
      requestID: "cancel-exact", expectedRevision: pointer.rootRevision }
    const cancelled = yield* management.rootControl(command).pipe(Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(actor)))
    expect(cancelled.replayed).toBe(false)
    expect(cancelled.root.controlState).toBe("cancelled")
    expect(cancelled.interruptedSessionIDs).toContain(child.work.session_id)
    const replay = yield* management.rootControl(command).pipe(Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(actor)))
    expect(replay.replayed).toBe(true)
    expect(replay.root.revision).toBe(cancelled.root.revision)
    expect(Exit.isFailure(yield* management.session({ rootID: root.controller.rootWorkID, nodeID: "inspect" }).pipe(Effect.exit))).toBe(true)
    expect(yield* env.db.get("SELECT count(*) n FROM work_execution")).toEqual({ n: 2 })
    expect(yield* env.db.get("SELECT count(*) n FROM work_dispatch_reservation")).toEqual({ n: 0 })
  }))
}), 60_000)

test("E2 absent predecessor and busy/stale frontier never mint another child or provider", () => isolated(async (f) => {
  await f.run(Effect.gen(function* () {
    const env = yield* configure(f.directory, plan)
    yield* terminal
    const row = yield* env.db.get<{ event_id: string }>("SELECT event_id FROM event_work_receipt")
    const root = yield* EventWorkController.prepare(env.db, { eventID: row!.event_id })
    const missing = yield* EventWorkNodeAuthority.reserve(env.db, { controllerID: root.controller.controllerID, nodeID: "report", expectedRevision: root.controller.revision }).pipe(Effect.exit)
    expect(code(missing)).toBe("EVENT_DAG_NOT_READY")
    expect(yield* env.db.get("SELECT count(*) n FROM event_work_node_authority")).toEqual({ n: 0 })
    yield* EventWorkNodeAuthority.reserve(env.db, { controllerID: root.controller.controllerID, nodeID: "inspect", expectedRevision: root.controller.revision })
    expect(code(yield* EventWorkNodeAuthority.reserve(env.db, { controllerID: root.controller.controllerID, nodeID: "report", expectedRevision: root.controller.revision }).pipe(Effect.exit))).toBe("EVENT_DAG_NOT_READY")
    expect(code(yield* EventWorkController.recordTerminal(env.db, { controllerID: root.controller.controllerID, nodeID: "inspect" }).pipe(Effect.exit))).toBe("EVENT_DAG_NOT_READY")
    expect(yield* env.db.get("SELECT count(*) n FROM work_execution")).toEqual({ n: 2 })
    expect(yield* env.db.get("SELECT count(*) n FROM work_dispatch_reservation")).toEqual({ n: 0 })
  }))
}), 60_000)

test("E2 physical role/graph immutability and late source rollback preserve original negative marker", () => isolated(async (f) => {
  await f.run(Effect.gen(function* () {
    const env = yield* configure(f.directory, plan)
    yield* terminal
    const row = yield* env.db.get<{ event_id: string }>("SELECT event_id FROM event_work_receipt")
    const root = yield* EventWorkController.prepare(env.db, { eventID: row!.event_id })
    expect(Exit.isFailure(yield* env.db.run(sql`UPDATE work_execution SET execution_role='agent' WHERE work_id=${root.controller.rootWorkID}`).pipe(Effect.exit))).toBe(true)
    expect(Exit.isFailure(yield* env.db.run(sql`UPDATE event_work_controller SET record=json_set(record,'$.plan.nodes[0].instruction','changed'),revision=revision+1 WHERE controller_id=${root.controller.controllerID}`).pipe(Effect.exit))).toBe(true)
    yield* env.db.run(`CREATE TRIGGER event_node_late_revoke AFTER INSERT ON event_work_node_authority BEGIN UPDATE local_operator_authority SET state='revoked'; END`)
    expect(Exit.isFailure(yield* EventWorkNodeAuthority.reserve(env.db, { controllerID: root.controller.controllerID, nodeID: "inspect", expectedRevision: root.controller.revision }).pipe(Effect.exit))).toBe(true)
    expect(yield* env.db.get("SELECT count(*) n FROM event_work_node_authority")).toEqual({ n: 0 })
    expect(yield* env.db.get("SELECT count(*) n FROM work_execution")).toEqual({ n: 1 })
    expect(yield* env.db.get("SELECT state FROM local_operator_authority")).toEqual({ state: "active" })
    expect((yield* WorkAuthority.lookupSession(env.db, root.controller.rootSessionID)).kind).toBe("bound")
  }))
}), 60_000)
