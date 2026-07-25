import { Effect } from "effect"
import { array, check, object } from "../assertions"
import { http } from "../dsl"
import type { Scenario } from "../types"

export const runtimeScenarios: Scenario[] = [
  http.protected
    .post("/debug/start", "debug.start")
    .at((ctx) => ({
      path: "/debug/start",
      headers: ctx.headers(),
      body: { adapter: "httpapi-missing", program: "program.py" },
    }))
    .json(200, (body) => {
      object(body)
      check(body.error === "adapter_unavailable", "unknown debug adapters should fail closed")
    }),
  http.protected
    .post("/debug/breakpoints", "debug.breakpoints")
    .at((ctx) => ({
      path: "/debug/breakpoints",
      headers: ctx.headers(),
      body: { sessionId: "debug_httpapi_missing", file: "main.ts", breakpoints: [{ line: 1 }] },
    }))
    .status(500, undefined, "status"),
  http.protected
    .post("/debug/continue", "debug.continue")
    .at((ctx) => ({
      path: "/debug/continue",
      headers: ctx.headers(),
      body: { sessionId: "debug_httpapi_missing" },
    }))
    .status(500, undefined, "status"),
  http.protected
    .post("/debug/step", "debug.step")
    .at((ctx) => ({
      path: "/debug/step",
      headers: ctx.headers(),
      body: { sessionId: "debug_httpapi_missing", kind: "next" },
    }))
    .status(500, undefined, "status"),
  http.protected
    .get("/debug/stack", "debug.stack")
    .at((ctx) => ({ path: "/debug/stack?sessionId=debug_httpapi_missing", headers: ctx.headers() }))
    .status(500, undefined, "status"),
  http.protected
    .get("/debug/scopes", "debug.scopes")
    .at((ctx) => ({
      path: "/debug/scopes?sessionId=debug_httpapi_missing&frameId=1",
      headers: ctx.headers(),
    }))
    .status(500, undefined, "status"),
  http.protected
    .get("/debug/variables", "debug.variables")
    .at((ctx) => ({
      path: "/debug/variables?sessionId=debug_httpapi_missing&variablesReference=1",
      headers: ctx.headers(),
    }))
    .status(500, undefined, "status"),
  http.protected
    .post("/debug/evaluate", "debug.evaluate")
    .at((ctx) => ({
      path: "/debug/evaluate",
      headers: ctx.headers(),
      body: { sessionId: "debug_httpapi_missing", expression: "value" },
    }))
    .status(500, undefined, "status"),
  http.protected
    .post("/debug/terminate", "debug.terminate")
    .at((ctx) => ({
      path: "/debug/terminate",
      headers: ctx.headers(),
      body: { sessionId: "debug_httpapi_missing" },
    }))
    .status(500, undefined, "status"),
  http.protected.get("/debug/sessions", "debug.sessions").json(200, (body) => {
    object(body)
    array(body.sessions)
  }),
  http.protected
    .get("/debug/events", "debug.events")
    .headersOnly()
    .status(200, (_ctx, result) =>
      Effect.sync(() => {
        check(result.contentType.includes("text/event-stream"), "debug events should use SSE")
      }),
    ),
  http.protected
    .post("/profile/run", "profile.run")
    .at((ctx) => ({
      path: "/profile/run",
      headers: ctx.headers(),
      body: { program: "program.py", profiler: "httpapi-missing" },
    }))
    .json(200, (body) => {
      object(body)
      check(body.status === "error", "an unavailable profiler should return a stable error result")
      check(typeof body.runId === "string", "profile run should return a correlation id")
    }),
  http.protected
    .get("/profile/result", "profile.result")
    .at((ctx) => ({ path: "/profile/result?runId=profile_httpapi_missing", headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      check(body.status === "error" && body.error === "runId not found", "missing profile results should be explicit")
    }),
  http.protected
    .get("/profile/hotspots", "profile.hotspots")
    .at((ctx) => ({ path: "/profile/hotspots?runId=profile_httpapi_missing", headers: ctx.headers() }))
    .json(200, array),
  http.protected.get("/profile/runs", "profile.runs").json(200, array),
]
