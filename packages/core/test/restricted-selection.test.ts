import { expect, test } from "bun:test"
import { Cause, Context, Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { SessionContext } from "../src/context-federation/session-context"
import { SessionSchema } from "../src/session/schema"
import { SessionRunnerCanonical } from "../src/session/runner/canonical-turn"
import { WorkAuthority } from "../src/session/work-authority"
import { WorkAuthorityPolicy } from "../src/session/work-authority-policy"
import { WorkAuthoritySchema } from "../src/session/work-authority.schema"
import { CanonicalJson } from "../src/util/canonical-json"
import { Hash } from "../src/util/hash"
import { RestrictedSelectionFixture } from "./fixture/restricted-selection"
import { WorkAuthorityFixture } from "./fixture/work-authority"

function code<A, E>(exit: Exit.Exit<A, E>) {
  if (Exit.isSuccess(exit)) return "success"
  const error = Cause.squash(exit.cause)
  return error instanceof WorkAuthoritySchema.Error ? error.code : Cause.pretty(exit.cause)
}

test("restricted selection without durable Work refuses before any Context activity", () =>
  RestrictedSelectionFixture.isolated((fixture) =>
    Effect.gen(function* () {
      const before = yield* RestrictedSelectionFixture.facts
      expect(code(yield* RestrictedSelectionFixture.select(fixture).pipe(Effect.exit))).toBe("WORK_AUTHORITY_MISSING")
      expect(yield* RestrictedSelectionFixture.facts).toEqual(before)
      expect(fixture.state).toEqual({ sources: 0, filesystem: 0 })
    }),
  ))

test("unpromoted input cannot be turned into a Context selection by the seam", () =>
  RestrictedSelectionFixture.isolated((fixture) =>
    Effect.gen(function* () {
      yield* RestrictedSelectionFixture.admit(fixture, false)
      const before = yield* RestrictedSelectionFixture.facts
      expect(code(yield* RestrictedSelectionFixture.select(fixture).pipe(Effect.exit))).toBe("WORK_BINDING_CONFLICT")
      expect(yield* RestrictedSelectionFixture.facts).toEqual(before)
      expect(fixture.state).toEqual({ sources: 0, filesystem: 0 })
    }),
  ))

test("actual admitted/promoted text writes one registered-scope selection through the canonical writer", () =>
  RestrictedSelectionFixture.isolated((fixture) =>
    Effect.gen(function* () {
      yield* RestrictedSelectionFixture.admit(fixture)
      const result = yield* RestrictedSelectionFixture.select(fixture)
      const next = yield* RestrictedSelectionFixture.select(fixture)
      expect(next.admission.selectionId).toBe(result.admission.selectionId)
      expect(next.admission.activityId).toBe(result.admission.activityId)
      expect(next.admission.nextRevalidationAt).toBe(result.admission.nextRevalidationAt)
      expect(result).toMatchObject({
        inputID: fixture.binding.inputID,
        workID: fixture.binding.workID,
        controlRevision: 1,
        auditedText: WorkAuthorityFixture.TEXT,
        instructions: WorkAuthorityPolicy.TEXT_ONLY_PROFILE.instructions,
        profileHash: WorkAuthorityPolicy.TEXT_ONLY_PROFILE_HASH,
      })
      expect(result.admission).toMatchObject({ readiness: "unavailable", selectedRefs: [] })
      const db = (yield* Database.Service).db
      const rows = yield* db.all<{
        selection_id: string
        location_key: string
        security_namespace_id: string
        project_scope_key: string
        trigger_input_id: string
        graph_statuses: string
        selected_refs: string
        query_fingerprint: string
        projection_hash: string
        token_count: number
      }>("SELECT * FROM session_context_selection")
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        selection_id: result.admission.selectionId,
        location_key: fixture.identity.locationKey,
        security_namespace_id: fixture.identity.securityNamespaceId,
        project_scope_key: fixture.identity.projectScopeKey,
        trigger_input_id: fixture.binding.inputID,
        selected_refs: "[]",
        projection_hash: result.admission.projectionHash,
        token_count: 0,
      })
      expect(rows[0]!.query_fingerprint).toBe(
        Hash.sha256(
          CanonicalJson.stringify({
            profileHash: fixture.binding.profile.hash,
            instructions: WorkAuthorityPolicy.TEXT_ONLY_PROFILE.instructions,
            inputID: fixture.binding.inputID,
            text: WorkAuthorityFixture.TEXT,
          }),
        ),
      )
      expect(Object.values(JSON.parse(rows[0]!.graph_statuses))).toEqual(
        ["code", "documents", "knowledge", "memory"].map((graph) => ({
          graph,
          status: "denied",
          revision: fixture.binding.profile.hash,
          adapterVersion: "work-text-only-selection.v1",
          observedMutationEpoch: 0,
          latencyMs: 0,
          candidateCount: 0,
          rejectedCount: 0,
          reasonCode: "agent_policy_denied",
        })),
      )
      const facts = yield* RestrictedSelectionFixture.facts
      expect(facts.find((value) => value.table === "session_activity")?.rows).toHaveLength(1)
      expect(facts.find((value) => value.table === "session_activity_input")?.rows).toHaveLength(1)
      expect(facts.find((value) => value.table === "session_context_epoch")?.rows).toHaveLength(0)
      expect(facts.find((value) => value.table === "session_provider_attempt")?.rows).toHaveLength(0)
      expect(fixture.state).toEqual({ sources: 0, filesystem: 0 })
    }),
  ))

test.each([
  { table: "test_work_source", expected: "WORK_REVOKED" },
  { table: "test_work_route", expected: "PROFILE_UNAVAILABLE" },
])("revoked $table authority leaves activity/selection/epoch entirely unchanged", ({ table, expected }) =>
  RestrictedSelectionFixture.isolated((fixture) =>
    Effect.gen(function* () {
      yield* RestrictedSelectionFixture.admit(fixture)
      const db = (yield* Database.Service).db
      yield* db.run(sql.raw(`UPDATE ${table} SET enabled=0`))
      const before = yield* RestrictedSelectionFixture.facts
      expect(code(yield* RestrictedSelectionFixture.select(fixture).pipe(Effect.exit))).toBe(expected)
      expect(yield* RestrictedSelectionFixture.facts).toEqual(before)
      expect(before.every((entry) => entry.rows.length === 0)).toBe(true)
      expect(fixture.state).toEqual({ sources: 0, filesystem: 0 })
    }),
  ),
)

test("missing trusted verifier is unavailable even when Work and registry rows already exist", () =>
  RestrictedSelectionFixture.isolated((fixture) =>
    Effect.gen(function* () {
      yield* RestrictedSelectionFixture.admit(fixture)
      const before = yield* RestrictedSelectionFixture.facts
      const exit = yield* RestrictedSelectionFixture.select(fixture).pipe(
        Effect.updateContext((context: Context.Context<RestrictedSelectionFixture.Services>) =>
          Context.omit(WorkAuthority.Verifier)(context),
        ),
        Effect.exit,
      )
      expect(code(exit)).toBe("PROFILE_UNAVAILABLE")
      expect(yield* RestrictedSelectionFixture.facts).toEqual(before)
      expect(fixture.state).toEqual({ sources: 0, filesystem: 0 })
    }),
  ))

test.each([
  { name: "retired namespace", statement: "UPDATE context_security_namespace SET retired_at=1" },
  { name: "retired project", statement: "UPDATE context_project_scope_identity SET retired_at=1" },
  { name: "unregistered Location", statement: "DELETE FROM context_location_identity" },
  { name: "moved canonical root", statement: "UPDATE context_location_identity SET canonical_root='/unapproved'" },
  {
    name: "changed projected text",
    statement: "UPDATE session_message SET data=json_set(data,'$.text','not audited')",
  },
  {
    name: "changed durable input",
    statement: "UPDATE session_input SET prompt=json_set(prompt,'$.text','not audited')",
  },
  {
    name: "attached file",
    statement:
      'UPDATE session_input SET prompt=json_set(prompt,\'$.files\',json(\'[{"uri":"file:///secret","mime":"text/plain"}]\'))',
  },
  { name: "Session metadata", statement: "UPDATE session SET metadata='{}'" },
  {
    name: "Session permission override",
    statement: 'UPDATE session SET permission=\'[{"action":"*","resource":"*","effect":"allow"}]\'',
  },
])("$name cannot authorize restricted Context or create fallback identities", ({ statement }) =>
  RestrictedSelectionFixture.isolated((fixture) =>
    Effect.gen(function* () {
      yield* RestrictedSelectionFixture.admit(fixture)
      const db = (yield* Database.Service).db
      yield* db.run(statement)
      const before = yield* RestrictedSelectionFixture.facts
      const registry = yield* db.all<Record<string, unknown>>("SELECT * FROM context_location_identity")
      expect(code(yield* RestrictedSelectionFixture.select(fixture).pipe(Effect.exit))).toBe("WORK_BINDING_CONFLICT")
      expect(yield* RestrictedSelectionFixture.facts).toEqual(before)
      expect(yield* db.all<Record<string, unknown>>("SELECT * FROM context_location_identity")).toEqual(registry)
      expect(fixture.state).toEqual({ sources: 0, filesystem: 0 })
    }),
  ),
)

test("nested current checks, activity and selection writer share the caller's actual SQLite transaction", () =>
  RestrictedSelectionFixture.isolated((fixture) =>
    Effect.gen(function* () {
      yield* RestrictedSelectionFixture.admit(fixture)
      const db = (yield* Database.Service).db
      const before = yield* RestrictedSelectionFixture.facts
      const blocked = yield* db
        .transaction(
          () =>
            Effect.gen(function* () {
              yield* db.run("UPDATE test_work_source SET enabled=0")
              expect(code(yield* RestrictedSelectionFixture.select(fixture).pipe(Effect.exit))).toBe("WORK_REVOKED")
              expect(yield* RestrictedSelectionFixture.facts).toEqual(before)
              return yield* Effect.fail("rollback_source_revoke")
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(blocked)).toBe(true)
      const exit = yield* db
        .transaction(
          () =>
            Effect.gen(function* () {
              yield* RestrictedSelectionFixture.select(fixture)
              expect(
                (yield* RestrictedSelectionFixture.facts).find((entry) => entry.table === "session_context_selection")
                  ?.rows,
              ).toHaveLength(1)
              return yield* Effect.fail("rollback_after_actual_selection")
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* RestrictedSelectionFixture.facts).toEqual(before)
      const accepted = yield* RestrictedSelectionFixture.select(fixture)
      expect(accepted.admission.selectionId).toBeTruthy()
      expect(fixture.state).toEqual({ sources: 0, filesystem: 0 })
    }),
  ))

test("source verifier SQL failure is fail-closed before any activity, selection or epoch", () =>
  RestrictedSelectionFixture.isolated((fixture) =>
    Effect.gen(function* () {
      yield* RestrictedSelectionFixture.admit(fixture)
      const db = (yield* Database.Service).db
      yield* db.run("DROP TABLE test_work_source")
      const before = yield* RestrictedSelectionFixture.facts
      const result = yield* RestrictedSelectionFixture.select(fixture).pipe(Effect.exit)
      expect(code(result)).not.toBe("success")
      expect(code(result)).toContain("test_work_source")
      expect(yield* RestrictedSelectionFixture.facts).toEqual(before)
      expect(fixture.state).toEqual({ sources: 0, filesystem: 0 })
    }),
  ))

test("revocation is rechecked before returning an existing exact-retry selection", () =>
  RestrictedSelectionFixture.isolated((fixture) =>
    Effect.gen(function* () {
      yield* RestrictedSelectionFixture.admit(fixture)
      yield* RestrictedSelectionFixture.select(fixture)
      const db = (yield* Database.Service).db
      yield* db.run("UPDATE test_work_source SET enabled=0")
      const before = yield* RestrictedSelectionFixture.facts
      expect(code(yield* RestrictedSelectionFixture.select(fixture).pipe(Effect.exit))).toBe("WORK_REVOKED")
      expect(yield* RestrictedSelectionFixture.facts).toEqual(before)
      expect(fixture.state).toEqual({ sources: 0, filesystem: 0 })
    }),
  ))

test("stale Work revision and conflicting existing selection cannot be silently reused", () =>
  RestrictedSelectionFixture.isolated((fixture) =>
    Effect.gen(function* () {
      yield* RestrictedSelectionFixture.admit(fixture)
      expect(code(yield* RestrictedSelectionFixture.select(fixture, { expectedRevision: 2 }).pipe(Effect.exit))).toBe(
        "WORK_CONTROL_CONFLICT",
      )
      const db = (yield* Database.Service).db
      yield* SessionRunnerCanonical.admitSelection({
        db,
        contexts: yield* SessionContext.Service,
        sessionID: SessionSchema.ID.make(fixture.binding.sessionID),
        agent: fixture.binding.agentID,
        location: fixture.binding.location,
        promotedInputIds: [fixture.binding.inputID],
        system: { baseline: "ordinary unrestricted context", revision: 0, baselineSeq: 1 },
        sources: { identity: { ...fixture.identity, legacyProjectId: "global" } },
      })
      const before = yield* RestrictedSelectionFixture.facts
      expect(code(yield* RestrictedSelectionFixture.select(fixture).pipe(Effect.exit))).toBe("WORK_BINDING_CONFLICT")
      expect(yield* RestrictedSelectionFixture.facts).toEqual(before)
    }),
  ))
