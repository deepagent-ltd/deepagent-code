import { array, check, object } from "../assertions"
import { http } from "../dsl"
import type { Scenario } from "../types"

export const oversightScenarios: Scenario[] = [
  http.protected.get("/oversight/metrics", "oversight.metrics").json(200, (body) => {
    object(body)
    check(typeof body.windowFrom === "number" && typeof body.windowTo === "number", "metrics should include its window")
    check(typeof body.dlqEventsTotal === "number", "metrics should include the DLQ total")
  }),
  http.protected
    .get("/oversight/trace", "oversight.trace")
    .at((ctx) => ({ path: "/oversight/trace?correlationID=correlation_httpapi_missing", headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      array(body.nodes)
    }),
  http.protected.get("/oversight/approvals", "oversight.approvals").json(200, (body) => {
    object(body)
    array(body.items)
  }),
  http.protected
    .post("/oversight/approvals/resolve", "oversight.approvals.resolve")
    .at((ctx) => ({
      path: "/oversight/approvals/resolve",
      headers: ctx.headers(),
      body: { id: "approval_httpapi_missing", decision: "acknowledged" },
    }))
    .status(404, undefined, "status"),
  http.protected
    .post("/oversight/takeover", "oversight.takeover")
    .mutating()
    .at((ctx) => ({
      path: "/oversight/takeover",
      headers: ctx.headers(),
      body: { agentID: "agent_httpapi", reason: "HTTP API exercise" },
    }))
    .json(200, (body) => {
      object(body)
      check(
        typeof body.id === "string" && typeof body.workspaceID === "string",
        "takeover should return its audit identity",
      )
      check(
        body.agentID === "agent_httpapi" && body.reason === "HTTP API exercise",
        "takeover should preserve audit context",
      )
    }),
  http.protected
    .post("/oversight/rollback", "oversight.rollback")
    .at((ctx) => ({
      path: "/oversight/rollback",
      headers: ctx.headers(),
      body: { sessionID: "session_httpapi_missing", reason: "HTTP API exercise" },
    }))
    .status(404, undefined, "status"),
]
