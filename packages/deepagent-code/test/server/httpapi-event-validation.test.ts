import { expect, test } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Database } from "@deepagent-code/core/database/database"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"

test("actual root event-validation routes preserve authentication and do not grant execution on reads", async () => {
  const web = HttpRouter.toWebHandler(HttpApiApp.createRoutes({ cors: ["https://validation.example"] }).pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
      DEEPAGENT_CODE_SERVER_USERNAME: "validation-operator", DEEPAGENT_CODE_SERVER_PASSWORD: "private-test-password",
    }))),
  ), { disableLogger: true })
  const headers = { authorization: `Basic ${Buffer.from("validation-operator:private-test-password").toString("base64")}`,
    origin: "https://validation.example", "content-type": "application/json" }
  try {
    for (const pathname of ["/api/v1/event-validation/rules", "/api/v1/event-validation/rules/unknown/runs"]) {
      const denied = await web.handler(new Request(`http://localhost${pathname}`), HttpApiApp.context)
      expect(denied.status).toBe(401)
      const authenticated = await web.handler(new Request(`http://localhost${pathname}`, { headers }), HttpApiApp.context)
      expect(authenticated.status).toBe(403)
      expect(authenticated.headers.get("access-control-allow-origin")).toBe("https://validation.example")
      expect(await authenticated.json()).toMatchObject({ code: "VALIDATION_AUTH_REQUIRED", status: 403 })
    }
    const control = await web.handler(new Request("http://localhost/api/v1/event-validation/rules/unknown/control", {
      method: "POST", headers, body: JSON.stringify({ requestID: "manual-control", expectedRevision: 1, action: "verify" }),
    }), HttpApiApp.context)
    expect(control.status).toBe(403)
    expect(await control.json()).toMatchObject({ code: "VALIDATION_AUTH_REQUIRED", status: 403 })
    for (const request of [
      { pathname: "/api/v1/event-investigation/rules/unknown/candidates" },
      { pathname: "/api/v1/event-investigation/rules/unknown/reports" },
      { pathname: "/api/v1/event-investigation/capture", body: { ruleID: "unknown", targetID: "unknown", expiresAt: Date.now() + 60_000 } },
      { pathname: "/api/v1/event-investigation/control", body: { ruleID: "unknown", requestID: "investigation-disable", operation: "disable",
        expectedEpoch: 0, expectedOperatorRevision: 1, targetID: null, expiresAt: null, captureID: null } },
    ]) {
      const options = "body" in request ? { method: "POST", body: JSON.stringify(request.body) } : {}
      const denied = await web.handler(new Request(`http://localhost${request.pathname}`, {
        ...options, headers: { "content-type": "application/json" },
      }), HttpApiApp.context)
      expect(denied.status).toBe(401)
      const authenticated = await web.handler(new Request(`http://localhost${request.pathname}`, { ...options, headers }), HttpApiApp.context)
      expect(authenticated.status).toBe(403)
      expect(authenticated.headers.get("access-control-allow-origin")).toBe("https://validation.example")
      expect(await authenticated.json()).toMatchObject({ code: "INVESTIGATION_AUTH_REQUIRED", status: 403 })
    }
    await Effect.runPromise(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      for (const table of ["event_validation_rule", "event_validation_run", "event_validation_command", "event_validation_project", "event_validation_investigation_receipt", "work_execution", "session_input"])
        expect(yield* db.get(`SELECT count(*) count FROM ${table}`)).toEqual({ count: 0 })
    }).pipe(Effect.provide(Database.defaultLayer), Effect.scoped))
  } finally {
    await web.dispose()
  }
}, 30000)
