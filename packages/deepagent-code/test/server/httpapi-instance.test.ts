import { PermissionV1 } from "@deepagent-code/core/v1/permission"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Flag } from "@deepagent-code/core/flag/flag"
import { describe, expect } from "bun:test"
import { Config, Context, Effect, FileSystem, Layer, Path } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
import { ControlPaths } from "../../src/server/routes/instance/httpapi/groups/control"
import { InstancePaths } from "../../src/server/routes/instance/httpapi/groups/instance"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { ProjectV2 } from "@deepagent-code/core/project"
import { QuestionID } from "../../src/question/schema"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { HEADER as FenceHeader } from "../../src/server/shared/fence"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Flip the experimental workspaces flag so EventV2.run actually writes to
// EventSequenceTable (the source of truth the fence middleware reads). Reset
// the database around the test so per-instance state does not leak between
// runs. resetDatabase() already calls disposeAllInstances(), so we don't
// repeat it.
const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const originalWorkspaces = Flag.DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES
    Flag.DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES = true
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        Flag.DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
        await resetDatabase()
      }),
    )
  }),
)

// Mount the production HttpApi route tree on a real Node HTTP server bound to
// 127.0.0.1:0 and a fetch-based HttpClient that prepends the server URL. This
// keeps the test wired directly through the same route layer production uses.
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)

const httpApiServerLayer = servedRoutes.pipe(
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)

const it = testEffect(Layer.mergeAll(testStateLayer, httpApiServerLayer))
const handlerContext = Context.empty() as Context.Context<unknown>

const directoryHeader = (dir: string) => HttpClientRequest.setHeader("x-deepagent-code-directory", dir)

describe("instance HttpApi", () => {
  it.live("serves the OpenAPI document", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/doc")

      expect(response.status).toBe(200)
      expect(response.headers["content-type"]).toContain("application/json")
      expect(yield* response.json).toMatchObject({
        openapi: expect.any(String),
        info: expect.any(Object),
        paths: expect.objectContaining({
          "/global/health": expect.any(Object),
          "/session": expect.any(Object),
        }),
      })
    }),
  )

  it.live("reports capabilities and protocol version", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/global/capabilities")

      expect(response.status).toBe(200)
      const body = yield* response.json
      expect(body).toMatchObject({
        protocolVersion: "3.8",
        version: expect.any(String),
        features: {
          im: true,
          sessions: true,
          pty: true,
          workspaces: true,
          // §H3 — the event-driven flags are advertised and default OFF in production (operator
          // opt-in per the staged rollout). This test builds RuntimeFlags from empty env, so the
          // capability endpoint reports the production defaults.
          v4EventDrivenIm: false,
          v4AgentPushEnabled: false,
          v4MultiAgentRuntime: false,
          v4ThreadEnabled: false,
          v4FileUploadEnabled: false,
        },
      })
    }),
  )

  it.live("§D2 GET /oversight/approvals returns an empty pending queue for a fresh workspace", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const response = yield* HttpClientRequest.get("/oversight/approvals").pipe(directoryHeader(dir), HttpClient.execute)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ items: [] })
    }),
  )

  it.live("§F GET /oversight/metrics returns the metric shape (zero/​null on a fresh workspace)", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const response = yield* HttpClientRequest.get("/oversight/metrics").pipe(directoryHeader(dir), HttpClient.execute)
      expect(response.status).toBe(200)
      const body = (yield* response.json) as Record<string, unknown>
      expect(body).toMatchObject({
        dlqEventsTotal: 0,
        agentPushRejectedTotal: 0,
        agentTaskCompleted: 0,
        agentTaskFailed: 0,
        // no task activity on a fresh workspace → success rate is null (distinct from 100%).
        agentTaskSuccessRate: null,
      })
    }),
  )

  it.live("§D2 POST /oversight/rollback returns 404 for an UNKNOWN session (unknown-session branch)", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      // an unknown session id is indistinguishable from another tenant's → typed 404, never a
      // cross-workspace revert and never an untyped 500. (Security boundary: no cross-workspace rollback.)
      // This covers oversight.ts:112 (session not found → 404).
      const response = yield* HttpClientRequest.post("/oversight/rollback").pipe(
        directoryHeader(dir),
        HttpClientRequest.bodyJson({ sessionID: "ses_does_not_exist", reason: "test" }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(response.status).toBe(404)
    }),
  )

  it.live("§D2 POST /oversight/rollback refuses a REAL session owned by another workspace (key-mismatch branch)", () =>
    Effect.gen(function* () {
      // Two distinct workspaces, keyed by their routed directory (deriveWorkspaceKey resolves to the
      // directory in the single-user / directory-routed model). We seed a REAL session in workspace B,
      // then route a rollback request to workspace A targeting B's session id. Unlike the unknown-session
      // test above, the session EXISTS and is found — so this exercises the key-mismatch branch
      // (oversight.ts:117), the security boundary that refuses a destructive cross-tenant revert.
      const dirA = yield* tmpdirScoped({ git: true })
      const dirB = yield* tmpdirScoped({ git: true })

      // Seed a real session that BELONGS to workspace B (its directory == dirB → its workspace key == B).
      const createResp = yield* HttpClientRequest.post(SessionPaths.create).pipe(
        directoryHeader(dirB),
        HttpClientRequest.bodyJson({ title: "workspace B session" }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(createResp.status).toBe(200)
      const sessionB = (yield* createResp.json) as { id: string; directory: string; revert?: unknown }
      expect(sessionB.id.startsWith("ses_")).toBe(true)
      expect(sessionB.directory).toBe(dirB)

      // Attempt to roll back session B while routed to workspace A. The handler finds session B (global
      // by id), derives ITS key (B), compares to the routed key (A), and refuses: 404, not a revert.
      const rollbackResp = yield* HttpClientRequest.post("/oversight/rollback").pipe(
        directoryHeader(dirA),
        HttpClientRequest.bodyJson({ sessionID: sessionB.id, reason: "cross-tenant attempt" }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(rollbackResp.status).toBe(404)

      // Prove NO revert happened + NO audit row was written. A rollback that reached SessionRevert would
      // ALWAYS append an audit row (even a noop revert), bumping rollback_total. Since record() is strictly
      // downstream of revert() in the handler, rollback_total == 0 for BOTH workspaces proves the handler
      // returned at the key-mismatch check BEFORE invoking SessionRevert — no revert, no misleading
      // "reverted" audit fact. (Windowed wide to catch any row regardless of clock.)
      const now = Date.now()
      const metricsQuery = `?from=0&to=${now + 60_000}`
      const metricsB = yield* HttpClientRequest.get(`/oversight/metrics${metricsQuery}`).pipe(
        directoryHeader(dirB),
        HttpClient.execute,
      )
      expect(metricsB.status).toBe(200)
      expect((yield* metricsB.json) as Record<string, unknown>).toMatchObject({ rollbackTotal: 0 })

      const metricsA = yield* HttpClientRequest.get(`/oversight/metrics${metricsQuery}`).pipe(
        directoryHeader(dirA),
        HttpClient.execute,
      )
      expect(metricsA.status).toBe(200)
      expect((yield* metricsA.json) as Record<string, unknown>).toMatchObject({ rollbackTotal: 0 })

      // And session B itself is untouched: still retrievable in workspace B with no revert snapshot applied
      // (a real revert would have set its `revert` field).
      const getB = yield* HttpClientRequest.get(`${SessionPaths.list}/${sessionB.id}`).pipe(
        directoryHeader(dirB),
        HttpClient.execute,
      )
      expect(getB.status).toBe(200)
      const reloadedB = (yield* getB.json) as { id: string; revert?: unknown }
      expect(reloadedB.id).toBe(sessionB.id)
      expect(reloadedB.revert ?? null).toBeNull()
    }),
  )

  it.live("emits a sync fence header for fixed-workspace mutations", () =>
    Effect.gen(function* () {
      const originalWorkspaceID = Flag.DEEPAGENT_CODE_WORKSPACE_ID
      Flag.DEEPAGENT_CODE_WORKSPACE_ID = WorkspaceV2.ID.ascending()
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Flag.DEEPAGENT_CODE_WORKSPACE_ID = originalWorkspaceID
        }),
      )

      const dir = yield* tmpdirScoped({ git: true })
      const response = yield* HttpClientRequest.post(SessionPaths.create).pipe(
        directoryHeader(dir),
        HttpClientRequest.bodyJson({ title: "fenced" }),
        Effect.flatMap(HttpClient.execute),
      )

      expect(response.status).toBe(200)
      expect(JSON.parse(response.headers[FenceHeader] ?? "{}")).not.toEqual({})
    }),
  )

  it.live("does not emit sync fence headers for fixed-workspace reads or no-op mutations", () =>
    Effect.gen(function* () {
      const originalWorkspaceID = Flag.DEEPAGENT_CODE_WORKSPACE_ID
      Flag.DEEPAGENT_CODE_WORKSPACE_ID = WorkspaceV2.ID.ascending()
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Flag.DEEPAGENT_CODE_WORKSPACE_ID = originalWorkspaceID
        }),
      )

      const dir = yield* tmpdirScoped({ git: true })
      const read = yield* HttpClientRequest.get(InstancePaths.path).pipe(directoryHeader(dir), HttpClient.execute)
      const log = yield* HttpClientRequest.post(ControlPaths.log).pipe(
        directoryHeader(dir),
        HttpClientRequest.bodyJson({ service: "fence-test", level: "info", message: "noop" }),
        Effect.flatMap(HttpClient.execute),
      )

      expect(read.status).toBe(200)
      expect(read.headers[FenceHeader]).toBeUndefined()
      expect(log.status).toBe(200)
      expect(log.headers[FenceHeader]).toBeUndefined()
    }),
  )

  it.live("rejects malformed permission and question request ids", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const request = (path: string, init?: RequestInit) =>
        Effect.promise(() =>
          HttpApiApp.webHandler().handler(
            new Request(`http://localhost${path}`, {
              ...init,
              headers: { "x-deepagent-code-directory": dir, "content-type": "application/json", ...init?.headers },
            }),
            handlerContext,
          ),
        )
      const [permission, questionReply, questionReject] = yield* Effect.all(
        [
          request("/permission/invalid-permission-id/reply", {
            method: "POST",
            body: JSON.stringify({ reply: "once" }),
          }),
          request("/question/invalid-question-id/reply", {
            method: "POST",
            body: JSON.stringify({ answers: [["Yes"]] }),
          }),
          request("/question/invalid-question-id/reject", { method: "POST" }),
        ],
        { concurrency: "unbounded" },
      )

      expect(permission.status).toBe(400)
      expect(questionReply.status).toBe(400)
      expect(questionReject.status).toBe(400)
    }),
  )

  it.live("returns typed not found bodies for missing permission and question requests", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const request = (path: string, init?: RequestInit) =>
        Effect.promise(() =>
          HttpApiApp.webHandler().handler(
            new Request(`http://localhost${path}`, {
              ...init,
              headers: { "x-deepagent-code-directory": dir, "content-type": "application/json", ...init?.headers },
            }),
            handlerContext,
          ),
        )
      const permissionID = PermissionV1.ID.ascending()
      const questionReplyID = QuestionID.ascending()
      const questionRejectID = QuestionID.ascending()
      const [permission, questionReply, questionReject] = yield* Effect.all(
        [
          request(`/permission/${permissionID}/reply`, {
            method: "POST",
            body: JSON.stringify({ reply: "once" }),
          }),
          request(`/question/${questionReplyID}/reply`, {
            method: "POST",
            body: JSON.stringify({ answers: [["Yes"]] }),
          }),
          request(`/question/${questionRejectID}/reject`, { method: "POST" }),
        ],
        { concurrency: "unbounded" },
      )

      expect(permission.status).toBe(404)
      expect(yield* Effect.promise(() => permission.json())).toEqual({
        _tag: "PermissionNotFoundError",
        requestID: permissionID,
        message: `Permission request not found: ${permissionID}`,
      })
      expect(questionReply.status).toBe(404)
      expect(yield* Effect.promise(() => questionReply.json())).toEqual({
        _tag: "QuestionNotFoundError",
        requestID: questionReplyID,
        message: `Question request not found: ${questionReplyID}`,
      })
      expect(questionReject.status).toBe(404)
      expect(yield* Effect.promise(() => questionReject.json())).toEqual({
        _tag: "QuestionNotFoundError",
        requestID: questionRejectID,
        message: `Question request not found: ${questionRejectID}`,
      })
    }),
  )

  it.live("returns typed not found bodies for missing projects", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const projectID = ProjectV2.ID.make("project_missing")
      const response = yield* Effect.promise(() =>
        HttpApiApp.webHandler().handler(
          new Request(`http://localhost/project/${projectID}`, {
            method: "PATCH",
            headers: { "x-deepagent-code-directory": dir, "content-type": "application/json" },
            body: JSON.stringify({ name: "Missing" }),
          }),
          handlerContext,
        ),
      )

      expect(response.status).toBe(404)
      expect(yield* Effect.promise(() => response.json())).toEqual({
        _tag: "ProjectNotFoundError",
        projectID,
        message: `Project not found: ${projectID}`,
      })
    }),
  )

  it.live("serves path and VCS read endpoints", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(path.join(dir, "changed.txt"), "hello")

      const [paths, vcs, diff] = yield* Effect.all(
        [
          HttpClientRequest.get(InstancePaths.path).pipe(directoryHeader(dir), HttpClient.execute),
          HttpClientRequest.get(InstancePaths.vcs).pipe(directoryHeader(dir), HttpClient.execute),
          HttpClientRequest.get(InstancePaths.vcsDiff).pipe(
            HttpClientRequest.setUrlParam("mode", "git"),
            directoryHeader(dir),
            HttpClient.execute,
          ),
        ],
        { concurrency: "unbounded" },
      )

      expect(paths.status).toBe(200)
      expect(yield* paths.json).toMatchObject({ directory: dir, worktree: dir })

      expect(vcs.status).toBe(200)
      expect(yield* vcs.json).toMatchObject({ branch: expect.any(String) })

      expect(diff.status).toBe(200)
      expect(yield* diff.json).toContainEqual(
        expect.objectContaining({ file: "changed.txt", additions: 1, status: "added" }),
      )
    }),
  )
})
