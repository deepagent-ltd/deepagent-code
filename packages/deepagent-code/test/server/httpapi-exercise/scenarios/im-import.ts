import { Database } from "bun:sqlite"
import { Effect, Schedule, Schema } from "effect"
import path from "node:path"
import { ImportJobSchema } from "@deepagent-code/core/import-job/schema"
import { MessageID } from "../../../../src/session/schema"
import { array, check, object, stable } from "../assertions"
import { call } from "../backend"
import { http, route } from "../dsl"
import { exerciseDatabasePath } from "../environment"
import type { Scenario, ScenarioContext } from "../types"

const serviceDisabled = http.protected
  .get("/global/config", "release205.imImport.setup.serviceDisabled")
  .withServerAuth()
  .at(() => ({ path: "/global/config" }))
  .json(200)

// Read actual domain rows, including admissions and receipts. No writer, Native identity,
// external IM service, or payment authority is installed by these exercises.
function snapshot() {
  const db = new Database(exerciseDatabasePath, { readonly: true })
  try {
    return stable(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND (name GLOB 'im_*' OR name IN ('session','message','part','session_input','work_known_recovery','work_storage_cleanup')) ORDER BY name",
        )
        .all()
        .map((table) => [table.name, db.query(`SELECT * FROM "${table.name}"`).all().map(stable).sort()]),
    )
  } finally {
    db.close()
  }
}

function unavailable(ctx: ScenarioContext) {
  return Effect.gen(function* () {
    const result = yield* call(serviceDisabled, { ...ctx, state: undefined })
    check(result.status === 200, `could not observe offline IM configuration: ${result.status}: ${result.text}`)
    object(result.body)
    object(result.body.im)
    check(result.body.im.url === null, "the global IM service must be disabled before exercising offline handlers")
    return { before: snapshot() }
  })
}

function unchanged(before: string) {
  const after = snapshot()
  check(
    after === before,
    `the IM request must not change messages, credentials, payments, admissions, or Work receipts: before=${Bun.hash(before)}, after=${Bun.hash(after)}`,
  )
}

function typed(body: unknown, name: string, code?: string) {
  object(body)
  check(body.name === name, `expected ${name}, got ${stable(body)}`)
  object(body.data)
  if (code) check(body.data.code === code, `expected ${code}, got ${stable(body)}`)
}

const createGroup = http.protected
  .post("/api/v1/im/groups", "release205.imImport.setup.group")
  .withServerAuth()
  .at((ctx) => ({
    path: "/api/v1/im/groups",
    headers: ctx.headers(),
    body: { name: "HTTP local group", type: "project" },
  }))
  .json(200)

function group(ctx: ScenarioContext) {
  return Effect.gen(function* () {
    yield* unavailable(ctx)
    const response = yield* call(createGroup, { ...ctx, state: undefined })
    check(response.status === 200, `local group creation failed: ${response.status}: ${response.text}`)
    object(response.body)
    check(typeof response.body.id === "string", "created group must have a real repository ID")
    return { id: response.body.id, referenceID: MessageID.ascending(), before: snapshot() }
  })
}

const importContent = [
  { type: "user", sessionId: "httpapi-import", message: { role: "user", content: "Original import question" } },
  {
    type: "assistant",
    sessionId: "httpapi-import",
    message: { role: "assistant", content: [{ type: "text", text: "Original import answer" }] },
  },
]
  .map((line) => JSON.stringify(line))
  .join("\n")

function importSource(ctx: ScenarioContext) {
  return Effect.gen(function* () {
    check(!!ctx.directory, "import source must be in the owned project fixture")
    yield* ctx.file("import-source/projects/fixture/session.jsonl", importContent)
    return {
      request: {
        requestID: "httpapi-durable-import",
        source: "claude" as const,
        sourcePath: path.join(ctx.directory, "import-source"),
        scopes: ["session"],
        dryRun: true,
        mode: "copy_to_new_db",
      },
      filename: path.join(ctx.directory, "import-source/projects/fixture/session.jsonl"),
      before: snapshot(),
    }
  })
}

function importRead(id: string) {
  return http.protected
    .get("/global/import/jobs/{jobID}", "release205.imImport.setup.importRead")
    .withServerAuth()
    .at(() => ({ path: route("/global/import/jobs/{jobID}", { jobID: id }) }))
    .json(200)
}

function importSettled(ctx: ScenarioContext, id: string) {
  return call(importRead(id), { ...ctx, state: undefined }).pipe(
    Effect.map((response) => {
      check(response.status === 200, `import observation failed: ${response.status}: ${response.text}`)
      return Schema.decodeUnknownSync(ImportJobSchema.Info)(response.body)
    }),
    Effect.repeat({ schedule: Schedule.spaced("25 millis"), while: (info) => !ImportJobSchema.terminal(info.state) }),
    Effect.timeout("15 seconds"),
    Effect.orDie,
  )
}

function imported(ctx: ScenarioContext) {
  return Effect.gen(function* () {
    const source = yield* importSource(ctx)
    const scenario = http.protected
      .post("/global/import/jobs", "release205.imImport.setup.importCreate")
      .withServerAuth()
      .at(() => ({ path: "/global/import/jobs", body: source.request }))
      .json(200)
    const response = yield* call(scenario, { ...ctx, state: undefined })
    check(response.status === 200, `import creation failed: ${response.status}: ${response.text}`)
    const info = Schema.decodeUnknownSync(ImportJobSchema.Info)(response.body)
    const settled = yield* importSettled(ctx, info.id)
    check(
      settled.state === "completed" && settled.totalSessions === 1,
      `real source preflight must complete: ${stable(settled)}`,
    )
    return { ...source, info: settled }
  })
}

function sourceUnchanged(source: { filename: string; before: string }) {
  return Effect.promise(async () => {
    check(
      (await Bun.file(source.filename).text()) === importContent,
      "durable import must preserve original source bytes",
    )
    unchanged(source.before)
  })
}

export const imImportScenarios: Scenario[] = [
  ...["plans", "entitlement"].map((endpoint) =>
    http.protected
      .get(`/api/v1/im/${endpoint}`, `release205.imImport.${endpoint}.offline`)
      .withServerAuth()
      .seeded(unavailable)
      .json(200, (body, ctx) => {
        object(body)
        check(
          body.state === "unknown" && body.reason === "service_unconfigured",
          "offline observation must explicitly report service_unconfigured",
        )
        unchanged(ctx.state.before)
      }),
  ),
  ...[
    { path: "/api/v1/im/activation", code: "im_activation_unavailable" },
    { path: "/api/v1/im/activation/quote", code: "im_activation_unavailable" },
    { path: "/api/v1/im/activation/{transactionID}", code: "im_activation_unavailable" },
    { path: "/api/v1/im/device/info", code: "im_device_store_unavailable" },
    { path: "/api/v1/im/device/migrations", code: "im_activation_unavailable" },
    { path: "/api/v1/im/device/migrations/{migrationID}", code: "im_activation_unavailable" },
  ].map((input) =>
    http.protected
      .get(input.path, `release205.imImport.${input.path.split("/").slice(4).join(".")}.unavailable`)
      .withServerAuth()
      .seeded(unavailable)
      .at((ctx) => ({
        path: route(input.path, { transactionID: "httpapi_transaction_0001", migrationID: "httpapi_migration_0001" }),
        headers: ctx.headers(),
      }))
      .json(502, (body, ctx) => {
        typed(body, "IM_FACADE_UNAVAILABLE", input.code)
        unchanged(ctx.state.before)
      }),
  ),
  http.protected
    .post("/api/v1/im/activation", "release205.imImport.activation.submit.offline")
    .withServerAuth()
    .seeded(unavailable)
    .at((ctx) => ({
      path: "/api/v1/im/activation",
      headers: ctx.headers(),
      body: {
        transactionID: "httpapi_transaction_0001",
        name: "httpapi",
        method: "api_key",
        credential: "synthetic-test-input",
        quoteID: "httpapi-quote",
      },
    }))
    .json(502, (body, ctx) => {
      typed(body, "IM_FACADE_UNAVAILABLE", "im_activation_unavailable")
      unchanged(ctx.state.before)
    }),
  http.protected
    .post("/api/v1/im/device/migrate", "release205.imImport.device.migrate.offline")
    .withServerAuth()
    .seeded(unavailable)
    .at((ctx) => ({
      path: "/api/v1/im/device/migrate",
      headers: ctx.headers(),
      body: { migrationID: "httpapi_migration_0001", voucher: "synthetic-test-voucher" },
    }))
    .json(502, (body, ctx) => {
      typed(body, "IM_FACADE_UNAVAILABLE", "im_activation_unavailable")
      unchanged(ctx.state.before)
    }),
  http.protected
    .get("/api/v1/im/groups/page", "release205.imImport.group.page.local")
    .withServerAuth()
    .seeded(group)
    .at((ctx) => ({ path: "/api/v1/im/groups/page?lane=ordinary&limit=1", headers: ctx.headers() }))
    .json(200, (body, ctx) => {
      object(body)
      array(body.groups)
      check(body.version === 1 && body.lane === "ordinary", "ordinary page must retain its version and lane")
      check(
        body.groups.some((item) => {
          object(item)
          return item.id === ctx.state.id
        }),
        "page must include the real local group",
      )
      unchanged(ctx.state.before)
    }),
  http.protected
    .get("/api/v1/im/groups/{groupId}", "release205.imImport.group.get.local")
    .withServerAuth()
    .seeded(group)
    .at((ctx) => ({ path: route("/api/v1/im/groups/{groupId}", { groupId: ctx.state.id }), headers: ctx.headers() }))
    .json(200, (body, ctx) => {
      object(body)
      object(body.group)
      check(
        body.version === 1 && body.group.id === ctx.state.id && body.group.name === "HTTP local group",
        "GET must observe the seeded local group",
      )
      unchanged(ctx.state.before)
    }),
  http.protected
    .get("/api/v1/im/groups/{groupId}/dac", "release205.imImport.dac.binding.local")
    .withServerAuth()
    .seeded(group)
    .at((ctx) => ({
      path: route("/api/v1/im/groups/{groupId}/dac", { groupId: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(200, (body, ctx) => {
      object(body)
      array(body.recentCommands)
      check(
        body.groupID === ctx.state.id &&
          body.bindingID === null &&
          body.sessionID === null &&
          body.recentCommands.length === 0,
        "binding observation must not create an empty DAC session",
      )
      unchanged(ctx.state.before)
    }),
  ...[
    { method: "get" as const, suffix: "", code: "command_not_found" },
    { method: "post" as const, suffix: "/reply/retry", code: "reply_unavailable" },
    { method: "post" as const, suffix: "/reply/reconcile", code: "reply_unavailable" },
  ].map((input) =>
    http.protected[input.method](
      `/api/v1/im/groups/{groupId}/dac/commands/{commandID}${input.suffix}`,
      `release205.imImport.dac.command.${input.suffix ? input.suffix.split("/").at(-1) : "get"}.unadmitted`,
    )
      .withServerAuth()
      .seeded(group)
      .at((ctx) => ({
        path: route(`/api/v1/im/groups/{groupId}/dac/commands/{commandID}${input.suffix}`, {
          groupId: ctx.state.id,
          commandID: "never_admitted",
        }),
        headers: ctx.headers(),
        ...(input.method === "post" ? { body: {} } : {}),
      }))
      .json(409, (body, ctx) => {
        typed(body, "IM_DAC_COMMAND_REJECTED", input.code)
        unchanged(ctx.state.before)
      }),
  ),
  http.protected
    .post("/api/v1/im/groups/{groupId}/dac/commands", "release205.imImport.dac.submit.referenceRejected")
    .withServerAuth()
    .seeded(group)
    .at((ctx) => ({
      path: route("/api/v1/im/groups/{groupId}/dac/commands", { groupId: ctx.state.id }),
      headers: ctx.headers(),
      body: {
        commandID: "reference_rejected",
        text: "Quote this original message",
        delivery: "queue",
        referenceMessageIDs: [ctx.state.referenceID],
      },
    }))
    .json(409, (body, ctx) => {
      typed(body, "IM_DAC_COMMAND_REJECTED", "reference_unavailable")
      object(body)
      object(body.data)
      check(body.data.admitted === false, "failed references must explicitly remain unadmitted")
      unchanged(ctx.state.before)
    }),
  http.protected
    .post("/api/v1/im/groups/{groupId}/refresh", "release205.imImport.group.refresh.readerUnavailable")
    .withServerAuth()
    .seeded(group)
    .at((ctx) => ({
      path: route("/api/v1/im/groups/{groupId}/refresh", { groupId: ctx.state.id }),
      headers: ctx.headers(),
      body: {},
    }))
    .json(503, (body, ctx) => {
      typed(body, "IM_READER_UNAVAILABLE", "reader_unavailable")
      unchanged(ctx.state.before)
    }),
  ...[
    "/api/v1/im/attachments/{attachmentId}",
    "/api/v1/im/attachments/{attachmentId}/content",
    "/api/v1/im/groups/{groupId}/messages/{messageId}/attachments/{attachmentId}",
    "/api/v1/im/groups/{groupId}/messages/{messageId}/attachments/{attachmentId}/content",
  ].map((endpoint, index) =>
    http.protected
      .get(endpoint, `release205.imImport.attachments.disabled.${index}`)
      .withServerAuth()
      .seeded(unavailable)
      .at((ctx) => ({
        path: route(endpoint, {
          groupId: "group_httpapi",
          messageId: "message_httpapi",
          attachmentId: "a".repeat(64),
        }),
        headers: ctx.headers(),
      }))
      .json(404, (body, ctx) => {
        typed(body, "FILE_UPLOAD_DISABLED")
        unchanged(ctx.state.before)
      }),
  ),
  ...[
    {
      path: "/api/v1/im/work/{workID}/recover-known",
      code: "RECOVERY_AUTH_REQUIRED",
      body: {
        sessionID: "session_httpapi",
        requestID: "httpapi_recovery",
        expectedClaimToken: 1,
        expectedControlRevision: 1,
        action: "recover_only",
      },
    },
    {
      path: "/api/v1/im/work/{workID}/resume-recovered",
      code: "RECOVERY_AUTH_REQUIRED",
      body: { recoveryID: "httpapi_recovery", requestID: "httpapi_resume", expectedControlRevision: 1 },
    },
    {
      path: "/api/v1/im/work/cleanup-known",
      code: "STORAGE_AUTH_REQUIRED",
      body: {
        recoveryID: "httpapi_recovery",
        admissionID: "httpapi_admission",
        requestID: "httpapi_cleanup",
        expectedCustodyRevision: 1,
      },
    },
  ].map((input) =>
    http.protected
      .post(input.path, `release205.imImport.work.${input.path.split("/").at(-1)}.authorityRequired`)
      .global()
      .withServerAuth()
      .seeded(() => Effect.sync(() => ({ before: snapshot() })))
      .at(() => ({ path: route(input.path, { workID: "httpapi_work" }), body: input.body }))
      .json(403, (body, ctx) => {
        object(body)
        check(
          body.code === input.code && body.status === 403,
          "Basic authentication alone must not grant local Work recovery authority",
        )
        unchanged(ctx.state.before)
      }),
  ),
  http.protected
    .post("/global/import/jobs", "release205.imImport.import.create.dryRun")
    .withServerAuth()
    .mutating()
    .seeded(importSource)
    .at((ctx) => ({ path: "/global/import/jobs", body: ctx.state.request }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        const info = Schema.decodeUnknownSync(ImportJobSchema.Info)(body)
        check(
          info.requestID === ctx.state.request.requestID && info.dryRun,
          "creation must return the original durable dry-run identity",
        )
        const settled = yield* importSettled(ctx, info.id)
        check(
          settled.state === "completed" && settled.totalSessions === 1 && settled.committedBatches === 0,
          `dry run must inspect one real source without committed batches: ${stable(settled)}`,
        )
        yield* sourceUnchanged(ctx.state)
      }),
    ),
  http.protected
    .get("/global/import/jobs", "release205.imImport.import.list.durable")
    .withServerAuth()
    .seeded(imported)
    .at(() => ({ path: "/global/import/jobs?limit=1" }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        array(body.items)
        check(body.items.length === 1, "durable list should contain the completed real dry run")
        const info = Schema.decodeUnknownSync(ImportJobSchema.Info)(body.items[0])
        check(info.id === ctx.state.info.id && info.state === "completed", "list must observe the exact settled import")
        yield* sourceUnchanged(ctx.state)
      }),
    ),
  http.protected
    .get("/global/import/jobs/{jobID}", "release205.imImport.import.get.durable")
    .withServerAuth()
    .seeded(imported)
    .at((ctx) => ({ path: route("/global/import/jobs/{jobID}", { jobID: ctx.state.info.id }) }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        check(
          stable(body) === stable(ctx.state.info),
          "GET must observe the complete original settled receipt without execution",
        )
        yield* sourceUnchanged(ctx.state)
      }),
    ),
  http.protected
    .post("/global/import/jobs/{jobID}/cancel", "release205.imImport.import.cancel.settled")
    .withServerAuth()
    .seeded(imported)
    .at((ctx) => ({ path: route("/global/import/jobs/{jobID}/cancel", { jobID: ctx.state.info.id }) }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        check(
          stable(body) === stable(ctx.state.info),
          "cancelling a completed job must preserve its durable terminal receipt",
        )
        yield* sourceUnchanged(ctx.state)
      }),
    ),
]
