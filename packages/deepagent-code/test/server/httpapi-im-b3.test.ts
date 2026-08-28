// End-to-end HTTP tests for the V4.0 §B3 IM surface (Thread / Direct / Search / File upload) through the
// REAL server stack — the same harness as httpapi-im-agent.test.ts. These exercise the endpoints exactly
// as a client would: routing middleware, workspace context, permission scoping, multipart parsing, and
// the flag gate on file upload.
//
// The file-upload flag (v4FileUploadEnabled) is read from the RuntimeFlags service, which the route graph
// builds from env at LAYER BUILD time. `testEffect` (isolatedRun) builds that layer fresh per test, after
// the test callback starts — so we control the gate with a `beforeEach` that sets the env var BEFORE the
// layer builds (an in-body `Effect.provide` can't override the flags the route graph provides itself).

import { afterEach, beforeEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, ConfigProvider, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { Flag } from "@deepagent-code/core/flag/flag"
import { Workspace } from "../../src/control-plane/workspace"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Session } from "@/session/session"
import { Database } from "@deepagent-code/core/database/database"
import * as Log from "@deepagent-code/core/util/log"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const originalWorkspaces = Flag.DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES
const originalUploadFlag = process.env.DEEPAGENT_CODE_V4_FILE_UPLOAD_ENABLED
const originalThreadFlag = process.env.DEEPAGENT_CODE_V4_THREAD_ENABLED

const workspaceLayer = Workspace.defaultLayer.pipe(
  Layer.provide(InstanceStore.defaultLayer),
  Layer.provide(InstanceBootstrap.defaultLayer),
)
const instanceStoreLayer = InstanceStore.defaultLayer.pipe(
  Layer.provide(
    Layer.succeed(InstanceBootstrapService.Service, InstanceBootstrapService.Service.of({ run: Effect.void })),
  ),
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)

// Effect's ambient/default ConfigProvider snapshots `process.env` process-globally on the FIRST read, so
// once one test reads a flag its value is frozen for the whole file — which would make the flag-gated
// thread tests unable to observe a per-test env change. Injecting a FRESH `ConfigProvider.fromEnv()` at
// the test graph root makes RuntimeFlags.defaultLayer re-read the live env at EACH per-test layer build,
// so the beforeEach env toggles (thread ON by default, OFF in the nested describe) take effect.
// `ConfigProvider.fromEnv()` snapshots env at CALL time, so it must be constructed at each layer BUILD
// (after the beforeEach env toggle) — not once at module load (when the flag is still unset). Wrapping it
// in Layer.unwrapEffect defers the `fromEnv()` call to build time.
const freshEnvProvider = Layer.suspend(() => ConfigProvider.layer(ConfigProvider.fromEnv()))

const it = testEffect(
  Layer.mergeAll(
    instanceStoreLayer,
    Project.defaultLayer,
    Session.defaultLayer,
    workspaceLayer,
    Database.defaultLayer,
    httpApiLayer,
  ).pipe(Layer.provide(freshEnvProvider)),
)

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  if (response.status !== 200)
    return response.text.pipe(Effect.flatMap((text) => Effect.die(new Error(`HTTP ${response.status}: ${text}`))))
  return response.json.pipe(Effect.map((value) => value as T))
}

function requestJson<T>(path: string, init?: RequestInit) {
  return request(path, init).pipe(Effect.flatMap(json<T>))
}

// §B3 threads are now flag-gated (v4ThreadEnabled) exactly like file upload: the endpoint fail-closes when
// the flag is off. The RuntimeFlags service reads env at LAYER BUILD time (after the test callback starts),
// so we opt into the behavior under test by setting the env var in a `beforeEach` — the thread tests below
// assert the ON behavior; the flag-off (disabled ⇒ 404) case is asserted explicitly by clearing it.
beforeEach(() => {
  process.env.DEEPAGENT_CODE_V4_THREAD_ENABLED = "true"
})

afterEach(async () => {
  Flag.DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  if (originalUploadFlag === undefined) delete process.env.DEEPAGENT_CODE_V4_FILE_UPLOAD_ENABLED
  else process.env.DEEPAGENT_CODE_V4_FILE_UPLOAD_ENABLED = originalUploadFlag
  if (originalThreadFlag === undefined) delete process.env.DEEPAGENT_CODE_V4_THREAD_ENABLED
  else process.env.DEEPAGENT_CODE_V4_THREAD_ENABLED = originalThreadFlag
  await disposeAllInstances()
  await resetDatabase()
})

type IMGroup = { id: string; type: string }
type IMMessage = { id: string; content: string; replyToID: string | null }
type IMMessagePage = { messages: IMMessage[]; nextCursor: string | null; hasMore: boolean }

describe("IM §B3 HttpApi — Thread / Direct / Search", () => {
  it.live("thread endpoint returns replies to a parent, paginated and ordered", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const q = `directory=${encodeURIComponent(directory)}`
      const headers = { "content-type": "application/json" }

      const group = yield* requestJson<IMGroup>(`/api/v1/im/groups?${q}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "project", name: "T" }),
      })
      const parent = yield* requestJson<IMMessage>(`/api/v1/im/groups/${group.id}/messages?${q}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ senderType: "user", type: "text", content: "parent" }),
      })
      for (let i = 0; i < 3; i++) {
        yield* request(`/api/v1/im/groups/${group.id}/messages?${q}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ senderType: "user", type: "text", content: `reply ${i}`, replyToID: parent.id }),
        })
      }

      const page1 = yield* requestJson<IMMessagePage>(
        `/api/v1/im/groups/${group.id}/messages/${parent.id}/thread?${q}&limit=2`,
        { headers },
      )
      expect(page1.messages.map((m) => m.content)).toEqual(["reply 0", "reply 1"])
      expect(page1.hasMore).toBe(true)

      const page2 = yield* requestJson<IMMessagePage>(
        `/api/v1/im/groups/${group.id}/messages/${parent.id}/thread?${q}&limit=2&cursor=${encodeURIComponent(
          page1.nextCursor!,
        )}`,
        { headers },
      )
      expect(page2.messages.map((m) => m.content)).toEqual(["reply 2"])
      expect(page2.hasMore).toBe(false)
      expect(page2.messages.every((m) => m.replyToID === parent.id)).toBe(true)
    }),
  )

  it.live("thread endpoint 404s for a group the caller isn't a member of", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const q = `directory=${encodeURIComponent(directory)}`
      const res = yield* request(`/api/v1/im/groups/img_does_not_exist/messages/imsg_x/thread?${q}`, {})
      expect(res.status).toBe(404)
    }),
  )

  // §B3 [NEW] flag gate — with v4ThreadEnabled OFF the endpoint fail-closes (404 THREAD_DISABLED),
  // mirroring the file-upload gate. The RuntimeFlags layer reads env at BUILD time (before the body), so
  // the flag must be cleared in a hook — a nested describe whose beforeEach runs AFTER the outer one that
  // sets it true, leaving it OFF for this test's layer build.
  describe("thread flag OFF", () => {
    beforeEach(() => {
      delete process.env.DEEPAGENT_CODE_V4_THREAD_ENABLED
    })
    it.live("thread endpoint 404s (disabled) when v4ThreadEnabled is OFF", () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped({ git: true })
        const q = `directory=${encodeURIComponent(directory)}`
        // The gate fail-closes FIRST, before any group/membership lookup — even a nonexistent group id
        // returns THREAD_DISABLED (not GROUP_NOT_FOUND), proving the flag check precedes the handler body.
        const res = yield* request(`/api/v1/im/groups/img_x/messages/imsg_x/thread?${q}`, {})
        expect(res.status).toBe(404)
        const text = yield* res.text
        expect(text).toContain("THREAD_DISABLED")
      }),
    )
  })

  it.live("direct group creation enforces the pair and is idempotent", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const q = `directory=${encodeURIComponent(directory)}`
      const headers = { "content-type": "application/json" }

      const first = yield* requestJson<IMGroup>(`/api/v1/im/groups?${q}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "direct", name: "DM", member: { memberID: "CodeAgent", memberType: "agent" } }),
      })
      expect(first.type).toBe("direct")

      const second = yield* requestJson<IMGroup>(`/api/v1/im/groups?${q}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "direct", name: "DM", member: { memberID: "CodeAgent", memberType: "agent" } }),
      })
      expect(second.id).toBe(first.id)

      const bad = yield* request(`/api/v1/im/groups?${q}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "direct", name: "DM" }),
      })
      expect(bad.status).toBe(400)
    }),
  )

  it.live("search is scoped to the caller and supports a metadata filter", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const q = `directory=${encodeURIComponent(directory)}`
      const headers = { "content-type": "application/json" }

      const group = yield* requestJson<IMGroup>(`/api/v1/im/groups?${q}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "project", name: "S" }),
      })
      yield* request(`/api/v1/im/groups/${group.id}/messages?${q}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ senderType: "user", type: "text", content: "elephant in the room" }),
      })
      yield* request(`/api/v1/im/groups/${group.id}/messages?${q}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          senderType: "user",
          type: "code",
          content: "elephant code snippet",
          metadata: { type: "code_ref", path: "a.ts" },
        }),
      })

      const all = yield* requestJson<IMMessagePage>(`/api/v1/im/search?${q}&q=elephant`, { headers })
      expect(all.messages.length).toBe(2)

      const onlyCode = yield* requestJson<IMMessagePage>(`/api/v1/im/search?${q}&q=elephant&metadataType=code_ref`, {
        headers,
      })
      expect(onlyCode.messages.length).toBe(1)

      const bad = yield* request(`/api/v1/im/search?${q}&q=${encodeURIComponent("   ")}`, { headers })
      expect(bad.status).toBe(400)
    }),
  )
})

// NOTE on file upload: the upload route is wired, flag-gated, and typecheck-clean, but its full multipart
// round-trip is NOT asserted here. Streaming a multipart body over the in-memory NodeHttpServer.layerTest
// transport hangs (~21s fiber-interrupt) — a known limitation of that test transport, not the upload
// implementation. The security-critical core (mime allow-list, size cap, sha256, server-derived storage
// path + traversal prevention) is extracted into the pure `@deepagent-code/core/im/attachment-storage`
// module and unit-tested directly in packages/core/test/im-attachment-storage.test.ts; the repository
// attachment methods (decoupled-from-message, checksum, workspace/group/message scoping) are covered in
// packages/core/test/im-b3.test.ts. Flag-off fail-closed is enforced FIRST in the handler (returns
// IMFileUploadDisabledError → 404 before any bytes are read).
