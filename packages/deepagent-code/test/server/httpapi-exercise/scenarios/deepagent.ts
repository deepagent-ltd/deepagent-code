import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { Effect } from "effect"
import path from "path"
import { array, check, object } from "../assertions"
import { http } from "../dsl"
import { exerciseDataDirectory } from "../environment"
import type { Scenario } from "../types"

AgentGateway.configure({ enabled: true, runsDir: path.join(exerciseDataDirectory, "deepagent", "runs") })

export const deepagentScenarios: Scenario[] = [
  http.protected.get("/deepagent/knowledge/pending", "deepagent.knowledge.pending").json(200, (body) => {
    object(body)
    array(body.items)
  }),
  http.protected.get("/deepagent/knowledge/review-summary", "deepagent.knowledge.reviewSummary").json(200, (body) => {
    object(body)
    check(typeof body.pendingCount === "number", "knowledge review summary should return a count")
  }),
  http.protected
    .post("/deepagent/knowledge/approve", "deepagent.knowledge.approve")
    .mutating()
    .at((ctx) => ({ path: "/deepagent/knowledge/approve", headers: ctx.headers(), body: { ids: [] } }))
    .json(400, object, "status"),
  http.protected
    .post("/deepagent/knowledge/reject-ids", "deepagent.knowledge.rejectIds")
    .mutating()
    .at((ctx) => ({ path: "/deepagent/knowledge/reject-ids", headers: ctx.headers(), body: { ids: [] } }))
    .json(400, object, "status"),
  http.protected
    .post("/deepagent/knowledge/release-baseline", "deepagent.knowledge.releaseBaseline")
    .mutating()
    .at((ctx) => ({
      path: "/deepagent/knowledge/release-baseline",
      headers: ctx.headers(),
      body: {
        snapshotId: "httpapi-baseline",
        evaluationId: "httpapi-baseline-evaluation",
        candidateRefs: [],
        baselineRef: "httpapi-exercise",
      },
    }))
    .json(200, (body) => {
      object(body)
      check(body.release_snapshot_id === "httpapi-baseline", "baseline should return its durable release id")
      check(body.generation === 1, "baseline should establish generation one")
      check(body.document_count === 0, "explicit empty baseline should remain explicit")
    }),
  http.protected
    .post("/deepagent/knowledge/ship-gate", "deepagent.knowledge.shipGate")
    .at((ctx) => ({
      path: "/deepagent/knowledge/ship-gate",
      headers: ctx.headers(),
      body: {
        snapshotId: "httpapi-evaluated",
        evaluationId: "httpapi-evaluated-evaluation",
        expectedParent: { snapshotId: null, generation: 0, membershipHash: null },
        tasks: ["httpapi"],
        metrics: [
          { group: "general", task: "httpapi", metric: 1 },
          { group: "high", task: "httpapi", metric: 1 },
          { group: "max", task: "httpapi", metric: 1 },
        ],
        candidateRefs: [],
      },
    }))
    .json(400, (body) => {
      object(body)
      check(typeof body.message === "string", "evaluated release should require an explicit baseline")
    }),
  http.protected.get("/deepagent/packs/active", "deepagent.packs.active").json(200, (body) => {
    object(body)
    array(body.packs)
    check(typeof body.snapshotId === "string", "active packs should carry a deterministic snapshot id")
  }),
  http.protected.get("/deepagent/packs/all", "deepagent.packs.all").json(200, (body) => {
    object(body)
    array(body.packs)
  }),
  http.protected
    .post("/deepagent/packs/pin", "deepagent.packs.pin")
    .mutating()
    .at((ctx) => ({ path: "/deepagent/packs/pin", headers: ctx.headers(), body: { packId: "httpapi-pack" } }))
    .json(200, (body) => {
      object(body)
      check(body.ok === true && body.packId === "httpapi-pack", "pack pin should persist the requested id")
    }),
  http.protected
    .post("/deepagent/packs/unpin", "deepagent.packs.unpin")
    .mutating()
    .at((ctx) => ({ path: "/deepagent/packs/unpin", headers: ctx.headers(), body: { packId: "httpapi-pack" } }))
    .json(200, (body) => {
      object(body)
      check(body.ok === true && body.packId === "httpapi-pack", "pack unpin should be idempotent")
    }),
  http.protected.get("/deepagent/env-facts", "deepagent.envFacts.list").json(200, (body) => {
    object(body)
    array(body.adopted)
    array(body.pending)
  }),
  http.protected
    .post("/deepagent/env-facts/decide", "deepagent.envFacts.decide")
    .mutating()
    .at((ctx) => ({
      path: "/deepagent/env-facts/decide",
      headers: ctx.headers(),
      body: { factId: "fact_httpapi", decision: "reject" },
    }))
    .json(200, (body) => {
      object(body)
      check(body.ok === true && body.factId === "fact_httpapi", "environment fact decision should be recorded")
    }),
  http.protected
    .post("/deepagent/env-facts/modify", "deepagent.envFacts.modify")
    .mutating()
    .at((ctx) => ({
      path: "/deepagent/env-facts/modify",
      headers: ctx.headers(),
      body: {
        factId: "fact_httpapi",
        description: "HTTP API environment fact",
        body: { host: "localhost", port: 3000, last_confirmed_at: "2026-01-01T00:00:00.000Z" },
        mode: "project",
      },
    }))
    .json(200, (body) => {
      object(body)
      check(
        body.ok === true && typeof body.factId === "string",
        "environment fact modification should return the stored id",
      )
    }),
  http.protected
    .post("/deepagent/panel/consult", "deepagent.panel.consult")
    .at((ctx) => ({
      path: "/deepagent/panel/consult",
      headers: ctx.headers(),
      body: { sessionID: "session_httpapi_panel", question: "Review the HTTP API" },
    }))
    .json(400, object, "status"),
  http.protected
    .post("/deepagent/panel/arm", "deepagent.panel.arm")
    .mutating()
    .seeded(() => Effect.sync(() => AgentGateway.DeepAgentSessionState.getOrCreate("session_httpapi_panel", "high")))
    .at((ctx) => ({
      path: "/deepagent/panel/arm",
      headers: ctx.headers(),
      body: { sessionID: "session_httpapi_panel", armed: true, rounds: "multi" },
    }))
    .json(200, (body) => {
      object(body)
      check(body.armed === true && body.rounds === "multi", "panel arm should persist the requested mode")
    }),
  http.protected
    .get("/deepagent/panel/status", "deepagent.panel.status")
    .at((ctx) => ({ path: "/deepagent/panel/status?sessionID=session_httpapi_status", headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      check(body.sessionID === "session_httpapi_status", "panel status should echo the session id")
      check(
        typeof body.armed === "boolean" && typeof body.explicit === "boolean",
        "panel status should expose its source",
      )
    }),
  http.protected
    .post("/deepagent/goal/start", "deepagent.goal.start")
    .at((ctx) => ({
      path: "/deepagent/goal/start",
      headers: ctx.headers(),
      body: { sessionID: "session_httpapi_goal", objective: "Exercise the route" },
    }))
    .json(400, object, "status"),
  ...["pause", "resume", "stop"].map((action) =>
    http.protected
      .post(`/deepagent/goal/${action}`, `deepagent.goal.${action}`)
      .at((ctx) => ({
        path: `/deepagent/goal/${action}`,
        headers: ctx.headers(),
        body: { sessionID: "session_httpapi_goal" },
      }))
      .json(200, (body) => {
        object(body)
        check(body.ok === false, `disabled goal ${action} should fail closed without mutation`)
      }),
  ),
  http.protected
    .post("/deepagent/goal/edit-plan", "deepagent.goal.editPlan")
    .at((ctx) => ({
      path: "/deepagent/goal/edit-plan",
      headers: ctx.headers(),
      body: {
        sessionID: "session_httpapi_goal",
        request_id: "request_httpapi_goal_edit",
        plan_write: {
          operation: "create",
          expected_plan_id: null,
          expected_version: null,
          goal: "Exercise the route",
          assumptions: [],
          steps: [{ title: "Verify the response", status: "active", acceptance: null, note: null }],
          active_step_id: null,
        },
      },
    }))
    .json(503, (body) => {
      object(body)
      check(body.message === "goal loop is disabled", "disabled goal plan editing should return typed unavailable")
    }),
  http.protected
    .get("/deepagent/goal/status", "deepagent.goal.status")
    .at((ctx) => ({ path: "/deepagent/goal/status?sessionID=session_httpapi_goal", headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      check(body.goal === null, "an inactive session should have no goal")
    }),
  http.protected
    .get("/deepagent/goal/startable", "deepagent.goal.startable")
    .at((ctx) => ({ path: "/deepagent/goal/startable?sessionID=session_httpapi_goal", headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      check(typeof body.startable === "boolean", "goal startability should be explicit")
      check(["plan", "file", "none"].includes(String(body.source)), "goal startability should identify its source")
    }),
  http.protected.get("/deepagent/wiki/pages", "deepagent.wiki.pages").json(400, object, "status"),
  http.protected
    .get("/deepagent/wiki/page", "deepagent.wiki.page")
    .at((ctx) => ({ path: "/deepagent/wiki/page?docId=doc_httpapi&scope=durable", headers: ctx.headers() }))
    .json(400, object, "status"),
  http.protected
    .get("/deepagent/wiki/search", "deepagent.wiki.search")
    .at((ctx) => ({ path: "/deepagent/wiki/search?text=httpapi", headers: ctx.headers() }))
    .json(400, object, "status"),
  http.protected
    .post("/deepagent/wiki/edit", "deepagent.wiki.edit")
    .at((ctx) => ({
      path: "/deepagent/wiki/edit",
      headers: ctx.headers(),
      body: { docId: "doc_httpapi", scope: "durable", body: "updated", editor: { id: "httpapi" } },
    }))
    .json(400, object, "status"),
  http.protected
    .get("/deepagent/wiki/execution-archive", "deepagent.wiki.executionArchive")
    .at((ctx) => ({
      path: "/deepagent/wiki/execution-archive?sessionID=session_httpapi_archive",
      headers: ctx.headers(),
    }))
    .json(400, object, "status"),
]
