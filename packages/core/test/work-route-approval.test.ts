import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { sql } from "drizzle-orm"
import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { Database } from "../src/database/database"
import { LocalOperator } from "../src/im/local-operator"
import { WorkRouteApproval } from "../src/session/work-route-approval"
import { WorkCountAcquisition } from "../src/session/work-count-acquisition"
import { WorkAuthorityFixture } from "./fixture/work-authority"
import { WorkRouteApprovalFixture } from "./fixture/work-route-approval"

function code<A, E>(exit: Exit.Exit<A, E>) {
  if (Exit.isSuccess(exit)) return "success"
  const value = Cause.squash(exit.cause)
  return typeof value === "object" && value !== null && "code" in value ? value.code : String(value)
}
async function isolated(
  body: (input: {
    root: string
    proof: ReturnType<typeof WorkRouteApprovalFixture.authority>
    key: Buffer
    run: <A, E>(effect: Effect.Effect<A, E, Database.Service>) => Promise<A>
  }) => Promise<void>,
) {
  const root = await fs.mkdtemp("/tmp/dac-approval-store-")
  const key = randomBytes(32)
  const proof = WorkRouteApprovalFixture.authority(key)
  const run = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          Layer.mergeAll(
            WorkAuthorityFixture.database(path.join(root, "file.sqlite")),
            proof.route,
            proof.count,
            WorkAuthorityFixture.verifier,
          ),
        ),
        Effect.provideService(LocalOperator.Runtime, WorkRouteApprovalFixture.runtime),
        Effect.scoped,
      ),
    )
  try {
    await run(WorkRouteApprovalFixture.initialize)
    await body({ root, key, proof, run })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

test("approval and policy commit atomically; Basic generation is unchanged; cold historical retry cannot reactivate", () =>
  isolated(async ({ run, proof }) => {
    const capture = proof.capture()
    const receipt = await run(WorkRouteApprovalFixture.approve(capture))
    expect(receipt).toMatchObject({ revision: 1, operatorRevision: 2, policyRevision: 2, credentialGeneration: 1 })
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const operator = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
        expect(operator.credential_generation).toBe(1)
        expect(operator.credential_binding).toBe(WorkRouteApprovalFixture.runtime.credentialBinding)
        yield* WorkRouteApproval.revoke(db, {
          approvalID: receipt.approvalID,
          requestID: "revoke",
          expectedRevision: 1,
          expectedOperatorRevision: 2,
          now: 1001,
        }).pipe(Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(operator)))
      }),
    )
    expect(await run(WorkRouteApprovalFixture.approve(capture))).toEqual(receipt)
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        expect((yield* WorkRouteApproval.get(db, receipt.approvalID))?.state).toBe("revoked")
        const operator = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
        expect(operator.revision).toBe(3)
        expect(operator.credential_generation).toBe(1)
      }),
    )
  }))

test("failed MAC/sign and unproven capture roll back policy and route together", () =>
  isolated(async ({ run, proof }) => {
    proof.state.failSign = true
    expect(code(await run(WorkRouteApprovalFixture.approve(proof.capture()).pipe(Effect.exit)))).toBe(
      "ROUTE_PROOF_UNAVAILABLE",
    )
    proof.state.failSign = false
    expect(
      code(await run(WorkRouteApprovalFixture.approve({ ...WorkRouteApprovalFixture.evidence }).pipe(Effect.exit))),
    ).toBe("NATIVE_OBSERVATION_REQUIRED")
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        expect(
          yield* db.all("SELECT revision,credential_generation,policy_revision FROM local_operator_authority"),
        ).toEqual([{ revision: 1, credential_generation: 1, policy_revision: 1 }])
        expect(yield* db.all("SELECT count(*) count FROM work_route_approval")).toEqual([{ count: 0 }])
      }),
    )
  }))

test("actual SQLite rejects NULL/fraction/overflow/UTF8/digest/record bounds; mirrors and MAC are independently checked", () =>
  isolated(async ({ run, proof }) => {
    const receipt = await run(WorkRouteApprovalFixture.approve(proof.capture()))
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        for (const mutation of [
          "approval_id=NULL",
          "revision=1.5",
          "expires_at=9007199254740992",
          "credential_generation=1.5",
          "target_id=''",
          "target_id='" + "中".repeat(200) + "'",
          "record_mac='" + "G".repeat(64) + "'",
          "record=json_object('pad',hex(zeroblob(262144)))",
        ])
          expect(Exit.isFailure(yield* db.run(`UPDATE work_route_approval SET ${mutation}`).pipe(Effect.exit))).toBe(
            true,
          )
        yield* db.run("UPDATE work_route_approval SET revision=2")
        expect(code(yield* WorkRouteApproval.get(db, receipt.approvalID).pipe(Effect.exit))).toBe(
          "ROUTE_INVALID_RECORD",
        )
        yield* db.run("UPDATE work_route_approval SET revision=1,record_mac='" + "0".repeat(64) + "'")
        expect(code(yield* WorkRouteApproval.get(db, receipt.approvalID).pipe(Effect.exit))).toBe(
          "ROUTE_INVALID_RECORD",
        )
      }),
    )
  }))

test("oversized corrupt record is rejected at the SQL byte pre-gate before authentication/materialization", () =>
  isolated(async ({ run, proof }) => {
    const receipt = await run(WorkRouteApprovalFixture.approve(proof.capture()))
    proof.state.reads = 0
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* db.run("PRAGMA ignore_check_constraints=ON")
        yield* db.run("UPDATE work_route_approval SET record=json_object('pad',hex(zeroblob(16777216)))")
        yield* db.run("PRAGMA ignore_check_constraints=OFF")
        {
          const { Database } = yield* Effect.promise(() => import("bun:sqlite"))
          const original = Database.prototype.query
          const statements: string[] = []
          // Observe real native SQLite statements, forwarding every call unchanged.
          Object.defineProperty(Database.prototype, "query", {
            configurable: true,
            writable: true,
            value: function (this: InstanceType<typeof Database>, query: string) {
              statements.push(query)
              return Reflect.apply(original, this, [query])
            },
          })
          const result = yield* WorkRouteApproval.get(db, receipt.approvalID).pipe(
            Effect.exit,
            Effect.ensuring(
              Effect.sync(() =>
                Object.defineProperty(Database.prototype, "query", {
                  configurable: true,
                  writable: true,
                  value: original,
                }),
              ),
            ),
          )
          expect(code(result)).toBe("ROUTE_INVALID_RECORD")
          const reads = statements.filter((statement) => statement.includes("work_route_approval"))
          expect(reads.length).toBe(1)
          expect(reads[0]).toContain("length(CAST(")
          expect(reads[0]).not.toContain('"record_mac"')
        }
        expect(proof.state.reads).toBe(0)
      }),
    )
  }))

test("count single Work slot, owner CAS, exact settled reuse and cold sending unknown never reserve generation", () =>
  isolated(async ({ run, proof }) => {
    await run(WorkRouteApprovalFixture.approve(proof.capture()))
    const binding = await run(WorkRouteApprovalFixture.work)
    const prepare = {
      acquisitionID: "count-one",
      binding,
      ownerToken: "owner-a",
      bootID: "boot-a",
      deadline: 10_000,
      now: 1000,
    }
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const first = yield* WorkCountAcquisition.prepare(db, prepare)
        expect(first.state).toBe("prepared")
        expect(
          code(yield* WorkCountAcquisition.prepare(db, { ...prepare, acquisitionID: "new-id" }).pipe(Effect.exit)),
        ).toBe("COUNT_BINDING_CONFLICT")
        expect(
          code(
            yield* WorkCountAcquisition.prepare(db, { ...prepare, binding: { ...binding, inputID: "new-input" } }).pipe(
              Effect.exit,
            ),
          ),
        ).toBe("COUNT_BINDING_CONFLICT")
        const claimed = yield* WorkCountAcquisition.claimPrepared(db, {
          workID: binding.workID,
          acquisitionID: first.acquisitionID,
          expectedRevision: 1,
          ownerToken: "owner-a",
          bootID: "boot-a",
          nextOwnerToken: "owner-b",
          nextBootID: "boot-b",
          now: 1001,
        })
        expect(claimed.revision).toBe(2)
        expect(
          code(
            yield* WorkCountAcquisition.beginSending(db, {
              workID: binding.workID,
              acquisitionID: first.acquisitionID,
              expectedRevision: 1,
              ownerToken: "owner-a",
              bootID: "boot-a",
              now: 1002,
            }).pipe(Effect.exit),
          ),
        ).toBe("COUNT_OWNER_CONFLICT")
        yield* WorkCountAcquisition.beginSending(db, {
          workID: binding.workID,
          acquisitionID: first.acquisitionID,
          expectedRevision: 2,
          ownerToken: "owner-b",
          bootID: "boot-b",
          now: 1002,
        })
      }),
    )
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        expect((yield* WorkCountAcquisition.get(db, binding.workID))?.state).toBe("sending")
        expect(
          (yield* WorkCountAcquisition.recoverExpired(db, { workID: binding.workID, expectedRevision: 3, now: 10_001 }))
            .state,
        ).toBe("unknown")
        expect(code(yield* WorkCountAcquisition.prepare(db, prepare).pipe(Effect.exit))).toBe("COUNT_UNKNOWN")
        expect(
          code(
            yield* WorkCountAcquisition.settle(db, {
              workID: binding.workID,
              acquisitionID: "count-one",
              expectedRevision: 3,
              ownerToken: "owner-b",
              bootID: "boot-b",
              now: 1003,
              result: { responseHash: "e".repeat(64), inputTokens: 41, countedAt: 1003, expiresAt: 11_000 },
            }).pipe(Effect.exit),
          ),
        ).toBe("COUNT_OWNER_CONFLICT")
        expect(yield* db.all("SELECT count(*) count FROM work_dispatch_reservation")).toEqual([{ count: 0 }])
      }),
    )
  }))

test("settled count reuses only exact preparing receipt; revoked source and changed receipt cannot reuse", () =>
  isolated(async ({ run, proof }) => {
    await run(WorkRouteApprovalFixture.approve(proof.capture()))
    const binding = await run(WorkRouteApprovalFixture.work)
    const prepare = {
      acquisitionID: "count-one",
      binding,
      ownerToken: "owner-a",
      bootID: "boot-a",
      deadline: 10_000,
      now: 1000,
    }
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* WorkCountAcquisition.prepare(db, prepare)
        yield* WorkCountAcquisition.beginSending(db, {
          ...prepare,
          workID: binding.workID,
          expectedRevision: 1,
          now: 1001,
        })
        yield* WorkCountAcquisition.settle(db, {
          ...prepare,
          workID: binding.workID,
          expectedRevision: 2,
          now: 1002,
          result: { responseHash: "e".repeat(64), inputTokens: 41, countedAt: 1002, expiresAt: 11_000 },
        })
        expect((yield* WorkCountAcquisition.prepare(db, { ...prepare, now: 1003 })).state).toBe("settled")
        expect(
          code(
            yield* WorkCountAcquisition.prepare(db, {
              ...prepare,
              binding: { ...binding, providerReceiptID: "new-receipt" },
            }).pipe(Effect.exit),
          ),
        ).toBe("COUNT_BINDING_CONFLICT")
        yield* db.run(sql`UPDATE test_work_source SET enabled=0`)
        expect(code(yield* WorkCountAcquisition.prepare(db, { ...prepare, now: 1003 }).pipe(Effect.exit))).toBe(
          "WORK_REVOKED",
        )
        expect(yield* db.all("SELECT state,revision FROM work_count_acquisition")).toEqual([
          { state: "settled", revision: 3 },
        ])
      }),
    )
  }))

test("count physical constraints, MAC tamper and failed sign leave the durable slot unchanged", () =>
  isolated(async ({ run, proof }) => {
    await run(WorkRouteApprovalFixture.approve(proof.capture()))
    const binding = await run(WorkRouteApprovalFixture.work)
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* WorkCountAcquisition.prepare(db, {
          acquisitionID: "count-one",
          binding,
          ownerToken: "owner-a",
          bootID: "boot-a",
          deadline: 10_000,
          now: 1000,
        })
        for (const mutation of [
          "acquisition_id=NULL",
          "revision=1.5",
          "approval_revision=9007199254740992",
          "deadline=1.5",
          "input_id=''",
          "owner_token='" + "中".repeat(200) + "'",
          "record_hash='" + "z".repeat(64) + "'",
          "record=json_object('pad',hex(zeroblob(32768)))",
        ])
          expect(Exit.isFailure(yield* db.run(`UPDATE work_count_acquisition SET ${mutation}`).pipe(Effect.exit))).toBe(
            true,
          )
        proof.state.failSign = true
        expect(
          code(
            yield* WorkCountAcquisition.beginSending(db, {
              workID: binding.workID,
              acquisitionID: "count-one",
              expectedRevision: 1,
              ownerToken: "owner-a",
              bootID: "boot-a",
              now: 1001,
            }).pipe(Effect.exit),
          ),
        ).toBe("COUNT_UNAVAILABLE")
        proof.state.failSign = false
        expect((yield* WorkCountAcquisition.get(db, binding.workID))?.state).toBe("prepared")
        yield* db.run("UPDATE work_count_acquisition SET record_mac='" + "0".repeat(64) + "'")
        expect(code(yield* WorkCountAcquisition.get(db, binding.workID).pipe(Effect.exit))).toBe("COUNT_INVALID_RECORD")
      }),
    )
  }))

test(
  "SIGKILL after one physical count request leaves sending; reopened store records unknown and sends zero additional requests",
  () =>
    isolated(async ({ root, key, run, proof }) => {
      await run(WorkRouteApprovalFixture.approve(proof.capture()))
      const binding = await run(WorkRouteApprovalFixture.work)
      await run(
        Effect.gen(function* () {
          yield* WorkCountAcquisition.prepare((yield* Database.Service).db, {
            acquisitionID: "count-one",
            binding,
            ownerToken: "owner-a",
            bootID: "boot-a",
            deadline: 10_000,
            now: 1000,
          })
        }),
      )
      const received = Promise.withResolvers<void>()
      const bodies: string[] = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          bodies.push(await request.text())
          received.resolve()
          return new Response("controlled response")
        },
      })
      const keyfile = path.join(root, "fixture-key")
      await fs.writeFile(keyfile, key, { mode: 0o600 })
      const child = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dir, "fixture/work-count-cold.ts"),
          path.join(root, "file.sqlite"),
          keyfile,
          server.url.href,
        ],
        {
          env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const timer = setTimeout(() => received.reject(new Error("child never reached physical request")), 10_000)
      try {
        await received.promise
        child.kill("SIGKILL")
        await child.exited
        expect(bodies).toEqual(["controlled-count-disclosure"])
        await run(
          Effect.gen(function* () {
            const db = (yield* Database.Service).db
            expect((yield* WorkCountAcquisition.get(db, binding.workID))?.state).toBe("sending")
            yield* WorkCountAcquisition.recoverExpired(db, { workID: binding.workID, expectedRevision: 2, now: 10_001 })
            expect(
              code(
                yield* WorkCountAcquisition.prepare(db, {
                  acquisitionID: "count-one",
                  binding,
                  ownerToken: "new-process",
                  bootID: "new-boot",
                  deadline: 20_000,
                  now: 10_001,
                }).pipe(Effect.exit),
              ),
            ).toBe("COUNT_UNKNOWN")
            expect(yield* db.all("SELECT count(*) count FROM work_dispatch_reservation")).toEqual([{ count: 0 }])
          }),
        )
        expect(bodies.length).toBe(1)
      } finally {
        clearTimeout(timer)
        child.kill("SIGKILL")
        await child.exited
        server.stop(true)
      }
    }),
  20_000,
)

test("full-record byte capacity failure rolls back policy even below the 128 command ceiling", () =>
  isolated(async ({ run, proof }) => {
    const capture = proof.capture()
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const original = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
        const policy = {
          ...original.policy,
          targets: [
            ...original.policy.targets,
            ...Array.from({ length: 31 }, (_, index) => ({
              ...original.policy.targets[0],
              id: `${index}-` + "x".repeat(490),
            })),
          ],
        }
        yield* db
          .transaction((tx) => LocalOperator.updatePolicyInTransaction(tx, { expectedRevision: 1, policy, now: 1000 }))
          .pipe(Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(original)))
        for (let index = 0; index < 128; index++) {
          const operator = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
          const result = yield* WorkRouteApproval.approve(db, {
            capture,
            requestID: `approve-${index}`,
            identity: WorkRouteApprovalFixture.commandIdentity("approve", index, index + 2),
            expectedRevision: index,
            expectedOperatorRevision: index + 2,
            now: 1000 + index,
          }).pipe(Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(operator)), Effect.exit)
          if (Exit.isSuccess(result)) continue
          expect(code(result)).toBe("ROUTE_COMMAND_CAPACITY")
          expect(index).toBeLessThan(128)
          const after = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
          expect(after.revision).toBe(operator.revision)
          expect(after.policy_hash).toBe(operator.policy_hash)
          const approvalID = after.policy.targets[0]!.target.provider.evidenceID
          const revoked = yield* WorkRouteApproval.revoke(db, {
            approvalID,
            identity: WorkRouteApprovalFixture.commandIdentity("revoke", index, after.revision),
            requestID: "\0".repeat(512),
            expectedRevision: index,
            expectedOperatorRevision: after.revision,
            now: 2000,
          }).pipe(Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(after)))
          expect(revoked.state).toBe("revoked")
          const final = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
          expect(
            code(
              yield* WorkRouteApproval.approve(db, {
                capture,
                requestID: "after-capacity",
                identity: WorkRouteApprovalFixture.commandIdentity("approve", revoked.revision, final.revision),
                expectedRevision: revoked.revision,
                expectedOperatorRevision: final.revision,
                now: 2001,
              }).pipe(Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(final)), Effect.exit),
            ),
          ).toBe("ROUTE_COMMAND_CAPACITY")
          expect((yield* WorkRouteApproval.get(db, approvalID))?.state).toBe("revoked")
          return
        }
        throw new Error("expected byte capacity refusal")
      }),
    )
  }))

test("concurrent file-backed prepared-owner CAS has one winner; invalid backwards time cannot corrupt the slot", () =>
  isolated(async ({ run, proof }) => {
    await run(WorkRouteApprovalFixture.approve(proof.capture()))
    const binding = await run(WorkRouteApprovalFixture.work)
    await run(
      Effect.gen(function* () {
        yield* WorkCountAcquisition.prepare((yield* Database.Service).db, {
          acquisitionID: "count-one",
          binding,
          ownerToken: "owner-a",
          bootID: "boot-a",
          deadline: 10_000,
          now: 1000,
        })
      }),
    )
    const claims = await Promise.all(
      ["b", "c"].map((id) =>
        run(
          Effect.gen(function* () {
            return yield* WorkCountAcquisition.claimPrepared((yield* Database.Service).db, {
              workID: binding.workID,
              acquisitionID: "count-one",
              expectedRevision: 1,
              ownerToken: "owner-a",
              bootID: "boot-a",
              nextOwnerToken: `owner-${id}`,
              nextBootID: `boot-${id}`,
              now: 1001,
            }).pipe(Effect.exit)
          }),
        ),
      ),
    )
    expect(claims.map(code).sort()).toEqual(["COUNT_OWNER_CONFLICT", "success"])
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const current = yield* WorkCountAcquisition.get(db, binding.workID)
        if (!current) return yield* Effect.die("missing slot")
        const owner = {
          workID: binding.workID,
          acquisitionID: current.acquisitionID,
          expectedRevision: current.revision,
          ownerToken: current.ownerToken,
          bootID: current.bootID,
        }
        expect(code(yield* WorkCountAcquisition.stop(db, { ...owner, now: 999 }).pipe(Effect.exit))).toBe(
          "COUNT_INVALID_RECORD",
        )
        expect(yield* WorkCountAcquisition.get(db, binding.workID)).toEqual(current)
        const sending = yield* WorkCountAcquisition.beginSending(db, { ...owner, now: 1002 })
        expect(
          code(
            yield* WorkCountAcquisition.settle(db, {
              ...owner,
              expectedRevision: sending.revision,
              now: 1001,
              result: { responseHash: "e".repeat(64), inputTokens: 41, countedAt: 1001, expiresAt: 11_000 },
            }).pipe(Effect.exit),
          ),
        ).toBe("COUNT_INVALID_RECORD")
        expect(yield* WorkCountAcquisition.get(db, binding.workID)).toEqual(sending)
      }),
    )
  }))

test("approval rejects untrusted URL; database read failure stays typed unavailable", () =>
  isolated(async ({ run, proof }) => {
    for (const endpoint of [
      "http://api.openai.com/v1/responses",
      "https://name:secret@api.openai.com/v1/responses",
      "https://api.openai.com/v1/responses?key=secret",
    ])
      expect(
        code(
          await run(
            WorkRouteApprovalFixture.approve(proof.capture({ ...WorkRouteApprovalFixture.evidence, endpoint })).pipe(
              Effect.exit,
            ),
          ),
        ),
      ).toBe("ROUTE_PROOF_UNAVAILABLE")
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        expect(yield* db.all("SELECT revision,credential_generation FROM local_operator_authority")).toEqual([
          { revision: 1, credential_generation: 1 },
        ])
        yield* db.run("DROP TABLE work_route_approval")
        expect(code(yield* WorkRouteApproval.get(db, "anything").pipe(Effect.exit))).toBe("ROUTE_PROOF_UNAVAILABLE")
        yield* db.run("DROP TABLE work_count_acquisition")
        expect(code(yield* WorkCountAcquisition.get(db, "anything").pipe(Effect.exit))).toBe("COUNT_UNAVAILABLE")
      }),
    )
  }))

test("missing trusted services cannot read approval proof or prepare a count disclosure", () =>
  isolated(async ({ root, run, proof }) => {
    const approval = await run(WorkRouteApprovalFixture.approve(proof.capture()))
    const binding = await run(WorkRouteApprovalFixture.work)
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        return [
          code(yield* WorkRouteApproval.get(db, approval.approvalID).pipe(Effect.exit)),
          code(
            yield* WorkCountAcquisition.prepare(db, {
              acquisitionID: "count-one",
              binding,
              ownerToken: "owner-a",
              bootID: "boot-a",
              deadline: 10_000,
              now: 1000,
            }).pipe(Effect.exit),
          ),
          yield* db.all("SELECT count(*) count FROM work_count_acquisition"),
        ]
      }).pipe(Effect.provide(WorkAuthorityFixture.database(path.join(root, "file.sqlite"))), Effect.scoped),
    )
    expect(results).toEqual(["ROUTE_PROOF_UNAVAILABLE", "COUNT_UNAVAILABLE", [{ count: 0 }]])
  }))

test("count corrupt oversize JSON is rejected before full row materialization", () =>
  isolated(async ({ run, proof }) => {
    await run(WorkRouteApprovalFixture.approve(proof.capture()))
    const binding = await run(WorkRouteApprovalFixture.work)
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* WorkCountAcquisition.prepare(db, {
          acquisitionID: "count-one",
          binding,
          ownerToken: "owner-a",
          bootID: "boot-a",
          deadline: 10_000,
          now: 1000,
        })
        yield* db.run("PRAGMA ignore_check_constraints=ON")
        yield* db.run("UPDATE work_count_acquisition SET record=json_object('pad',hex(zeroblob(16777216)))")
        yield* db.run("PRAGMA ignore_check_constraints=OFF")
        {
          const { Database } = yield* Effect.promise(() => import("bun:sqlite"))
          const original = Database.prototype.query
          const statements: string[] = []
          Object.defineProperty(Database.prototype, "query", {
            configurable: true,
            writable: true,
            value: function (this: InstanceType<typeof Database>, query: string) {
              statements.push(query)
              return Reflect.apply(original, this, [query])
            },
          })
          const result = yield* WorkCountAcquisition.get(db, binding.workID).pipe(
            Effect.exit,
            Effect.ensuring(
              Effect.sync(() =>
                Object.defineProperty(Database.prototype, "query", {
                  configurable: true,
                  writable: true,
                  value: original,
                }),
              ),
            ),
          )
          expect(code(result)).toBe("COUNT_INVALID_RECORD")
          const reads = statements.filter((statement) => statement.includes("work_count_acquisition"))
          expect(reads.length).toBe(1)
          expect(reads[0]).toContain("length(CAST(")
          expect(reads[0]).not.toContain('"record_mac"')
        }
      }),
    )
  }))

test("approval configured-source mismatch and concurrent operator revision cannot publish another target", () =>
  isolated(async ({ run, proof }) => {
    expect(
      code(
        await run(
          WorkRouteApprovalFixture.approve(
            proof.capture({ ...WorkRouteApprovalFixture.evidence, configuredTargetStamp: "f".repeat(64) }),
          ).pipe(Effect.exit),
        ),
      ),
    ).toBe("ROUTE_BINDING_CONFLICT")
    const results = await Promise.all(
      ["one", "two"].map((requestID) =>
        run(
          Effect.gen(function* () {
            const db = (yield* Database.Service).db
            const operator = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
            return yield* WorkRouteApproval.approve(db, {
              capture: proof.capture(),
              requestID,
              expectedRevision: 0,
              expectedOperatorRevision: 1,
              now: 1000,
            }).pipe(Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(operator)), Effect.exit)
          }),
        ),
      ),
    )
    expect(results.filter(Exit.isSuccess).length).toBe(1)
    expect(results.filter(Exit.isFailure).length).toBe(1)
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        expect(yield* db.all("SELECT revision,credential_generation FROM local_operator_authority")).toEqual([
          { revision: 2, credential_generation: 1 },
        ])
        expect(yield* db.all("SELECT revision FROM work_route_approval")).toEqual([{ revision: 1 }])
      }),
    )
  }))

test("revoke preserves the original configured source for explicit reapproval; backwards clocks roll back policy", () =>
  isolated(async ({ run, proof }) => {
    const capture = proof.capture()
    const initial = await run(WorkRouteApprovalFixture.approve(capture))
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const operator = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
        const input = {
          approvalID: initial.approvalID,
          requestID: "revoke",
          expectedRevision: 1,
          expectedOperatorRevision: 2,
        }
        const revoked = yield* WorkRouteApproval.revoke(db, { ...input, now: 999 }).pipe(
          Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(operator)),
          Effect.exit,
        )
        expect(code(revoked)).toBe("ROUTE_INVALID_RECORD")
        expect((yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))).revision).toBe(2)
        expect((yield* WorkRouteApproval.get(db, initial.approvalID))?.revision).toBe(1)
        yield* WorkRouteApproval.revoke(db, { ...input, now: 1001 }).pipe(
          Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(operator)),
        )
      }),
    )
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const operator = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
        expect(operator.policy.targets[0]?.target.provider.configurationHash).toBe(
          WorkRouteApprovalFixture.evidence.configuredTargetStamp,
        )
        const approved = yield* WorkRouteApproval.approve(db, {
          capture,
          requestID: "new-explicit-approval",
          expectedRevision: 2,
          expectedOperatorRevision: 3,
          now: 1002,
        }).pipe(Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(operator)))
        expect(approved).toMatchObject({ state: "active", revision: 3, credentialGeneration: 2, operatorRevision: 4 })
        expect((yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))).credential_generation).toBe(1)
      }),
    )
  }))

test("the final bounded command slot remains available for revocation and never permits resetting identity", () =>
  isolated(async ({ run, proof }) => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        for (let revision = 0; revision < 127; revision++) {
          const operator = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
          yield* WorkRouteApproval.approve(db, {
            capture: proof.capture(),
            requestID: `approve-${revision}`,
            identity: WorkRouteApprovalFixture.commandIdentity("approve", revision, operator.revision),
            expectedRevision: revision,
            expectedOperatorRevision: operator.revision,
            now: 1000 + revision,
          }).pipe(Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(operator)))
        }
        const operator = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
        const approved = operator.policy.targets[0]!.target.provider.evidenceID
        expect(
          code(
            yield* WorkRouteApproval.approve(db, {
              capture: proof.capture(),
              requestID: "beyond-capacity",
              identity: WorkRouteApprovalFixture.commandIdentity("approve", 127, operator.revision),
              expectedRevision: 127,
              expectedOperatorRevision: operator.revision,
              now: 1200,
            }).pipe(
              Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(operator)),
              Effect.exit,
            ),
          ),
        ).toBe("ROUTE_COMMAND_CAPACITY")
        const revoked = yield* WorkRouteApproval.revoke(db, {
          approvalID: approved,
          requestID: "reserved-revocation",
          identity: WorkRouteApprovalFixture.commandIdentity("revoke", 127, operator.revision),
          expectedRevision: 127,
          expectedOperatorRevision: operator.revision,
          now: 1200,
        }).pipe(Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(operator)))
        expect(revoked).toMatchObject({ state: "revoked", revision: 128 })
        const final = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
        expect(
          code(
            yield* WorkRouteApproval.approve(db, {
              capture: proof.capture(),
              requestID: "cannot-reset",
              identity: WorkRouteApprovalFixture.commandIdentity("approve", 128, final.revision),
              expectedRevision: 128,
              expectedOperatorRevision: final.revision,
              now: 1201,
            }).pipe(Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(final)), Effect.exit),
          ),
        ).toBe("ROUTE_COMMAND_CAPACITY")
        expect((yield* WorkRouteApproval.get(db, approved))?.state).toBe("revoked")
      }),
    )
  }))

test("identified command retries precede expiry/live capture and never reactivate a revoked record", () =>
  isolated(async ({ run, proof }) => {
    const identity = {
      version: 1 as const,
      instanceID: WorkRouteApprovalFixture.evidence.instanceID,
      operatorID: WorkRouteApprovalFixture.evidence.operatorID,
      targetID: "review",
      action: "approve" as const,
      snapshot: WorkRouteApprovalFixture.evidence.modelID,
      expiresAt: WorkRouteApprovalFixture.evidence.expiresAt,
      expectedRevision: 0,
      expectedOperatorRevision: 1,
    }
    const approve = (now: number, value = identity, capture = proof.capture()) =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const operator = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
        return yield* WorkRouteApproval.approve(db, {
          capture,
          identity: value,
          requestID: "identified",
          expectedRevision: value.expectedRevision,
          expectedOperatorRevision: value.expectedOperatorRevision,
          now,
        }).pipe(Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(operator)))
      })
    const original = await run(approve(1000))
    proof.state.denyCapture = true
    const reads = proof.state.captured
    for (const now of [99999, 100000, 100001]) expect(await run(approve(now, identity, {}))).toEqual(original)
    expect(proof.state.captured).toBe(reads)
    for (const changed of [
      { ...identity, snapshot: "different" },
      { ...identity, expiresAt: identity.expiresAt + 1 },
      { ...identity, expectedRevision: 1 },
      { ...identity, expectedOperatorRevision: 2 },
    ])
      expect(code(await run(approve(100001, changed, {}).pipe(Effect.exit)))).toBe("ROUTE_BINDING_CONFLICT")
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const operator = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
        const mutation = LocalOperator.mutationWitness(operator)
        const revoked = yield* WorkRouteApproval.revoke(db, {
          approvalID: original.approvalID,
          requestID: "revoke-identified",
          expectedRevision: 1,
          expectedOperatorRevision: 2,
          now: 1001,
          identity: {
            ...identity,
            action: "revoke",
            snapshot: null,
            expiresAt: null,
            expectedRevision: 1,
            expectedOperatorRevision: 2,
          },
        }).pipe(Effect.provideService(LocalOperator.Mutation, mutation))
        expect(revoked.state).toBe("revoked")
      }),
    )
    const before = await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        return {
          route: yield* db.all("SELECT * FROM work_route_approval"),
          operator: yield* db.all("SELECT * FROM local_operator_authority"),
        }
      }),
    )
    expect(await run(approve(100001, identity, {}))).toEqual(original)
    expect(proof.state.captured).toBe(reads)
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const operator = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
        const view = yield* WorkRouteApproval.history(db, { targetID: "review", requestID: "identified" }).pipe(
          Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(operator)),
        )
        expect(view).toMatchObject({
          commandReceipt: original,
          currentRecord: { state: "revoked", revision: 2 },
          identityAvailability: "available",
          authorization: "not_checked",
        })
        expect({
          route: yield* db.all("SELECT * FROM work_route_approval"),
          operator: yield* db.all("SELECT * FROM local_operator_authority"),
        }).toEqual(before)
        expect(operator.credential_generation).toBe(1)
      }),
    )
    proof.state.denyCapture = false
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const operator = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
        const mutation = LocalOperator.mutationWitness(operator)
        const next = { ...identity, expectedRevision: 2, expectedOperatorRevision: operator.revision }
        expect(
          code(
            yield* WorkRouteApproval.approve(db, {
              capture: proof.capture(),
              identity: next,
              requestID: "expired-new-command",
              expectedRevision: 2,
              expectedOperatorRevision: operator.revision,
              now: 100001,
            }).pipe(Effect.provideService(LocalOperator.Mutation, mutation), Effect.exit),
          ),
        ).toBe("ROUTE_PROOF_UNAVAILABLE")
        expect(
          code(
            yield* WorkRouteApproval.approve(db, {
              capture: {},
              identity: next,
              requestID: "unproven-new-command",
              expectedRevision: 2,
              expectedOperatorRevision: operator.revision,
              now: 1002,
            }).pipe(Effect.provideService(LocalOperator.Mutation, mutation), Effect.exit),
          ),
        ).toBe("NATIVE_OBSERVATION_REQUIRED")
        expect({
          route: yield* db.all("SELECT * FROM work_route_approval"),
          operator: yield* db.all("SELECT * FROM local_operator_authority"),
        }).toEqual(before)
      }),
    )
  }))

test("legacy commands retain original bytes and MAC, remain readable, and never acquire guessed identity", () =>
  isolated(async ({ run, proof }) => {
    const capture = proof.capture()
    const legacy = await run(WorkRouteApprovalFixture.approve(capture))
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const operator = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
        const mutation = LocalOperator.mutationWitness(operator)
        const identity = {
          version: 1 as const,
          instanceID: operator.instance_id,
          operatorID: operator.operator_id,
          targetID: "review",
          action: "approve" as const,
          snapshot: WorkRouteApprovalFixture.evidence.modelID,
          expiresAt: WorkRouteApprovalFixture.evidence.expiresAt,
          expectedRevision: 0,
          expectedOperatorRevision: 1,
        }
        const before = yield* db.all("SELECT * FROM work_route_approval")
        expect(
          code(
            yield* WorkRouteApproval.reconcile(db, { requestID: "approve", identity }).pipe(
              Effect.provideService(LocalOperator.Mutation, mutation),
              Effect.exit,
            ),
          ),
        ).toBe("ROUTE_COMMAND_IDENTITY_UNAVAILABLE")
        const view = yield* WorkRouteApproval.history(db, { targetID: "review", requestID: "approve" }).pipe(
          Effect.provideService(LocalOperator.Mutation, mutation),
        )
        expect(view).toMatchObject({
          commandReceipt: legacy,
          commandIdentity: null,
          identityAvailability: "legacy_unavailable",
        })
        expect(yield* db.all("SELECT * FROM work_route_approval")).toEqual(before)
        const original = yield* WorkRouteApproval.get(db, legacy.approvalID)
        const revoked = yield* WorkRouteApproval.revoke(db, {
          approvalID: legacy.approvalID,
          requestID: "new-revoke",
          expectedRevision: 1,
          expectedOperatorRevision: 2,
          now: 1001,
          identity: {
            ...identity,
            action: "revoke",
            snapshot: null,
            expiresAt: null,
            expectedRevision: 1,
            expectedOperatorRevision: 2,
          },
        }).pipe(Effect.provideService(LocalOperator.Mutation, mutation))
        const current = yield* WorkRouteApproval.get(db, legacy.approvalID)
        expect(current?.version).toBe(2)
        expect(current?.commands[0]).toEqual(original?.commands[0])
        expect(current?.commands[1]).toMatchObject({ identity: { action: "revoke" }, receipt: revoked })
        // A versioned command stripped down to legacy remains explicitly unavailable, never exact.
        const next = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
        expect(
          code(
            yield* WorkRouteApproval.reconcile(db, { requestID: "approve", identity }).pipe(
              Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(next)),
              Effect.exit,
            ),
          ),
        ).toBe("ROUTE_COMMAND_IDENTITY_UNAVAILABLE")
        yield* db.run("UPDATE work_route_approval SET record_mac='" + "0".repeat(64) + "'")
        expect(
          code(
            yield* WorkRouteApproval.reconcile(db, {
              requestID: "new-revoke",
              identity: {
                ...identity,
                action: "revoke",
                snapshot: null,
                expiresAt: null,
                expectedRevision: 1,
                expectedOperatorRevision: 2,
              },
            }).pipe(Effect.provideService(LocalOperator.Mutation, LocalOperator.mutationWitness(next)), Effect.exit),
          ),
        ).toBe("ROUTE_INVALID_RECORD")
      }),
    )
  }))
