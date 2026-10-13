import { expect, test } from "bun:test"
import path from "node:path"
import { Cause, Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../../src/database/database"
import { GoalChild } from "../../src/deepagent/goal-child"
import { GoalChildSchema } from "../../src/deepagent/goal-child.schema"
import { GoalControl } from "../../src/deepagent/goal-control"
import { SessionV2 } from "../../src/session"
import { SessionSchema } from "../../src/session/schema"
import { SessionMessage } from "../../src/session/message"
import { Prompt } from "../../src/session/prompt"
import { SessionStore } from "../../src/session/store"
import { SessionExecution } from "../../src/session/execution"
import { GoalChildFixture } from "../fixture/goal-child"
import { GoalChildColdFixture } from "../fixture/goal-child-cold"

function code<A, E>(exit: Exit.Exit<A, E>) {
  if (Exit.isSuccess(exit)) return "success"
  const error = Cause.squash(exit.cause)
  return error instanceof GoalChildSchema.Error ? error.code : Cause.pretty(exit.cause)
}

test("actual Session event transactions record one child and exact input receipt", () =>
  GoalChildFixture.isolated(({ directory, state }) =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      const setup = yield* GoalChildFixture.prepare(directory)
      const first = yield* GoalChild.admit(db, sessions, setup.admission)
      const retry = yield* GoalChild.admit(db, sessions, setup.admission)
      expect(retry.unit).toEqual(first.unit)
      expect(first.unit.creation_receipt?.seq).toBe(0)
      expect(first.unit.inputs[0].admittedSeq).toBe(first.admitted.admittedSeq)
      expect(first.unit.binding.permissions).toEqual(setup.parent.permissions)
      expect(first.unit.binding.permissionPolicy).toBe("parent-exact-v1")
      expect(
        yield* db.all(sql`SELECT id FROM session_input WHERE session_id=${first.unit.child_session_id}`),
      ).toHaveLength(1)
      expect(state).toEqual({ locations: 0, runs: 0, shells: 0 })
    }),
  ))

test("ordinary Session still writes and drains through actual local ownership", () =>
  GoalChildFixture.isolated(({ directory, state }) =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const setup = yield* GoalChildFixture.prepare(directory)
      yield* sessions.prompt({ sessionID: setup.parent.id, prompt: new Prompt({ text: "ordinary" }), resume: false })
      yield* sessions.shell({ sessionID: setup.parent.id, command: "controlled fixture" })
      yield* (yield* SessionExecution.Service).resume(setup.parent.id)
      expect(state).toEqual({ locations: 1, runs: 1, shells: 1 })
      expect(yield* (yield* SessionStore.Service).claimToken(setup.parent.id)).toBeUndefined()
    }),
  ))

test("same file in a new process refuses cold resume and advisory wake without a claim", () =>
  GoalChildFixture.isolated(({ directory, filename }) =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const setup = yield* GoalChildFixture.prepare(directory)
      const child = yield* GoalChild.admit((yield* Database.Service).db, sessions, setup.admission)
      const parentBefore = yield* GoalChildColdFixture.inspect(filename, child.unit.child_session_id)
      const evidence = process.env.DEEPAGENT_TEST_GOAL_CHILD_EVIDENCE
      if (evidence)
        yield* Effect.promise(() =>
          Bun.write(
            path.join(evidence, "parent-before.json"),
            JSON.stringify({ pid: process.pid, facts: parentBefore }, null, 2),
          ),
        )
      const result = yield* Effect.promise(async () => {
        const process = Bun.spawn(
          [
            Bun.which("bun")!,
            path.join(import.meta.dir, "../fixture/goal-child-cold.ts"),
            filename,
            child.unit.child_session_id,
          ],
          { stdout: "pipe", stderr: "pipe" },
        )
        const [status, stdout, stderr] = await Promise.all([
          process.exited,
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
        ])
        if (evidence)
          await Promise.all([
            Bun.write(path.join(evidence, "child.stdout.log"), stdout),
            Bun.write(path.join(evidence, "child.stderr.log"), stderr),
          ])
        expect({ status, stderr }).toEqual({ status: 0, stderr: "" })
        return JSON.parse(
          stdout
            .split("\n")
            .find((line) => line.startsWith("GOAL_CHILD_COLD_RESULT "))!
            .slice("GOAL_CHILD_COLD_RESULT ".length),
        ) as Awaited<ReturnType<typeof GoalChildColdFixture.run>>
      })
      const parentAfter = yield* GoalChildColdFixture.inspect(filename, child.unit.child_session_id)
      if (evidence)
        yield* Effect.promise(() =>
          Bun.write(
            path.join(evidence, "same-file-cold-result.json"),
            JSON.stringify({ parentPID: process.pid, parentBefore, child: result, parentAfter }, null, 2),
          ),
        )
      expect(parentBefore.file).toEqual(result.before.file)
      expect(result.before.file).toEqual(result.after.file)
      expect(parentAfter.file).toEqual(parentBefore.file)
      expect(result.before).toEqual(parentBefore)
      expect(result.after).toEqual(parentBefore)
      expect(parentAfter).toEqual(parentBefore)
      expect(result.factsUnchanged).toBe(true)
      expect(result.pid).not.toBe(process.pid)
      expect(result.coldAdmission).toBe("GOAL_CHILD_RECOVERY_REQUIRED")
      expect(result.unitID).toBe(child.unit.unit_id)
      expect(result.codes).toEqual([
        "GOAL_CHILD_RECOVERY_REQUIRED",
        "GOAL_CHILD_RECOVERY_REQUIRED",
        "advisory_scheduled",
        "GOAL_CHILD_MANAGED",
      ])
      expect(result.claim).toBeNull()
      expect(result.eventsUnchanged).toBe(true)
      expect(result.state).toEqual({ locations: 0, runs: 0, shells: 0 })
    }),
  ))

test("stable content, parent security, control and bounded stages are rechecked", () =>
  GoalChildFixture.isolated(({ directory }) =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      const setup = yield* GoalChildFixture.prepare(directory)
      const first = yield* GoalChild.admit(db, sessions, setup.admission)
      for (const change of [
        { text: "changed" },
        { agent: "another" },
        { steeringHash: "d".repeat(64) },
        { promptPolicyHash: "e".repeat(64) },
      ]) {
        expect(code(yield* GoalChild.admit(db, sessions, { ...setup.admission, ...change }).pipe(Effect.exit))).toBe(
          "GOAL_CHILD_CONFLICT",
        )
      }
      const structured = {
        ...setup.admission,
        roleKey: "structured.0",
        mode: "structured" as const,
        stage: "research" as const,
      }
      yield* GoalChild.admit(db, sessions, structured)
      for (const stage of ["finalizer.1", "finalizer.2"] as const)
        expect(code(yield* GoalChild.admit(db, sessions, { ...structured, stage }).pipe(Effect.exit))).toBe(
          "GOAL_CHILD_UNAVAILABLE",
        )
      yield* sessions.setPermissions({ sessionID: setup.parent.id, permissions: [] })
      expect(code(yield* GoalChild.admit(db, sessions, setup.admission).pipe(Effect.exit))).toBe("GOAL_CHILD_CONFLICT")
      yield* sessions.setPermissions({ sessionID: setup.parent.id, permissions: setup.parent.permissions })
      yield* GoalControl.control(db, {
        sessionID: setup.parent.id,
        goalId: setup.goal.goal_id,
        expectedRevision: 1,
        requestID: "pause",
        action: "pause",
      })
      expect(code(yield* GoalChild.admit(db, sessions, setup.admission).pipe(Effect.exit))).toBe("GOAL_CHILD_CONFLICT")
      expect(
        yield* db.all(sql`SELECT id FROM session_input WHERE session_id=${first.unit.child_session_id}`),
      ).toHaveLength(1)
    }),
  ))

test("concurrent exact admission converges on the same native child and inbox", () =>
  GoalChildFixture.isolated(({ directory }) =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      const setup = yield* GoalChildFixture.prepare(directory)
      const admitted = yield* Effect.all(
        [GoalChild.admit(db, sessions, setup.admission), GoalChild.admit(db, sessions, setup.admission)],
        { concurrency: 2 },
      )
      expect(admitted[0].admitted.id).toBe(admitted[1].admitted.id)
      expect(admitted[0].unit.creation_receipt).toEqual(admitted[1].unit.creation_receipt)
      expect(yield* db.all("SELECT id FROM session WHERE parent_id IS NOT NULL")).toHaveLength(1)
      expect(yield* db.all("SELECT id FROM session_input")).toHaveLength(1)
    }),
  ))

test("pause between native creation and prompt blocks the pending input transaction", () =>
  GoalChildFixture.isolated(({ directory }) =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      const setup = yield* GoalChildFixture.prepare(directory)
      const boundary = {
        ...sessions,
        create: (input: Parameters<SessionV2.Interface["create"]>[0]) =>
          Effect.gen(function* () {
            const child = yield* sessions.create(input)
            yield* GoalControl.control(db, {
              sessionID: setup.parent.id,
              goalId: setup.goal.goal_id,
              expectedRevision: 1,
              requestID: "between-create-and-input",
              action: "pause",
            }).pipe(Effect.orDie)
            return child
          }),
      }
      expect(code(yield* GoalChild.admit(db, boundary, setup.admission).pipe(Effect.exit))).toBe("GOAL_CHILD_CONFLICT")
      expect(yield* db.all("SELECT id FROM session_input")).toEqual([])
      expect(yield* db.all("SELECT id FROM session WHERE parent_id IS NOT NULL")).toHaveLength(1)
    }),
  ))

test("creation and input receipts share actual event rollback and exact retry repairs only its receipt", () =>
  GoalChildFixture.isolated(({ directory }) =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      const setup = yield* GoalChildFixture.prepare(directory)
      yield* db.run(
        "CREATE TRIGGER refuse_goal_creation BEFORE UPDATE OF creation_receipt ON goal_child_unit BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END",
      )
      expect(code(yield* GoalChild.admit(db, sessions, setup.admission).pipe(Effect.exit))).toBe(
        "GOAL_CHILD_UNAVAILABLE",
      )
      expect(yield* db.all("SELECT id FROM session WHERE parent_id IS NOT NULL")).toEqual([])
      expect(yield* db.all("SELECT id FROM session_input")).toEqual([])
      yield* db.run("DROP TRIGGER refuse_goal_creation")
      yield* db.run(
        "CREATE TRIGGER refuse_goal_input BEFORE UPDATE OF inputs ON goal_child_unit WHEN NEW.state='admitted' BEGIN SELECT RAISE(ABORT, 'fixture input failure'); END",
      )
      expect(code(yield* GoalChild.admit(db, sessions, setup.admission).pipe(Effect.exit))).toBe(
        "GOAL_CHILD_UNAVAILABLE",
      )
      expect(yield* db.all("SELECT id FROM session_input")).toEqual([])
      expect(yield* db.all("SELECT id FROM session WHERE parent_id IS NOT NULL")).toHaveLength(1)
      yield* db.run("DROP TRIGGER refuse_goal_input")
      const first = yield* GoalChild.admit(db, sessions, setup.admission)
      const before = yield* db.all(sql`SELECT * FROM event WHERE aggregate_id=${first.unit.child_session_id}`)
      yield* db.run(
        sql`UPDATE goal_child_unit SET inputs=json_set(inputs,'$[0].admittedSeq',NULL) WHERE unit_id=${first.unit.unit_id}`,
      )
      const retry = yield* GoalChild.admit(db, sessions, setup.admission)
      expect(retry.admitted.id).toBe(first.admitted.id)
      expect(retry.unit.inputs[0].admittedSeq).toBe(first.admitted.admittedSeq)
      expect(yield* db.all(sql`SELECT * FROM event WHERE aggregate_id=${first.unit.child_session_id}`)).toEqual(before)
    }),
  ))

test("race adoption cannot accept another parent or an unproven preexisting child", () =>
  GoalChildFixture.isolated(({ directory }) =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      const setup = yield* GoalChildFixture.prepare(directory)
      const foreign = yield* sessions.create({ location: setup.parent.location })
      const boundary = {
        ...sessions,
        create: (input: Parameters<SessionV2.Interface["create"]>[0]) =>
          Effect.gen(function* () {
            // A real SQL occupant appears after reservation and before the actual create adoption read.
            yield* db
              .run(
                sql`INSERT INTO session (id,project_id,slug,directory,title,version,v2_authority,parent_id,agent,model,permission,time_created,time_updated)
        VALUES (${input.id},${setup.parent.projectID},'race',${directory},'race','2',1,${foreign.id},'build',${JSON.stringify(input.model)},${JSON.stringify(input.permissions)},1,1)`,
              )
              .pipe(Effect.orDie)
            return yield* sessions.create(input)
          }),
      }
      expect(code(yield* GoalChild.admit(db, boundary, setup.admission).pipe(Effect.exit))).toBe("GOAL_CHILD_CONFLICT")
      expect(yield* db.all("SELECT id FROM session_input")).toEqual([])
      yield* db.run(sql`UPDATE session SET parent_id=${setup.parent.id} WHERE slug='race'`)
      expect(code(yield* GoalChild.admit(db, sessions, setup.admission).pipe(Effect.exit))).toBe(
        "GOAL_CHILD_RECOVERY_REQUIRED",
      )
    }),
  ))

test("adoption compares model variant, agent, permissions and placement against reserved identity", () =>
  GoalChildFixture.isolated(({ directory }) =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      const setup = yield* GoalChildFixture.prepare(directory)
      for (const mismatch of ["model", "agent", "permissions", "directory", "workspace"] as const) {
        const boundary = {
          ...sessions,
          create: (input: Parameters<SessionV2.Interface["create"]>[0]) =>
            Effect.gen(function* () {
              yield* db
                .run(
                  sql`INSERT INTO session (id,project_id,slug,directory,workspace_id,title,version,v2_authority,parent_id,agent,model,permission,time_created,time_updated)
        VALUES (${input.id},${setup.parent.projectID},${mismatch},${mismatch === "directory" ? directory + "/other" : directory},${mismatch === "workspace" ? "wrk_foreign" : null},'race','2',1,${setup.parent.id},${mismatch === "agent" ? "another" : "build"},${JSON.stringify(mismatch === "model" ? { ...input.model, variant: "other" } : input.model)},${JSON.stringify(mismatch === "permissions" ? [] : input.permissions)},1,1)`,
                )
                .pipe(Effect.orDie)
              return yield* sessions.create(input)
            }),
        }
        expect(
          code(yield* GoalChild.admit(db, boundary, { ...setup.admission, roleKey: mismatch }).pipe(Effect.exit)),
        ).toBe("GOAL_CHILD_CONFLICT")
      }
      expect(yield* db.all("SELECT id FROM session_input")).toEqual([])
    }),
  ))

test("reserved IDs, actual descendants and corrupted binding fail closed without metadata authority", () =>
  GoalChildFixture.isolated(({ directory }) =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      const setup = yield* GoalChildFixture.prepare(directory)
      const first = yield* GoalChild.admit(db, sessions, setup.admission)
      const descendant = yield* sessions.create({
        location: setup.parent.location,
        metadata: { internal: true, goalID: "untrusted" },
      })
      yield* db.run(sql`UPDATE session SET parent_id=${first.unit.child_session_id} WHERE id=${descendant.id}`)
      expect(code(yield* sessions.update({ sessionID: descendant.id, title: "must refuse" }).pipe(Effect.exit))).toBe(
        "GOAL_CHILD_MANAGED",
      )
      expect(code(yield* (yield* SessionStore.Service).requireExecution(descendant.id).pipe(Effect.exit))).toBe(
        "GOAL_CHILD_RECOVERY_REQUIRED",
      )
      expect((yield* GoalControl.requireOrdinary(db, descendant.id).pipe(Effect.flip)).code).toBe("unsupported")
      yield* db.run(
        sql`UPDATE goal_child_unit SET binding=json_set(binding,'$.model.variant','changed') WHERE unit_id=${first.unit.unit_id}`,
      )
      expect(
        code(
          yield* sessions
            .update({ sessionID: SessionSchema.ID.make(first.unit.child_session_id), title: "must refuse" })
            .pipe(Effect.exit),
        ),
      ).toBe("GOAL_CHILD_RECOVERY_REQUIRED")
    }),
  ))

test("a reserved child identity is fenced even before atomic receipts exist", () =>
  GoalChildFixture.isolated(({ directory }) =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      const setup = yield* GoalChildFixture.prepare(directory)
      yield* GoalChild.admit(db, sessions, setup.admission).pipe(Effect.exit)
      const rows = yield* db.all<{ child_session_id: string }>("SELECT child_session_id FROM goal_child_unit")
      expect(rows).toHaveLength(1)
      const sessionID = SessionSchema.ID.make(rows[0].child_session_id)
      expect(code(yield* (yield* SessionStore.Service).requireExecution(sessionID).pipe(Effect.exit))).toBe(
        "GOAL_CHILD_RECOVERY_REQUIRED",
      )
      expect(code(yield* sessions.update({ sessionID, title: "public overwrite" }).pipe(Effect.exit))).toBe(
        "GOAL_CHILD_MANAGED",
      )
    }),
  ))

test("managed public operations and actual local execution stay closed before Location and claims", () =>
  GoalChildFixture.isolated(({ directory, state }) =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      const setup = yield* GoalChildFixture.prepare(directory)
      const child = yield* GoalChild.admit(db, sessions, setup.admission)
      const sessionID = SessionSchema.ID.make(child.unit.child_session_id)
      const before = yield* db.all(sql`SELECT * FROM event WHERE aggregate_id=${sessionID}`)
      const operations: Effect.Effect<unknown, unknown>[] = [
        sessions.prompt({ sessionID, prompt: new Prompt({ text: "unauthorized" }), resume: false }),
        sessions.prompt({
          sessionID,
          id: SessionMessage.ID.make(child.unit.inputs[0].inputID),
          prompt: new Prompt({ text: setup.admission.text }),
          delivery: "queue",
          resume: false,
        }),
        sessions.shell({ sessionID, command: "must never execute" }),
        sessions.skill({ sessionID, skill: "anything" }),
        sessions.compact({ sessionID }),
        sessions.update({ sessionID, metadata: { internal: true } }),
        sessions.setPermissions({ sessionID, permissions: [] }),
        sessions.setArchived({ sessionID, archived: true }),
        sessions.switchAgent({ sessionID, agent: "build" }),
        sessions.create({ id: sessionID, location: setup.parent.location }),
        sessions.create({ parentID: sessionID, location: setup.parent.location }),
      ]
      for (const operation of operations) expect(code(yield* operation.pipe(Effect.exit))).toBe("GOAL_CHILD_MANAGED")
      expect(code(yield* (yield* SessionStore.Service).requireExecution(sessionID).pipe(Effect.exit))).toBe(
        "GOAL_CHILD_RECOVERY_REQUIRED",
      )
      expect(code(yield* (yield* SessionExecution.Service).resume(sessionID).pipe(Effect.exit))).toBe(
        "GOAL_CHILD_RECOVERY_REQUIRED",
      )
      expect(yield* (yield* SessionStore.Service).claimToken(sessionID)).toBeUndefined()
      expect(yield* sessions.get(sessionID)).toMatchObject({ parentID: setup.parent.id })
      expect(yield* sessions.messages({ sessionID })).toEqual([])
      expect(yield* db.all(sql`SELECT * FROM event WHERE aggregate_id=${sessionID}`)).toEqual(before)
      expect(state).toEqual({ locations: 0, runs: 0, shells: 0 })
    }),
  ))
