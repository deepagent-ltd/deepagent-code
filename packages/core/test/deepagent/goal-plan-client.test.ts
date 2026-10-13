import { expect, test } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { GoalPlanClient } from "../../src/deepagent/goal-plan-client"
import { GoalPlanRebase } from "../../src/deepagent/goal-plan-rebase"
import { GoalChildFixture } from "../fixture/goal-child"
import { GoalPlanClientFixture } from "../fixture/goal-plan-client"

test("WebCrypto locator equals actual persisted begin, lost ACK lookup preserves the original receipt", async () => {
  await GoalChildFixture.isolated(({ directory, state }) =>
    Effect.gen(function* () {
      const f = yield* GoalPlanClientFixture.prepare(directory)
      const begin = {
        sessionID: f.parent.id,
        goalID: f.goalID,
        expectedControlRevision: 1,
        requestID: "begin.client-cold",
      }
      const id = yield* Effect.promise(() => GoalPlanClient.locator(begin))
      const first = yield* GoalPlanRebase.begin(f.db, begin, GoalPlanClientFixture.authorize)
      expect(first.current.editID).toBe(id)
      const actual = GoalPlanClient.decode(JSON.parse(JSON.stringify(first)))
      expect(actual.current.editSource?.planDocument.created_round).toBeNull()
      expect(actual.current.editSource?.planDocument.domain).toBeNull()
      const source = GoalPlanClient.plan(actual)
      const candidate = GoalPlanClient.candidate(actual)
      expect(candidate.steps[0]).toEqual(source.steps[0])
      expect(candidate.activeStepID).toBeNull()
      const before = yield* f.db.all(sql`SELECT * FROM goal_plan_rebase`)
      const row = yield* GoalPlanRebase.read(f.db, id)
      const observed = yield* GoalPlanRebase.response(
        f.db,
        row!,
        begin.requestID,
        true,
        GoalPlanClientFixture.authorize,
      )
      expect(GoalPlanClient.decode(observed).originalReceipt).toEqual(actual.originalReceipt)
      expect(yield* f.db.all(sql`SELECT * FROM goal_plan_rebase`)).toEqual(before)
      expect(state.runs).toBe(0)
      expect(state.locations).toBe(0)
      const doneChanged = {
        ...candidate,
        steps: candidate.steps.map((step) => (step.status === "done" ? { ...step, title: "changed" } : step)),
      }
      expect(() => GoalPlanClient.validateCandidate(source, doneChanged, [])).toThrow("immutable")
      expect(() =>
        GoalPlanClient.validateCandidate(
          source,
          {
            ...candidate,
            steps: candidate.steps.map((step) => (step.status === "pending" ? { ...step, status: "done" } : step)),
          },
          [],
        ),
      ).toThrow("advanced")
    }),
  )
})

test("HTTP transport preserves explicit null and typed rejection; an unknown write has no automatic retry", async () => {
  const calls: { method: string; url: string; body: string }[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      calls.push({ method: request.method, url: request.url, body: await request.text() })
      return Response.json({ code: "REVISION_CONFLICT", message: "Changed revision" }, { status: 409 })
    },
  })
  try {
    const transport = GoalPlanClient.http(
      {
        client: {
          async request(input) {
            const response = await fetch(new URL(input.url, server.url), {
              method: input.method,
              headers: input.headers,
              body: input.body ? JSON.stringify(input.body) : undefined,
            })
            return { error: await response.json(), response }
          },
        },
      },
      { directory: "/a 中文", workspace: "space-a" },
    )
    await expect(
      transport.send({
        action: "apply",
        request: {
          sessionID: "ses_a",
          goalID: "goal_a",
          editID: "rebase_a",
          requestID: "apply-a",
          expectedControlRevision: 2,
          expectedEditRevision: 1,
          expectedPlanRevision: 0,
          expectedDocVersion: 1,
          expectedDocHash: "a".repeat(64),
          reason: "Refine future work",
          candidate: {
            activeStepID: null,
            dispositions: [],
            steps: [{ step_id: "next", title: "Future", status: "pending", acceptance: null }],
          },
        },
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT", status: 409, unknownOutcome: false })
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0].body).candidate.activeStepID).toBeNull()
    expect(JSON.parse(calls[0].body).candidate.steps[0].acceptance).toBeNull()
    await expect(
      transport.get({ sessionID: "ses_a", goalID: "goal_a", editID: "rebase_a", requestID: "begin-a" }),
    ).rejects.toMatchObject({ unknownOutcome: false })
    expect(calls[1].method).toBe("GET")
    expect(new URL(calls[1].url).searchParams.get("requestID")).toBe("begin-a")
    expect(new URL(calls[1].url).searchParams.get("workspace")).toBe("space-a")
    expect(calls[1].body).toBe("")
  } finally {
    await server.stop(true)
  }
})

test("durable descriptor CAS preserves unknown identities and refuses capacity without replacement", async () => {
  const scope = {
    server: "local",
    url: "http://127.0.0.1:1",
    directory: "/test",
    operator: "operator",
    sessionID: "ses_a",
    goalID: "goal_a",
  }
  const draft = await GoalPlanClient.create(scope, 7)
  const initial = GoalPlanClient.upsert([], draft)
  const pending = {
    ...draft,
    revision: 1,
    command: { action: "begin" as const, request: draft.begin },
    phase: "unknown" as const,
  }
  const values = GoalPlanClient.upsert(initial, pending, 0)
  expect(values[0].begin).toEqual(draft.begin)
  expect(() => GoalPlanClient.upsert(values, { ...pending, revision: 2 }, 0)).toThrow("Another client")
  expect(() =>
    GoalPlanClient.upsert(values, { ...pending, revision: 2, scope: { ...scope, goalID: "goal_b" } }, 1),
  ).toThrow()
  expect(() =>
    GoalPlanClient.records(Array.from({ length: 33 }, (_, index) => ({ ...draft, id: `id-${index}` }))),
  ).toThrow("capacity")
  expect(() => GoalPlanClient.records([{ ...draft, reason: "x".repeat(1_048_577) }])).toThrow()
  expect(values).toEqual([pending])
})

test("strict durable codec rejects foreign commands, secret-bearing excess fields and byte-overflow identities", async () => {
  const scope = {
    server: "local",
    url: "http://127.0.0.1:1",
    directory: "/test",
    operator: "operator",
    sessionID: "ses_a",
    goalID: "goal_a",
  }
  const draft = await GoalPlanClient.create(scope, 7)
  expect(() => GoalPlanClient.records([{ ...draft, authorization: "synthetic-secret" }])).toThrow()
  expect(() => GoalPlanClient.records([{ ...draft, scope: { ...scope, password: "synthetic-secret" } }])).toThrow()
  expect(() =>
    GoalPlanClient.records([{ ...draft, scope: { ...scope, url: "http://operator:secret@127.0.0.1" } }]),
  ).toThrow()
  expect(() => GoalPlanClient.records([{ ...draft, begin: { ...draft.begin, sessionID: "中".repeat(171) } }])).toThrow()
  expect(() =>
    GoalPlanClient.records([
      { ...draft, command: { action: "begin", request: { ...draft.begin, requestID: "foreign" } } },
    ]),
  ).toThrow()
  expect(() =>
    GoalPlanClient.records([
      {
        ...draft,
        command: { action: "cancel", request: { ...draft.begin, editID: "foreign", expectedEditRevision: 1 } },
      },
    ]),
  ).toThrow()
  const partial = {
    ...draft,
    candidate: {
      steps: [{ step_id: "next", title: "", status: "pending" as const }],
      activeStepID: null,
      dispositions: [],
    },
    reason: "",
  }
  expect(GoalPlanClient.records([partial])[0].candidate?.steps[0].title).toBe("")
})
