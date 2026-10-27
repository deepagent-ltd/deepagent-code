import { Effect } from "effect"
import { array, check, object } from "../assertions"
import { http } from "../dsl"
import type { Scenario } from "../types"

const refused = (code: string) => (body: unknown) => {
  object(body)
  check(body.code === code, `expected the explicit ${code} refusal`)
  check(typeof body.message === "string" && body.message.length > 0, "refusal should explain its boundary")
}

const attentionUnavailable = (body: unknown) => {
  object(body)
  check(
    body._tag === "ServiceUnavailableError" && body.service === "attention",
    "attention should retain its typed unavailable result",
  )
  check(body.message === "profile_disabled", "this fixture has not enabled the trusted local attention profile")
}

export const agentControlScenarios: Scenario[] = [
  http.protected.get("/api/attention/capability", "release205.agentControl.attention.capability").json(200, (body) => {
    object(body)
    check(
      body.enabled === false &&
        body.scope === "implicit-local" &&
        body.actor === "server" &&
        body.reason === "profile_disabled",
      "fetch-only fixture should advertise its actual disabled profile",
    )
  }),
  http.protected
    .get("/api/attention", "release205.agentControl.attention.listProfileBoundary")
    .json(503, attentionUnavailable),
  http.protected
    .get("/api/attention/{itemID}", "release205.agentControl.attention.getProfileBoundary")
    .at((ctx) => ({ path: "/api/attention/absent-item", headers: ctx.headers() }))
    .json(503, attentionUnavailable),
  http.protected
    .put("/api/attention/{itemID}/seen", "release205.agentControl.attention.seenProfileBoundary")
    .mutating()
    .at((ctx) => ({
      path: "/api/attention/absent-item/seen",
      headers: ctx.headers(),
      body: { revision: "observed-revision" },
    }))
    .json(503, attentionUnavailable),
  http.protected
    .post("/api/attention/task/control", "release205.agentControl.attention.taskProfileBoundary")
    .withServerAuth()
    .seeded((ctx) => ctx.session())
    .at((ctx) => ({
      path: "/api/attention/task/control",
      headers: ctx.headers({ host: "localhost" }),
      body: {
        runID: "run_httpapi_absent",
        parentSessionID: ctx.state.id,
        childSessionID: null,
        generation: 1,
        expectedVersion: 0,
        itemID: "absent-item",
        itemRevision: "a".repeat(64),
        requestID: "httpapi-task-control",
        action: "request_close",
        reason: "Check the original local-profile boundary",
      },
    }))
    .json(503, refused("unavailable")),
  http.protected
    .post("/api/session", "release205.agentControl.session.create")
    .mutating()
    .at((ctx) => ({ path: "/api/session", headers: ctx.headers(), body: { metadata: { httpapi: "agent-control" } } }))
    .json(
      200,
      (body, ctx) => {
        object(body)
        object(body.data)
        object(body.data.location)
        object(body.data.metadata)
        check(
          typeof body.data.id === "string" && body.data.id.startsWith("ses"),
          "HTTP creation should return its original Session id",
        )
        check(body.data.location.directory === ctx.directory, "created Session must retain its real fixture Location")
        check(body.data.metadata.httpapi === "agent-control", "HTTP creation should persist the submitted metadata")
      },
      "status",
    ),
  http.protected
    .get("/api/session/{sessionID}", "release205.agentControl.session.get")
    .seeded((ctx) => ctx.session({ title: "HTTP Core Session" }))
    .at((ctx) => ({ path: `/api/session/${ctx.state.id}`, headers: ctx.headers() }))
    .json(
      200,
      (body, ctx) => {
        object(body)
        object(body.data)
        check(
          body.data.id === ctx.state.id && body.data.title === "HTTP Core Session",
          "Core Session read should preserve the original id and title",
        )
      },
      "status",
    ),
  http.protected
    .get("/api/session/{sessionID}/events", "release205.agentControl.session.events")
    .seeded((ctx) => ctx.session())
    .at((ctx) => ({ path: `/api/session/${ctx.state.id}/events`, headers: ctx.headers() }))
    .stream()
    .status(200, (_ctx, result) =>
      Effect.sync(() => {
        check(result.contentType.includes("text/event-stream"), "journal replay should use SSE")
        check(
          result.text.includes("session.created") && result.text.includes("data:"),
          "stream should replay the actual durable creation event",
        )
      }),
    ),
  http.protected
    .get("/api/session/{sessionID}/events/cursor", "release205.agentControl.session.cursor")
    .seeded((ctx) => ctx.session())
    .at((ctx) => ({ path: `/api/session/${ctx.state.id}/events/cursor`, headers: ctx.headers() }))
    .json(
      200,
      (body) => {
        object(body)
        check(
          typeof body.cursor === "number" && body.cursor >= 0,
          "created Session should expose its durable journal watermark",
        )
      },
      "status",
    ),
  ...["candidates", "reports"].map((operation) =>
    http.protected
      .get(
        `/api/v1/event-investigation/rules/{ruleID}/${operation}`,
        `release205.agentControl.investigation.${operation}`,
      )
      .withServerAuth()
      .at((ctx) => ({
        path: `/api/v1/event-investigation/rules/rule_httpapi_absent/${operation}`,
        headers: ctx.headers(),
      }))
      .json(403, refused("INVESTIGATION_AUTH_REQUIRED")),
  ),
  http.protected
    .post("/api/v1/event-investigation/capture", "release205.agentControl.investigation.capture")
    .withServerAuth()
    .at((ctx) => ({
      path: "/api/v1/event-investigation/capture",
      headers: ctx.headers(),
      body: {
        ruleID: "rule_httpapi_absent",
        targetID: "target_httpapi_absent",
        expiresAt: Date.now() + 60_000,
      },
    }))
    .json(403, refused("INVESTIGATION_AUTH_REQUIRED")),
  http.protected
    .post("/api/v1/event-investigation/control", "release205.agentControl.investigation.control")
    .withServerAuth()
    .at((ctx) => ({
      path: "/api/v1/event-investigation/control",
      headers: ctx.headers(),
      body: {
        ruleID: "rule_httpapi_absent",
        requestID: "httpapi-investigation-control",
        operation: "disable",
        expectedEpoch: 0,
        expectedOperatorRevision: 1,
        targetID: null,
        expiresAt: null,
        captureID: null,
      },
    }))
    .json(403, refused("INVESTIGATION_AUTH_REQUIRED")),
  http.protected
    .get("/api/v1/event-validation/rules", "release205.agentControl.validation.rules")
    .withServerAuth()
    .json(403, refused("VALIDATION_AUTH_REQUIRED")),
  http.protected
    .get("/api/v1/event-validation/rules/{ruleID}/runs", "release205.agentControl.validation.runs")
    .withServerAuth()
    .at((ctx) => ({ path: "/api/v1/event-validation/rules/rule_httpapi_absent/runs", headers: ctx.headers() }))
    .json(403, refused("VALIDATION_AUTH_REQUIRED")),
  http.protected
    .post("/api/v1/event-validation/candidates", "release205.agentControl.validation.candidates")
    .withServerAuth()
    .seeded((ctx) => ctx.session())
    .at((ctx) => ({
      path: "/api/v1/event-validation/candidates",
      headers: ctx.headers(),
      body: { sessionID: ctx.state.id },
    }))
    .json(403, refused("VALIDATION_AUTH_REQUIRED")),
  http.protected
    .post("/api/v1/event-validation/capture", "release205.agentControl.validation.capture")
    .withServerAuth()
    .seeded((ctx) => ctx.session())
    .at((ctx) => ({
      path: "/api/v1/event-validation/capture",
      headers: ctx.headers(),
      body: {
        sessionID: ctx.state.id,
        targetID: "target_httpapi_absent",
        recipeID: "recipe_httpapi_absent",
        parameters: [],
        watch: ["src/probe.ts"],
        maxRuns: 1,
        expiresAt: Date.now() + 60_000,
      },
    }))
    .json(403, refused("VALIDATION_AUTH_REQUIRED")),
  http.protected
    .post("/api/v1/event-validation/rules/configure-captured", "release205.agentControl.validation.configureCaptured")
    .withServerAuth()
    .at((ctx) => ({
      path: "/api/v1/event-validation/rules/configure-captured",
      headers: ctx.headers(),
      body: {
        captureID: "capture_httpapi_absent",
        ruleID: "rule_httpapi_absent",
        requestID: "httpapi-configure-captured",
        expectedRevision: 0,
      },
    }))
    .json(403, refused("VALIDATION_AUTH_REQUIRED")),
  http.protected
    .post("/api/v1/event-validation/rules/configure", "release205.agentControl.validation.configureSchemaBoundary")
    .withServerAuth()
    .at((ctx) => ({
      path: "/api/v1/event-validation/rules/configure",
      headers: ctx.headers(),
      body: {
        ruleID: "rule_httpapi_absent",
        requestID: "httpapi-configure",
        expectedRevision: 0,
        configuration: { profile: "unsupported-profile" },
      },
    }))
    .json(400, (body) => {
      object(body)
      check(
        body._tag === "InvalidRequestError" && body.kind === "Payload",
        "invalid recipe configuration must fail the typed payload codec",
      )
      check(
        typeof body.message === "string" && body.message.includes("configuration"),
        "schema refusal should identify the configuration field",
      )
    }),
  http.protected
    .post("/api/v1/event-validation/rules/{ruleID}/control", "release205.agentControl.validation.control")
    .withServerAuth()
    .at((ctx) => ({
      path: "/api/v1/event-validation/rules/rule_httpapi_absent/control",
      headers: ctx.headers(),
      body: {
        requestID: "httpapi-validation-control",
        expectedRevision: 1,
        action: "pause",
      },
    }))
    .json(403, refused("VALIDATION_AUTH_REQUIRED")),
  ...["candidates", "rules", "roots", "rules/control", "roots/control", "session"].map((operation) =>
    http.protected
      .post(`/api/v1/event-work/${operation}`, `release205.agentControl.eventWork.${operation.replaceAll("/", ".")}`)
      .withServerAuth()
      .seeded((ctx) => ctx.session())
      .at((ctx) => ({
        path: `/api/v1/event-work/${operation}`,
        headers: ctx.headers(),
        body: {
          sourceSessionID: ctx.state.id,
          ...(operation === "rules/control"
            ? { ruleID: "rule_httpapi_absent", requestID: "httpapi-rule-control", expectedRevision: 1, action: "pause" }
            : {}),
          ...(operation === "roots/control"
            ? {
                rootID: "root_httpapi_absent",
                requestID: "httpapi-root-control",
                expectedRevision: 1,
                action: "cancel",
              }
            : {}),
          ...(operation === "session" ? { rootID: "root_httpapi_absent", nodeID: "node_httpapi_absent" } : {}),
        },
      }))
      .json(403, refused("EVENT_WORK_AUTH_REQUIRED")),
  ),
  http.protected
    .get("/context/events", "release205.agentControl.context.events")
    .seeded((ctx) => ctx.session())
    .at((ctx) => ({ path: `/context/events?session_id=${ctx.state.id}&after=0&limit=10`, headers: ctx.headers() }))
    .json(
      200,
      (body) => {
        object(body)
        array(body.events)
        check(
          body.events.length === 0,
          "fresh Session cursor should have no fabricated or replayed tail after its creation watermark",
        )
        check(typeof body.floor === "number", "context events must expose the durable retention floor")
      },
      "status",
    ),
  http.protected
    .get("/context/eventsCursor", "release205.agentControl.context.cursor")
    .seeded((ctx) => ctx.session())
    .at((ctx) => ({ path: `/context/eventsCursor?session_id=${ctx.state.id}`, headers: ctx.headers() }))
    .json(
      200,
      (body) => {
        object(body)
        check(
          typeof body.watermark === "number" && body.cursor === body.watermark && typeof body.floor === "number",
          "context cursor must represent its durable high-water and floor",
        )
      },
      "status",
    ),
  http.protected
    .get("/context/readiness", "release205.agentControl.context.readiness")
    .seeded((ctx) => ctx.session())
    .at((ctx) => ({ path: `/context/readiness?session_id=${ctx.state.id}`, headers: ctx.headers() }))
    .json(
      200,
      (body, ctx) => {
        object(body)
        array(body.graphs)
        object(body.statuses)
        check(
          body.session_id === ctx.state.id && typeof body.ready === "boolean",
          "readiness must retain the original Session identity",
        )
        check(
          body.graphs.length > 0 && Object.keys(body.statuses).length === body.graphs.length,
          "readiness should report every graph status",
        )
      },
      "status",
    ),
  http.protected
    .get("/deepagent/queue", "release205.agentControl.queue")
    .seeded((ctx) => ctx.session())
    .at((ctx) => ({ path: `/deepagent/queue?sessionID=${ctx.state.id}`, headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      array(body.items)
      check(body.items.length === 0, "new Session has no admitted queued prompt")
    }),
  http.protected
    .get("/session/context/cohort", "release205.agentControl.context.cohort")
    .at((ctx) => ({ path: "/session/context/cohort?sinceMs=0", headers: ctx.headers() }))
    .json(
      200,
      (body) => {
        object(body)
        object(body.window)
        object(body.readiness)
        check(
          body.window.sinceMs === 0 && typeof body.window.untilMs === "number",
          "cohort should use the requested real window",
        )
        check(
          typeof body.sessions === "number" && typeof body.selections === "number",
          "cohort should expose bounded aggregate counts",
        )
      },
      "status",
    ),
  http.protected.get("/system-context/snapshot", "release205.agentControl.systemContext.snapshot").json(200, (body) => {
    object(body)
    array(body.loadedCapabilities)
    check(
      typeof body.catalogSnapshotId === "string" && /^sha256:[a-f0-9]{64}$/.test(String(body.catalogDigest)),
      "system snapshot should carry its catalog identity",
    )
    check(
      body.catalogDigestConsistent === true && /^[a-f0-9]{64}$/.test(String(body.l0TextHash)),
      "catalog digest and rendered L0 must remain consistent",
    )
    check(
      body.loadedCapabilityCount === body.loadedCapabilities.length,
      "loaded capability count must match its receipts",
    )
  }),
  ...["begin", "apply", "cancel", "reconcile", "get"].map((operation) => {
    const path =
      operation === "get"
        ? "/deepagent/goal/plan-rebase/{editID}"
        : operation === "reconcile"
          ? "/deepagent/goal/plan-rebase/{editID}/reconcile"
          : `/deepagent/goal/plan-rebase/${operation}`
    const builder =
      operation === "get"
        ? http.protected.get(path, `release205.agentControl.goalRebase.${operation}`)
        : http.protected.post(path, `release205.agentControl.goalRebase.${operation}`)
    return builder
      .withServerAuth()
      .seeded((ctx) => ctx.session())
      .at((ctx) => ({
        path:
          operation === "get"
            ? `/deepagent/goal/plan-rebase/edit_httpapi_absent?sessionID=${ctx.state.id}&goalID=goal_httpapi_absent&requestID=httpapi-rebase`
            : path.replace("{editID}", "edit_httpapi_absent"),
        headers: ctx.headers({ host: "localhost" }),
        ...(operation === "get"
          ? {}
          : {
              body: {
                sessionID: ctx.state.id,
                goalID: "goal_httpapi_absent",
                requestID: "httpapi-rebase",
                expectedControlRevision: 0,
                ...(operation === "begin" ? {} : { editID: "edit_httpapi_absent", expectedEditRevision: 0 }),
                ...(operation === "apply"
                  ? {
                      expectedPlanRevision: 0,
                      expectedDocVersion: 0,
                      expectedDocHash: "a".repeat(64),
                      candidate: {
                        steps: [{ step_id: "step-one", title: "An ordinary unapproved proposal", status: "pending" }],
                        activeStepID: null,
                        dispositions: [],
                      },
                      reason: "Check disabled Goal loop admission without creating authority",
                    }
                  : {}),
              },
            }),
      }))
      .json(409, refused("UNAVAILABLE"))
  }),
]
