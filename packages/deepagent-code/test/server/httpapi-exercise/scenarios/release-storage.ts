import { Effect } from "effect"
import { Database } from "bun:sqlite"
import path from "node:path"
import { array, check, object } from "../assertions"
import { http, route } from "../dsl"
import type { Scenario, ScenarioContext } from "../types"
import { exerciseDatabasePath } from "../environment"

function projectDirectory(ctx: ScenarioContext) {
  if (!ctx.directory) throw new Error("This scenario requires its isolated project directory")
  return ctx.directory
}

function typedError(body: unknown, code: string, status: number) {
  object(body)
  object(body.data)
  check(body.data.code === code && body.data.httpStatus === status, `expected ${code}/${status}`)
  check(typeof body.data.correlationId === "string", "typed refusal must retain its correlation identity")
}

function proxyError(body: unknown, code: string) {
  object(body)
  object(body.error)
  check(body.error.code === code, `expected proxy error ${code}`)
}

export const releaseStorageScenarios: Scenario[] = [
  http.protected
    .get("/bootstrap/status", "release205.storage.bootstrap")
    .global()
    .withServerAuth()
    .json(200, (body) => {
      object(body)
      check(body.ready === true && body.mode === "ready", "isolated database must complete its real bootstrap")
    }),
  http.protected
    .get("/backup/list", "release205.storage.backups")
    .global()
    .withServerAuth()
    .json(200, (body) => {
      object(body)
      array(body.backups)
      check(body.count === body.backups.length, "backup count must match the actual manifest list")
    }),
  http.protected
    .get("/backup/verify", "release205.storage.backupFence")
    .withServerAuth()
    .at((ctx) => ({
      path: `/backup/verify?${new URLSearchParams({ manifest_path: projectDirectory(ctx) })}`,
      headers: ctx.headers(),
    }))
    .json(400, (body) => typedError(body, "validation_failed", 400)),
  ...["/md/export", "/migration/report", "/migration/run", "/backups/govern", "/disk/reclaim"].map((routePath) =>
    http.protected
      .post(routePath, `release205.storage.pathFence${routePath}`)
      .withServerAuth()
      .seeded((ctx) =>
        ctx
          .file("retained.txt", "owned storage sentinel")
          .pipe(Effect.as(path.join(projectDirectory(ctx), "retained.txt"))),
      )
      .at((ctx) => ({ path: routePath, headers: ctx.headers(), body: { dir: ctx.directory, confirm: false } }))
      .jsonEffect(400, (body, ctx) =>
        Effect.gen(function* () {
          typedError(body, "validation_failed", 400)
          check(
            (yield* Effect.promise(() => Bun.file(ctx.state).text())) === "owned storage sentinel",
            "refusal must preserve existing file bytes",
          )
        }),
      ),
  ),
  http.protected
    .post("/backup/restore", "release205.storage.restoreFence")
    .withServerAuth()
    .at((ctx) => ({
      path: "/backup/restore",
      headers: ctx.headers(),
      body: { backup_manifest_ref: ctx.directory, dry_run: true },
    }))
    .json(400, (body) => typedError(body, "validation_failed", 400)),
  http.protected
    .get("/upgrade/status", "release205.storage.upgrade")
    .global()
    .withServerAuth()
    .json(200, (body) => {
      object(body)
      array(body.receipts)
      check(
        typeof body.active === "boolean" && body.count === body.receipts.length,
        "upgrade status must report its real receipts",
      )
    }),
  http.protected
    .get("/md/export/status", "release205.storage.mdStatus")
    .global()
    .withServerAuth()
    .json(200, (body) => {
      object(body)
      array(body.entries)
      check(
        typeof body.exists === "boolean" && typeof body.manifestPath === "string",
        "MD status must expose its manifest identity",
      )
    }),
  http.protected
    .get("/migration/status", "release205.storage.migrationStatus")
    .global()
    .withServerAuth()
    .json(200, (body) => {
      object(body)
      check(typeof body.active === "boolean", "migration status must report journal activity")
    }),
  http.protected
    .get("/migration/report", "release205.storage.migrationReport")
    .global()
    .withServerAuth()
    .json(200, (body) => {
      object(body)
      check(
        typeof body.exists === "boolean" && typeof body.reportPath === "string",
        "report lookup must expose its persisted path",
      )
    }),
  http.protected
    .get("/composition/digest", "release205.storage.composition")
    .global()
    .withServerAuth()
    .json(200, object),
  http.protected
    .get("/health/composition", "release205.storage.compositionHealth")
    .global()
    .withServerAuth()
    .json(200, object),
  http.protected
    .get("/recovery/list", "release205.storage.recoveryList")
    .global()
    .withServerAuth()
    .at(() => ({ path: "/recovery/list?session_id=ses_httpapi_absent" }))
    .json(200, (body) => {
      object(body)
      array(body.descriptors)
      check(body.count === 0 && body.descriptors.length === 0, "an absent Session must not acquire recovery records")
    }),
  http.protected
    .get("/recovery/redriveBlocked", "release205.storage.redrive")
    .global()
    .withServerAuth()
    .json(200, (body) => {
      object(body)
      array(body.blocked)
      check(body.count === body.blocked.length, "redrive count must match the durable projection")
    }),
  http.protected
    .get("/recovery/commandGet", "release205.storage.recoveryMissing")
    .global()
    .withServerAuth()
    .at(() => ({ path: "/recovery/commandGet?command_id=cmd_httpapi_absent" }))
    .json(404, (body) => typedError(body, "resource_not_found", 404)),
  http.protected
    .post("/recovery/command", "release205.storage.recoveryInvalid")
    .global()
    .withServerAuth()
    .at(() => ({ path: "/recovery/command", body: { actor_type: "unknown" } }))
    .status(400),
  http.protected
    .get("/recovery/evidenceExport", "release205.storage.evidenceRead")
    .global()
    .withServerAuth()
    .at(() => ({ path: "/recovery/evidenceExport?export_id=export_httpapi_absent" }))
    .json(503, (body) => typedError(body, "recovery_evidence_export_unavailable", 503)),
  http.protected
    .post("/recovery/evidenceExport", "release205.storage.evidenceWrite")
    .global()
    .withServerAuth()
    .at(() => ({ path: "/recovery/evidenceExport", body: { session_id: "ses_httpapi_absent" } }))
    .json(503, (body) => typedError(body, "recovery_evidence_export_unavailable", 503)),
  http.protected
    .get("/capability/catalog", "release205.storage.catalog")
    .withServerAuth()
    .json(200, (body) => {
      object(body)
      array(body.capabilities)
      check(
        typeof body.digest === "string" && typeof body.id === "string",
        "catalog must retain its versioned identity",
      )
    }),
  http.protected
    .get("/capability/loadReceipts", "release205.storage.loadReceipts")
    .withServerAuth()
    .json(200, (body) => {
      object(body)
      array(body.receipts)
      check(body.count === body.receipts.length, "capability receipt count must match its rows")
    }),
  http.protected
    .post("/capability/search", "release205.storage.capabilitySearch")
    .withServerAuth()
    .at((ctx) => ({ path: "/capability/search", headers: ctx.headers(), body: { query: "read project files" } }))
    .json(200, object),
  http.protected.get("/vcs/refs", "release205.storage.vcsRefs").withServerAuth().json(200, object),
  http.protected.get("/vcs/summary", "release205.storage.vcsSummary").withServerAuth().json(200, object),
  ...["tenants", "ledger", "audit", "lanes"].map((name) =>
    http.protected
      .get(`/proxy/admin/${name}`, `release205.storage.proxy${name}`)
      .global()
      .withServerAuth()
      .json(200, (body) => {
        object(body)
        check(body.object === "list", "proxy admin reads must use the list envelope")
        array(body.data)
      }),
  ),
  http.protected
    .post("/proxy/admin/tenants", "release205.storage.proxyCreate")
    .withServerAuth()
    .mutating()
    .at((ctx) => ({
      path: "/proxy/admin/tenants",
      headers: ctx.headers(),
      body: {
        id: "httpapi-release205",
        key: "synthetic-httpapi-proxy-key",
        directory: ctx.directory,
        model_allowlist: [],
        tier: "passthrough",
        quota_requests_per_minute: 10,
        quota_tokens_per_day: 100,
        lane_limit: 1,
        deadline_ms: 1000,
      },
    }))
    .jsonEffect(201, (body) =>
      Effect.sync(() => {
        object(body)
        check(
          body.id === "httpapi-release205" && typeof body.key_fingerprint === "string",
          "tenant creation must return its actual durable identity",
        )
        const database = new Database(exerciseDatabasePath, { readonly: true })
        try {
          const row = database
            .query("SELECT enabled,key_fingerprint FROM proxy_tenant WHERE id=?")
            .get("httpapi-release205")
          object(row)
          check(
            row.enabled === 1 && row.key_fingerprint === body.key_fingerprint,
            "HTTP tenant creation must persist the exact fingerprint",
          )
        } finally {
          database.close()
        }
        check(!JSON.stringify(body).includes("synthetic-httpapi-proxy-key"), "creation must not echo the raw key")
      }),
    ),
  http.protected
    .patch("/proxy/admin/tenants/{tenantID}", "release205.storage.proxyUpdateMissing")
    .global()
    .withServerAuth()
    .at(() => ({ path: "/proxy/admin/tenants/httpapi-missing", body: { enabled: false } }))
    .json(404, (body) => proxyError(body, "tenant_not_found")),
  http.protected
    .delete("/proxy/admin/tenants/{tenantID}", "release205.storage.proxyDeleteMissing")
    .global()
    .withServerAuth()
    .at(() => ({ path: "/proxy/admin/tenants/httpapi-missing" }))
    .json(404, (body) => proxyError(body, "tenant_not_found")),
  http.publicBypass
    .get("/v1/models", "release205.storage.gatewayModelsDisabled")
    .global()
    .json(404, (body) => proxyError(body, "gateway_disabled")),
  ...["chat/completions", "responses"].map((path) =>
    http.publicBypass
      .post(`/v1/${path}`, `release205.storage.gatewayDisabled${path}`)
      .global()
      .at(() => ({ path: `/v1/${path}`, body: {} }))
      .json(404, (body) => proxyError(body, "gateway_disabled")),
  ),
  ...["provider-resolution", "continuation-resolution"].map((path) =>
    http.protected
      .get(`/session/{sessionID}/${path}`, `release205.storage.sessionRead${path}`)
      .withServerAuth()
      .seeded((ctx) => ctx.session({ title: "Isolated recovery read" }))
      .at((ctx) => ({
        path: route(`/session/{sessionID}/${path}`, { sessionID: ctx.state.id }),
        headers: ctx.headers(),
      }))
      .json(200, array),
  ),
  ...["context-usage", "provider-resolution", "provider-resolution/command", "continuation-resolution"].map((path) =>
    http.protected
      .post(`/session/{sessionID}/${path}`, `release205.storage.sessionInvalid${path}`)
      .withServerAuth()
      .seeded((ctx) => ctx.session({ title: "Invalid recovery command" }))
      .at((ctx) => ({
        path: route(`/session/{sessionID}/${path}`, { sessionID: ctx.state.id }),
        headers: ctx.headers(),
        body: { kind: "invalid" },
      }))
      .status(400),
  ),
  ...["manifest", "file"].map((path) =>
    http.protected
      .get(`/session/{sessionID}/diff-artifact/${path}`, `release205.storage.artifactMissingQuery${path}`)
      .withServerAuth()
      .seeded((ctx) => ctx.session({ title: "Missing diff artifact selector" }))
      .at((ctx) => ({
        path: route(`/session/{sessionID}/diff-artifact/${path}`, { sessionID: ctx.state.id }),
        headers: ctx.headers(),
      }))
      .status(400),
  ),
  http.protected
    .get("/session/{sessionID}/export", "release205.storage.snapshotExport")
    .withServerAuth()
    .seeded((ctx) => ctx.session({ title: "Snapshot export specimen" }))
    .at((ctx) => ({ path: route("/session/{sessionID}/export", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(200, (body) => {
      check(typeof body === "string", "snapshot export must return its serialized archive")
      object(JSON.parse(body as string))
    }),
  http.protected
    .post("/session/import-snapshot", "release205.storage.invalidSnapshot")
    .withServerAuth()
    .at((ctx) => ({ path: "/session/import-snapshot", headers: ctx.headers(), body: { bundle: "invalid-json" } }))
    .status(400),
  http.protected
    .post("/session/import-bundle", "release205.storage.invalidZip")
    .withServerAuth()
    .at((ctx) => ({ path: "/session/import-bundle", headers: ctx.headers(), body: { bundle: "not-a-zip" } }))
    .status(400),
  http.protected
    .post("/session/{sessionID}/export-bundle", "release205.storage.zipExport")
    .withServerAuth()
    .seeded((ctx) => ctx.session({ title: "ZIP export specimen" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/export-bundle", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { tier: "conversation" },
    }))
    .json(200, (body) => {
      object(body)
      check(body.archive === "zip" && typeof body.bundle === "string", "ZIP export must return a base64 archive")
      check(
        Buffer.from(body.bundle as string, "base64")
          .subarray(0, 2)
          .toString() === "PK",
        "exported bytes must have the actual ZIP signature",
      )
    }),
  http.protected
    .post("/session/{sessionID}/export-bundle-stream", "release205.storage.zipStream")
    .withServerAuth()
    .stream()
    .seeded((ctx) => ctx.session({ title: "Streaming ZIP specimen" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/export-bundle-stream", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { tier: "conversation" },
    }))
    .status(200, (_ctx, result) =>
      Effect.sync(() => {
        check(
          result.contentType.includes("text/event-stream") && result.text.includes("data:"),
          "ZIP export must emit an actual SSE event",
        )
      }),
    ),
  http.protected
    .post("/session/{sessionID}/share-bundle", "release205.storage.shareDisabled")
    .withServerAuth()
    .at((ctx) => ({
      path: "/session/ses_httpapi_absent/share-bundle",
      headers: ctx.headers(),
      body: { tier: "conversation" },
    }))
    .json(503, (body) => {
      object(body)
      check(body.service === "session.shareBundle", "sharing must reject before any upload")
    }),
  http.protected
    .post("/session/import-bundle-share", "release205.storage.shareImportDisabled")
    .withServerAuth()
    .at((ctx) => ({
      path: "/session/import-bundle-share",
      headers: ctx.headers(),
      body: { url: "https://invalid.example/private-test" },
    }))
    .json(503, (body) => {
      object(body)
      check(body.service === "session.importBundleShare", "disabled sharing must not download")
    }),
  http.protected
    .post("/session/revoke-bundle-share", "release205.storage.shareRevokeUnconfigured")
    .withServerAuth()
    .at((ctx) => ({
      path: "/session/revoke-bundle-share",
      headers: ctx.headers(),
      body: { url: "https://invalid.example/private-test", revokeToken: "synthetic-revoke" },
    }))
    .json(503, (body) => {
      object(body)
      check(body.service === "session.revokeBundleShare", "missing share host must reject before any request")
    }),
  ...["/sync/artifact/file/chunk", "/sync/artifact/file/metadata", "/sync/snapshot/chunks", "/sync/snapshot/rows"].map(
    (path) =>
      http.protected
        .post(path, `release205.storage.syncInvalid${path}`)
        .withServerAuth()
        .at((ctx) => ({ path, headers: ctx.headers(), body: {} }))
        .status(400),
  ),
]
