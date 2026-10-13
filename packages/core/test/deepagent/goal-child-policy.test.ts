import { expect, test } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { AgentV2 } from "../../src/agent"
import { State } from "../../src/state"
import { Database } from "../../src/database/database"
import { GoalChild } from "../../src/deepagent/goal-child"
import { GoalChildPolicy } from "../../src/deepagent/goal-child-policy"
import { PermissionV2 } from "../../src/permission"
import { SessionV2 } from "../../src/session"
import { SessionSchema } from "../../src/session/schema"
import { GoalChildC1Fixture } from "../fixture/goal-child-c1"

test("State commit notification observes committed values including scope removal", async () => {
  const observed: number[][] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      const state = State.create({
        initial: () => ({ values: [] as number[] }),
        editor: (draft) => ({ add: (value: number) => draft.values.push(value) }),
        committed: () => {
          observed.push([...state.get().values])
          return undefined
        },
      })
      const scope = yield* Scope.make()
      const update = yield* state.transform().pipe(Scope.provide(scope))
      yield* update((editor) => editor.add(1))
      yield* update((editor) => editor.add(2))
      yield* Scope.close(scope, Exit.void)
    }),
  )
  expect(observed).toEqual([[1], [2], []])
})

test("actual roster snapshots resolve alias, reject copies and expire on update plus scope teardown", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const scope = yield* Scope.make()
      yield* agents.update((editor) => editor.update(AgentV2.defaultID, () => {})).pipe(Scope.provide(scope))
      expect(agents.snapshot).toBeFunction()
      const first = yield* agents.snapshot!("build")
      expect(AgentV2.snapshotView(first)?.info.id.toString()).toBe("auto")
      expect(AgentV2.snapshotView({ ...first })).toBeUndefined()
      const independent = yield* Scope.make()
      yield* agents
        .update((editor) => editor.update(AgentV2.ID.make("build"), () => {}))
        .pipe(Scope.provide(independent))
      expect(AgentV2.snapshotView(first)).toBeUndefined()
      const second = yield* agents.snapshot!("build")
      expect(AgentV2.snapshotView(second)?.info.id.toString()).toBe("build")
      yield* Scope.close(independent, Exit.void)
      expect(AgentV2.snapshotView(second)).toBeUndefined()
      const third = yield* agents.snapshot!("build")
      expect(AgentV2.snapshotView(third)?.info.id.toString()).toBe("auto")
      yield* Scope.close(scope, Exit.void)
      expect(AgentV2.snapshotView(third)).toBeUndefined()
    }).pipe(Effect.provide(AgentV2.layer), Effect.scoped),
  )
})

for (const effect of ["deny", "ask", "allow"] as const) {
  test(`actual V2 evaluator retains parent ${effect} despite child allow`, () =>
    GoalChildC1Fixture.isolated(({ directory }) =>
      Effect.gen(function* () {
        const setup = yield* GoalChildC1Fixture.prepare(directory, {
          parent: [{ action: "read", resource: "*", effect }],
        })
        const db = (yield* Database.Service).db
        const snapshot = yield* GoalChildPolicy.prepare(db, yield* AgentV2.Service, {
          permitID: setup.permit.permit_id,
          roleKey: setup.admission.roleKey,
          agent: "worker",
          mode: "plain",
        })
        const child = yield* GoalChild.admitV2(db, yield* SessionV2.Service, { ...setup.admission, policy: snapshot })
        yield* GoalChildC1Fixture.permissions(
          directory,
          Effect.gen(function* () {
            const permission = yield* PermissionV2.Service
            const result = yield* permission.ask({
              sessionID: SessionSchema.ID.make(child.unit.child_session_id),
              action: "read",
              resources: ["file.ts"],
            })
            expect(result.effect).toBe(effect)
            if (result.effect === "ask") yield* permission.reply({ requestID: result.id, reply: "reject" })
          }),
        )
      }),
    ))
}

test("managed native policy cannot be replaced by a copied DTO", () =>
  GoalChildC1Fixture.isolated(({ directory }) =>
    Effect.gen(function* () {
      const setup = yield* GoalChildC1Fixture.prepare(directory)
      const db = (yield* Database.Service).db
      const proof = yield* GoalChildPolicy.prepare(db, yield* AgentV2.Service, {
        permitID: setup.permit.permit_id,
        roleKey: setup.admission.roleKey,
        agent: "worker",
        mode: "plain",
      })
      expect(GoalChildPolicy.inspect({ ...proof })).toBeUndefined()
      const result = yield* GoalChild.admitV2(db, yield* SessionV2.Service, {
        ...setup.admission,
        policy: { ...proof },
      }).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBeTrue()
    }),
  ))

for (const resource of ["src/public.ts", "src/private.ts", "/external/approved/file.ts", "/external/other/file.ts"]) {
  test(`managed permission keeps ordered narrow rules and exact external scope: ${resource}`, () =>
    GoalChildC1Fixture.isolated(({ directory }) =>
      Effect.gen(function* () {
        const setup = yield* GoalChildC1Fixture.prepare(directory, {
          parent: [
            { action: "read", resource: "*", effect: "deny" },
            { action: "read", resource: "src/*", effect: "allow" },
            { action: "read", resource: "src/private.ts", effect: "deny" },
            { action: "read", resource: "/external/approved/*", effect: "ask" },
          ],
        })
        const db = (yield* Database.Service).db
        const policy = yield* GoalChildPolicy.prepare(db, yield* AgentV2.Service, {
          permitID: setup.permit.permit_id,
          roleKey: setup.role.key,
          agent: "worker",
          mode: "plain",
        })
        const child = yield* GoalChild.admitV2(db, yield* SessionV2.Service, { ...setup.admission, policy })
        yield* GoalChildC1Fixture.permissions(
          directory,
          Effect.gen(function* () {
            const permission = yield* PermissionV2.Service
            const result = yield* permission.ask({
              sessionID: SessionSchema.ID.make(child.unit.child_session_id),
              action: "read",
              resources: [resource],
            })
            expect(result.effect).toBe(
              resource === "src/public.ts" ? "allow" : resource === "/external/approved/file.ts" ? "ask" : "deny",
            )
            if (result.effect === "ask") yield* permission.reply({ requestID: result.id, reply: "reject" })
          }),
        )
      }),
    ))
}

test("parent Session ask is not dropped and plan capability cannot override explicit parent deny", () =>
  GoalChildC1Fixture.isolated(({ directory }) =>
    Effect.gen(function* () {
      const setup = yield* GoalChildC1Fixture.prepare(directory, {
        parentSession: [
          { action: "read", resource: "*", effect: "ask" },
          { action: "plan", resource: "*", effect: "deny" },
        ],
      })
      const db = (yield* Database.Service).db
      const policy = yield* GoalChildPolicy.prepare(db, yield* AgentV2.Service, {
        permitID: setup.permit.permit_id,
        roleKey: setup.role.key,
        agent: "worker",
        mode: "plain",
      })
      const child = yield* GoalChild.admitV2(db, yield* SessionV2.Service, { ...setup.admission, policy })
      yield* GoalChildC1Fixture.permissions(
        directory,
        Effect.gen(function* () {
          const permission = yield* PermissionV2.Service
          const result = yield* permission.ask({
            sessionID: SessionSchema.ID.make(child.unit.child_session_id),
            action: "read",
            resources: ["src/index.ts"],
          })
          expect(result.effect).toBe("ask")
          yield* permission.reply({ requestID: result.id, reply: "reject" })
          for (const resource of ["plan-goal", "*"])
            expect(
              (yield* permission.ask({
                sessionID: SessionSchema.ID.make(child.unit.child_session_id),
                action: "plan",
                resources: [resource],
              })).effect,
            ).toBe("deny")
        }),
      )
    }),
  ))

for (const reply of ["once", "always"] as const) {
  test(`pending ${reply} approval rechecks native roster and persists no allow after revocation`, () =>
    GoalChildC1Fixture.isolated(({ directory }) =>
      Effect.gen(function* () {
        const setup = yield* GoalChildC1Fixture.prepare(directory, {
          parent: [{ action: "read", resource: "*", effect: "ask" }],
        })
        const db = (yield* Database.Service).db
        const agents = yield* AgentV2.Service
        const policy = yield* GoalChildPolicy.prepare(db, agents, {
          permitID: setup.permit.permit_id,
          roleKey: setup.role.key,
          agent: "worker",
          mode: "plain",
        })
        const child = yield* GoalChild.admitV2(db, yield* SessionV2.Service, { ...setup.admission, policy })
        yield* GoalChildC1Fixture.permissions(
          directory,
          Effect.gen(function* () {
            const permission = yield* PermissionV2.Service
            const result = yield* permission.ask({
              sessionID: SessionSchema.ID.make(child.unit.child_session_id),
              action: "read",
              resources: ["src/index.ts"],
              save: ["src/*"],
            })
            expect(result.effect).toBe("ask")
            yield* agents.update((editor) =>
              editor.update(AgentV2.defaultID, (agent) => {
                agent.permissions = [{ action: "read", resource: "*", effect: "deny" }]
              }),
            )
            expect(
              Exit.isFailure(yield* permission.reply({ requestID: result.id, reply }).pipe(Effect.exit)),
            ).toBeTrue()
            expect(yield* db.all("SELECT * FROM permission")).toHaveLength(0)
            expect(yield* db.all("SELECT * FROM session_v2_provider_turn_receipt")).toHaveLength(0)
          }),
        )
      }),
    ))
}

test("always approval for an ordinary request cannot release a managed request with changed parent authority", () =>
  GoalChildC1Fixture.isolated(({ directory }) =>
    Effect.gen(function* () {
      const setup = yield* GoalChildC1Fixture.prepare(directory, {
        parent: [{ action: "read", resource: "*", effect: "ask" }],
      })
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      const policy = yield* GoalChildPolicy.prepare(db, yield* AgentV2.Service, {
        permitID: setup.permit.permit_id,
        roleKey: setup.role.key,
        agent: "worker",
        mode: "plain",
      })
      const child = yield* GoalChild.admitV2(db, sessions, { ...setup.admission, policy })
      yield* GoalChildC1Fixture.permissions(
        directory,
        Effect.gen(function* () {
          const permission = yield* PermissionV2.Service
          const ordinary = yield* permission.ask({
            sessionID: setup.parent.id,
            action: "read",
            resources: ["src/ordinary.ts"],
            save: ["src/*"],
          })
          const managed = yield* permission.ask({
            sessionID: SessionSchema.ID.make(child.unit.child_session_id),
            action: "read",
            resources: ["src/managed.ts"],
            save: ["src/*"],
          })
          expect([ordinary.effect, managed.effect]).toEqual(["ask", "ask"])
          yield* sessions.setPermissions({
            sessionID: setup.parent.id,
            permissions: [{ action: "read", resource: "src/managed.ts", effect: "deny" }],
          })
          yield* permission.reply({ requestID: ordinary.id, reply: "always" })
          expect((yield* permission.list()).some((item) => item.id === managed.id)).toBeTrue()
          yield* permission.reply({ requestID: managed.id, reply: "reject" })
        }),
      )
    }),
  ))

test("native snapshot also detects out-of-band mutable request content without inventing a commit generation", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      yield* agents.update((editor) => editor.update(AgentV2.defaultID, () => {}))
      const token = yield* agents.snapshot!()
      const generation = AgentV2.snapshotView(token)!.generation
      const actual = (yield* agents.get(AgentV2.defaultID))!
      Object.assign(actual.request.headers, { "x-fixture": "changed" })
      expect(AgentV2.snapshotView(token)).toBeUndefined()
      expect(AgentV2.snapshotView(yield* agents.snapshot!())?.generation).toBe(generation)
    }).pipe(Effect.provide(AgentV2.layer), Effect.scoped),
  )
})

test("native snapshot re-resolves the actual default selector after out-of-band fallback changes", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      yield* agents.update((editor) => {
        editor.update(AgentV2.defaultID, () => {})
        editor.update(AgentV2.ID.make("preferred"), (agent) => {
          agent.hidden = true
        })
        editor.default(AgentV2.ID.make("preferred"))
      })
      const token = yield* agents.snapshot!()
      const observed = AgentV2.snapshotView(token)!
      expect(observed.info.id.toString()).toBe("auto")
      Object.assign((yield* agents.get(AgentV2.ID.make("preferred")))!, { hidden: false })
      expect((yield* agents.select()).id.toString()).toBe("preferred")
      expect(AgentV2.snapshotView(token)).toBeUndefined()
      expect(AgentV2.snapshotView(yield* agents.snapshot!())?.generation).toBe(observed.generation)
    }).pipe(Effect.provide(AgentV2.layer), Effect.scoped),
  )
})
