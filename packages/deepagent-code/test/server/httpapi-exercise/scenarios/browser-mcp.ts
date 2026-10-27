import { Database } from "bun:sqlite"
import { Effect } from "effect"
import path from "node:path"
import { array, check, object } from "../assertions"
import { http, route } from "../dsl"
import { exerciseConfigDirectory, exerciseDatabasePath } from "../environment"
import type { Scenario, ScenarioContext, SeededContext, SessionInfo } from "../types"

const absent = "browser_httpapi_missing"
const viewID = "00000000-0000-0000-0000-000000000000"
const digest = "0".repeat(64)
const invocationID = `mcpapp_${digest}`
const tables = [
  "browser_control",
  "browser_action",
  "browser_shared_resource",
  "browser_shared_lease",
  "browser_shared_action",
  "browser_file_grant",
  "browser_file_artifact",
  "session_mcp_app_invocation",
]
type State = { session: SessionInfo; before: string; origin: string; network: { requests: number } }

function effects(ctx: ScenarioContext) {
  return Effect.promise(async () => {
    const database = new Database(exerciseDatabasePath, { readonly: true })
    try {
      const rows = tables.map((table) => ({ table, rows: database.query(`SELECT * FROM "${table}"`).all() }))
      const files = await Promise.all(
        [
          path.join(ctx.directory!, "deepagent-code.json"),
          path.join(exerciseConfigDirectory, "mcp-secret-migration.json"),
        ].map(async (file) => ({
          name: path.basename(file),
          digest: (await Bun.file(file).exists())
            ? new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex")
            : null,
        })),
      )
      return JSON.stringify({ rows, files })
    } finally {
      database.close()
    }
  })
}

function seed(ctx: ScenarioContext) {
  return Effect.gen(function* () {
    const network = { requests: 0 }
    const preview = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: () => {
            network.requests++
            return new Response("isolated browser boundary fixture")
          },
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    )
    const session = yield* ctx.session({ title: "HTTP browser and MCP authorization boundary" })
    return { session, before: yield* effects(ctx), origin: preview.url.origin, network }
  })
}
function unchanged(ctx: SeededContext<State>) {
  return effects(ctx).pipe(
    Effect.map((after) => {
      check(ctx.state.network.requests === 0, "unqualified browser requests must not reach the isolated preview")
      check(
        after === ctx.state.before,
        "browser, file grants, App admissions, project config and credential ledger must remain unchanged",
      )
    }),
  )
}
function request(ctx: SeededContext<State>, template: string, body?: unknown, query = "") {
  return {
    path:
      route(template, {
        name: "httpapi-missing",
        controlID: absent,
        actionID: absent,
        resourceID: absent,
        requestID: "httpapi-request-missing",
      }) + query,
    headers: ctx.headers(),
    ...(body === undefined ? {} : { body }),
  }
}
function refusal(
  method: "get" | "post",
  template: string,
  name: string,
  status: number,
  code: string,
  body?: (ctx: SeededContext<State>) => unknown,
  query = "",
) {
  return http.protected[method](template, `release205.browserMcp.${name}`)
    .withServerAuth()
    .seeded(seed)
    .at((ctx) => request(ctx, template, body?.(ctx), query))
    .jsonEffect(status, (value, ctx) =>
      Effect.gen(function* () {
        object(value)
        check(value.code === code, `expected explicit ${code}, got ${JSON.stringify(value)}`)
        check(
          typeof value.message === "string" || typeof value.error === "string",
          "typed refusal must explain its boundary",
        )
        yield* unchanged(ctx)
      }),
    )
}
const connect = { attachID: absent, generation: absent, secret: digest }

export const browserMcpScenarios: Scenario[] = [
  http.protected
    .delete("/mcp/{name}/config", "release205.browserMcp.config.removeAbsent")
    .withServerAuth()
    .seeded(seed)
    .at((ctx) => request(ctx, "/mcp/{name}/config"))
    .jsonEffect(200, (value, ctx) =>
      Effect.gen(function* () {
        object(value)
        check(value.removed === true, "removing an absent MCP config is idempotent")
        yield* unchanged(ctx)
      }),
    ),
  refusal("get", "/api/v1/browser/actions/{actionID}", "action.readMissing", 404, "BROWSER_NOT_FOUND"),
  refusal("get", "/api/v1/browser/controls/{controlID}", "control.readMissing", 404, "BROWSER_NOT_FOUND"),
  refusal("get", "/api/v1/browser/controls/{controlID}/files", "file.listMissingControl", 404, "BROWSER_NOT_FOUND"),
  refusal(
    "get",
    "/api/v1/browser/controls/{controlID}/files/requests/{requestID}",
    "file.readMissingControl",
    404,
    "BROWSER_NOT_FOUND",
  ),
  http.protected
    .get("/api/v1/browser/shared/resources", "release205.browserMcp.shared.listUnqualified")
    .withServerAuth()
    .seeded(seed)
    .at((ctx) => request(ctx, "/api/v1/browser/shared/resources", undefined, `?sessionID=${ctx.state.session.id}`))
    .jsonEffect(403, (value, ctx) =>
      Effect.gen(function* () {
        object(value)
        check(value.code === "BROWSER_SCOPE_DENIED", "web requests cannot supply the original Native loopback socket")
        yield* unchanged(ctx)
      }),
    ),
  refusal("get", "/api/v1/browser/shared/resources/{resourceID}", "shared.readMissing", 404, "BROWSER_NOT_FOUND"),
  refusal(
    "get",
    "/api/v1/browser/shared/resources/{resourceID}/files",
    "sharedFile.listMissing",
    404,
    "BROWSER_NOT_FOUND",
  ),
  refusal(
    "get",
    "/api/v1/browser/shared/resources/{resourceID}/files/requests/{requestID}",
    "sharedFile.readMissing",
    404,
    "BROWSER_NOT_FOUND",
  ),
  http.protected
    .get("/mcp/apps", "release205.browserMcp.app.listEmpty")
    .withServerAuth()
    .seeded(seed)
    .at((ctx) => request(ctx, "/mcp/apps"))
    .jsonEffect(200, (value, ctx) =>
      Effect.gen(function* () {
        array(value)
        check(value.length === 0, "no MCP connection means no advertised App descriptors")
        yield* unchanged(ctx)
      }),
    ),
  refusal("get", "/mcp/{name}/binding/preview", "binding.previewAbsent", 503, "unavailable"),
  refusal("get", "/mcp/{name}/credentials/preview", "credential.previewAbsent", 503, "unavailable"),
  http.protected
    .get("/mcp/{name}/credentials/{requestID}", "release205.browserMcp.credential.statusAbsent")
    .withServerAuth()
    .seeded(seed)
    .at((ctx) => request(ctx, "/mcp/{name}/credentials/{requestID}"))
    .jsonEffect(404, (_value, ctx) => unchanged(ctx), "status"),
  refusal("post", "/api/v1/browser/controls", "control.createUnqualified", 403, "BROWSER_SCOPE_DENIED", (ctx) => ({
    requestID: "httpapi-create",
    sessionID: ctx.state.session.id,
    origin: ctx.state.origin,
    profile: "managed-loopback-preview-v1",
    expiresAt: Date.now() + 60_000,
  })),
  refusal(
    "post",
    "/api/v1/browser/controls/{controlID}/cancel",
    "control.cancelUnqualified",
    403,
    "BROWSER_SCOPE_DENIED",
    () => ({ requestID: "httpapi-cancel", expectedRevision: 1 }),
  ),
  refusal(
    "post",
    "/api/v1/browser/controls/{controlID}/files/approve",
    "file.approveUnqualified",
    403,
    "BROWSER_SCOPE_DENIED",
    () => ({
      requestID: "httpapi-request",
      previewID: absent,
      expectedControlRevision: 1,
      expiresAt: Date.now() + 60_000,
    }),
  ),
  refusal(
    "post",
    "/api/v1/browser/controls/{controlID}/files/preview",
    "file.previewUnqualified",
    403,
    "BROWSER_SCOPE_DENIED",
    () => ({ direction: "upload", relative: "input.txt", targetPath: "/upload" }),
  ),
  refusal(
    "post",
    "/api/v1/browser/shared/resources",
    "shared.createUnqualified",
    403,
    "BROWSER_SCOPE_DENIED",
    (ctx) => ({
      version: 2,
      profile: "managed-shared-browser-v1",
      inputAssurance: "shared-document-v1",
      requestID: "httpapi-create",
      sessionID: ctx.state.session.id,
      policy: {
        origin: ctx.state.origin,
        approvedOrigins: [ctx.state.origin],
        manualApprovedOrigins: [ctx.state.origin],
        resolverPolicy: "system",
        postGrants: [],
      },
      expiresAt: Date.now() + 60_000,
    }),
  ),
  refusal(
    "post",
    "/api/v1/browser/shared/resources/{resourceID}/close",
    "shared.closeUnqualified",
    403,
    "BROWSER_SCOPE_DENIED",
    () => ({ resourceID: absent, requestID: "httpapi-close", expectedRevision: 1 }),
  ),
  refusal(
    "post",
    "/api/v1/browser/shared/resources/{resourceID}/files/approve",
    "sharedFile.approveMissing",
    404,
    "BROWSER_NOT_FOUND",
    () => ({
      requestID: "httpapi-request",
      previewID: absent,
      expectedResourceRevision: 1,
      expectedLeaseID: absent,
      expectedLeaseEpoch: 1,
      expectedManualEpoch: 0,
      expiresAt: Date.now() + 60_000,
    }),
  ),
  refusal(
    "post",
    "/api/v1/browser/shared/resources/{resourceID}/files/preview",
    "sharedFile.previewMissing",
    404,
    "BROWSER_NOT_FOUND",
    (ctx) => ({ direction: "upload", relative: "input.txt", targetURL: `${ctx.state.origin}/upload` }),
  ),
  refusal(
    "post",
    "/api/v1/browser/shared/resources/{resourceID}/origins",
    "shared.originMissing",
    404,
    "BROWSER_NOT_FOUND",
    (ctx) => ({
      resourceID: absent,
      requestID: "httpapi-origin",
      expectedRevision: 1,
      expectedManualEpoch: 0,
      expectedPolicyHash: digest,
      origin: ctx.state.origin,
    }),
  ),
  refusal(
    "post",
    "/api/v1/browser/shared/resources/{resourceID}/takeover",
    "shared.takeoverUnqualified",
    403,
    "BROWSER_SCOPE_DENIED",
    () => ({ resourceID: absent, requestID: "httpapi-takeover", expectedRevision: 1 }),
  ),
  // Untrusted public payloads below never create a Native stamp or owner capability.
  refusal(
    "post",
    "/api/v1/browser/shared/tui/detach",
    "tui.detachUnqualified",
    403,
    "BROWSER_SCOPE_DENIED",
    () => connect,
  ),
  refusal(
    "post",
    "/api/v1/browser/shared/tui/owner",
    "tui.ownerUnqualified",
    403,
    "BROWSER_SCOPE_DENIED",
    () => connect,
  ),
  refusal("post", "/api/v1/browser/shared/tui/pair", "tui.pairUnqualified", 403, "BROWSER_SCOPE_DENIED", (ctx) => ({
    requestID: "httpapi-pair",
    challengeHash: digest,
    rootSessionID: ctx.state.session.id,
    directory: ctx.directory,
  })),
  refusal("post", "/api/v1/browser/shared/tui/reserve", "tui.reserveUnqualified", 403, "BROWSER_SCOPE_DENIED", () => ({
    ...connect,
    expectedBarrierOrder: 0,
    inputID: "httpapi-input",
    originalSubmissionID: "httpapi-submit",
    rawInput: "readonly boundary probe",
  })),
  refusal("post", "/api/v1/browser/shared/tui/seal", "tui.sealUnqualified", 403, "BROWSER_SCOPE_DENIED", (ctx) => ({
    ...connect,
    stamp: {
      originalSubmissionID: "httpapi-submit",
      inputID: "httpapi-input",
      rootSessionID: ctx.state.session.id,
      rawInputHash: digest,
      sourceKind: "tui_owner",
      sourceBindingHash: digest,
      mainIncarnation: absent,
      submissionOrder: 1,
    },
    prompt: {},
  })),
  refusal("post", "/mcp/apps/check", "app.checkMissingView", 409, "changed", () => ({ viewID })),
  http.protected
    .post("/mcp/apps/close", "release205.browserMcp.app.closeAbsent")
    .withServerAuth()
    .seeded(seed)
    .at((ctx) => request(ctx, "/mcp/apps/close", { viewID }))
    .jsonEffect(200, (value, ctx) =>
      Effect.gen(function* () {
        check(value === true, "closing an absent App view is idempotent and local")
        yield* unchanged(ctx)
      }),
    ),
  http.protected
    .post("/mcp/apps/invocations/list", "release205.browserMcp.app.invocationsEmpty")
    .withServerAuth()
    .seeded(seed)
    .at((ctx) => request(ctx, "/mcp/apps/invocations/list", { sessionID: ctx.state.session.id, limit: 8 }))
    .jsonEffect(200, (value, ctx) =>
      Effect.gen(function* () {
        array(value)
        check(value.length === 0, "a new Session has no admitted MCP App invocation")
        yield* unchanged(ctx)
      }),
    ),
  refusal("post", "/mcp/apps/invocations/result", "app.resultMissing", 409, "not_found", (ctx) => ({
    sessionID: ctx.state.session.id,
    invocationID,
    viewID,
  })),
  refusal("post", "/mcp/apps/invocations/status", "app.statusMissing", 409, "not_found", (ctx) => ({
    sessionID: ctx.state.session.id,
    invocationID,
  })),
  refusal("post", "/mcp/apps/invoke", "app.invokeMissingView", 409, "changed", (ctx) => ({
    sessionID: ctx.state.session.id,
    viewID,
    rpcID: "httpapi-invoke",
    name: "not-connected",
    arguments: {},
  })),
  refusal("post", "/mcp/apps/open", "app.openUnadvertised", 409, "changed", () => ({
    server: "not-connected",
    tool: "not-advertised",
    generation: viewID,
    resourceUri: "ui://httpapi/missing",
    consent: true,
  })),
  refusal("post", "/mcp/apps/tools", "app.toolsMissingView", 409, "changed", (ctx) => ({
    sessionID: ctx.state.session.id,
    viewID,
  })),
  refusal("post", "/mcp/{name}/binding/repair", "binding.repairUnknownPreview", 503, "unavailable", () => ({
    previewID: "0".repeat(32),
  })),
  refusal("post", "/mcp/{name}/credentials/commit", "credential.commitUnknownPreview", 503, "unavailable", () => ({
    previewID: "0".repeat(32),
    requestID: "httpapi-commit",
  })),
  refusal("post", "/mcp/{name}/credentials/initialize", "credential.initializeAbsent", 503, "unavailable", () => ({})),
  refusal(
    "post",
    "/mcp/{name}/credentials/{requestID}/reconcile",
    "credential.reconcileAbsent",
    503,
    "unavailable",
    () => ({}),
  ),
]
