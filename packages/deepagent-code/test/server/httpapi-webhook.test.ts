// End-to-end HTTP tests for the V4.0 §A1 EXTERNAL WEBHOOK INGRESS (git / ci / pr / monitor) through the
// REAL server stack — the same harness as httpapi-im-b3.test.ts. These exercise the endpoints exactly as
// an external caller would: Authorization + WorkspaceRouting + InstanceContext middleware, input schema
// validation, and the §E2-gated `tryPublish` onto the DeepAgent Event Bus.
//
// The server persists events into the file-backed DB (Database.defaultLayer, keyed by path); the test
// reads them back via a bus `replay` over the SAME DB to assert the published event's type/source/
// idempotencyKey. A duplicate delivery (same deliveryId → same deterministic idempotencyKey) must dedupe
// to ONE persisted event (§A3 幂等). The §E2 rate-limit drop path is asserted at the handler-composition
// level (bus.tryPublish with a 0 limit → dropped → ackOf → a non-error 202-shaped ack), plus the pure
// idempotency-key derivation is unit-tested directly.

import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, ConfigProvider, Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { Flag } from "@deepagent-code/core/flag/flag"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { Workspace } from "../../src/control-plane/workspace"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import {
  ackOf,
  deriveIdempotencyKey,
} from "../../src/server/routes/instance/httpapi/handlers/webhook"
import { Session } from "@/session/session"
import { Database } from "@deepagent-code/core/database/database"
import * as Log from "@deepagent-code/core/util/log"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const originalWorkspaces = Flag.DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES

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

// V4.1 — pin v4MultiAgentRuntime OFF for this file. It tests the §A1 INGRESS + persistence contract (the
// endpoint persists exactly the webhook event, deterministic key, dedup), NOT the dispatch runtime. With
// the runtime ON (the new production default), the EventDispatcher daemon inside the server graph would
// consume each ingested event, the §E1 security gate would BLOCK the untrusted external source
// (git/ci/pr/monitor — by design), and each block would publish a system `agent.task.blocked` fact into
// the SAME workspace log — so `replayAll` would see those extra events and the "exactly the four webhook
// events" assertion (and the TestClock-driven rate-limit case) would break on runtime behaviour this file
// does not test. The daemon reads the flag from RuntimeFlags.defaultLayer DEEP inside the server graph, so
// an outer Layer.provide override does NOT reach it — set the env var + inject a fresh ConfigProvider
// (snapshotting env at BUILD time) so the deep default re-reads the pinned value. The runtime's own
// consume/block behaviour is covered by the event-dispatcher / multi-agent-runtime suites.
// Pin the flag via an injected ConfigProvider built from a COPY of process.env with the one key
// overridden, so RuntimeFlags.defaultLayer — which reads from the ambient Effect ConfigProvider deep
// inside the server graph — resolves v4MultiAgentRuntime to false for THIS test's layer scope only.
// Crucially this does NOT write the global process.env (bun loads all test-file modules up-front, so a
// top-level env write would leak the pinned value into other files that snapshot env). Built inside
// Layer.suspend so the env copy is taken at BUILD time.
const pinnedFlagProvider = Layer.suspend(() =>
  ConfigProvider.layer(
    ConfigProvider.fromEnv({
      env: { ...(process.env as Record<string, string>), DEEPAGENT_CODE_V4_MULTI_AGENT_RUNTIME: "false" },
    }),
  ),
)

// The bus over the SAME file-backed DB the server writes to — used to replay + assert persisted events.
const it = testEffect(
  Layer.mergeAll(
    instanceStoreLayer,
    Project.defaultLayer,
    Session.defaultLayer,
    workspaceLayer,
    Database.defaultLayer,
    DeepAgentEventBus.defaultLayer,
    httpApiLayer,
  ).pipe(Layer.provide(pinnedFlagProvider)),
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

// All events published by the ingress for a workspace (durable replay from time 0).
const replayAll = (workspaceID: string) =>
  DeepAgentEventBus.Service.pipe(
    Effect.flatMap((bus) =>
      bus.replay({ workspaceID, from: 0 }).pipe(Stream.runCollect, Effect.map((c) => Array.from(c))),
    ),
  )

type Ack = {
  accepted: boolean
  dropped: boolean
  eventID?: string
  idempotencyKey?: string
  type: string
}

afterEach(async () => {
  Flag.DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

describe("Webhook §A1 ingress — git / ci / pr / monitor", () => {
  it.live("each endpoint (authenticated) publishes an event of the right type/source with a deterministic key", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const q = `directory=${encodeURIComponent(directory)}`
      const headers = { "content-type": "application/json" }

      const git = yield* requestJson<Ack>(`/api/v1/webhook/git?${q}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ repo: "acme/app", branch: "main", commit: "abc123", actor: "alice", deliveryId: "d1" }),
      })
      expect(git.accepted).toBe(true)
      expect(git.dropped).toBe(false)
      expect(git.type).toBe("git.push")
      expect(git.idempotencyKey).toBe(deriveIdempotencyKey("git", ["git.push", "acme/app", "abc123", "d1"]))

      const ci = yield* requestJson<Ack>(`/api/v1/webhook/ci?${q}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ repo: "acme/app", commit: "abc123", pipeline: "build", deliveryId: "c1" }),
      })
      expect(ci.type).toBe("ci.failure")
      expect(ci.accepted).toBe(true)

      const pr = yield* requestJson<Ack>(`/api/v1/webhook/pr?${q}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ repo: "acme/app", prNumber: 7, comment: "please fix", actor: "bob", deliveryId: "p1" }),
      })
      expect(pr.type).toBe("pr.comment")

      const monitor = yield* requestJson<Ack>(`/api/v1/webhook/monitor?${q}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "latency spike", severity: "warning", category: "latency", deliveryId: "m1" }),
      })
      expect(monitor.type).toBe("monitor.alert")

      // The durable log holds exactly the four events, one per source, with the acked ids/keys.
      const events = yield* replayAll(directory)
      const bySource = new Map(events.map((e) => [e.source, e]))
      expect(bySource.get("git")?.type).toBe("git.push")
      expect(bySource.get("ci")?.type).toBe("ci.failure")
      expect(bySource.get("pr")?.type).toBe("pr.comment")
      expect(bySource.get("monitor")?.type).toBe("monitor.alert")
      expect(bySource.get("git")?.idempotencyKey).toBe(git.idempotencyKey)
      expect(bySource.get("git")?.actorID).toBe("alice")
      // §E1 note: all four are non-first-party sources (git/ci/pr/monitor) — persisted + traceable here,
      // but BLOCKED at dispatch until an operator opts the source into the workspace trustedSources.
      expect(events.every((e) => ["git", "ci", "pr", "monitor"].includes(e.source))).toBe(true)
    }),
  )

  it.live("a duplicate delivery (same deliveryId) dedupes to one persisted event (§A3 幂等)", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const q = `directory=${encodeURIComponent(directory)}`
      const headers = { "content-type": "application/json" }
      const body = JSON.stringify({ repo: "acme/app", branch: "main", commit: "sha9", actor: "carol", deliveryId: "dup" })

      const first = yield* requestJson<Ack>(`/api/v1/webhook/git?${q}`, { method: "POST", headers, body })
      const second = yield* requestJson<Ack>(`/api/v1/webhook/git?${q}`, { method: "POST", headers, body })

      // Same deterministic key → the second publish is an idempotent no-op returning the same event.
      expect(second.idempotencyKey).toBe(first.idempotencyKey)
      expect(second.eventID).toBe(first.eventID)

      const events = yield* replayAll(directory)
      const pushes = events.filter((e) => e.type === "git.push")
      expect(pushes.length).toBe(1)
    }),
  )

  it.effect("the §E2 rate-limit drop path yields a non-error 202-shaped ack (never a 500)", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      // Force a tiny ceiling (limit 1) so the SECOND normal-priority publish in the window is shed. The
      // limiter admits the first hit (fresh bucket) then drops once count ≥ limit — so the first publish
      // is admitted and the second returns { dropped: "rate_limited" }, exercising the shed path.
      const first = yield* bus.tryPublish(
        {
          type: "git.push",
          source: "git",
          workspaceID: "ws-drop",
          idempotencyKey: "git:drop-1",
          priority: "normal",
          payload: { repo: "r", commit: "c" },
        },
        { limit: 1 },
      )
      expect("published" in first).toBe(true)
      const dropped = yield* bus.tryPublish(
        {
          type: "git.push",
          source: "git",
          workspaceID: "ws-drop",
          idempotencyKey: "git:drop-2",
          priority: "normal",
          payload: { repo: "r", commit: "c2" },
        },
        { limit: 1 },
      )
      expect("dropped" in dropped).toBe(true)

      // The handler maps that drop to accepted:false/dropped:true — a 202-shaped ack, NOT an error/500.
      const ack = ackOf("git.push", dropped)
      expect(ack).toEqual({ accepted: false, dropped: true, type: "git.push" })

      // And a high-priority event bypasses the ceiling entirely (never shed).
      const admitted = yield* bus.tryPublish(
        {
          type: "monitor.alert",
          source: "monitor",
          workspaceID: "ws-drop",
          idempotencyKey: "monitor:pass-1",
          priority: "high",
          payload: { title: "outage" },
        },
        { limit: 0 },
      )
      expect("published" in admitted).toBe(true)
    }),
  )
})

describe("Webhook §A1 ingress — pure helpers", () => {
  it.effect("deriveIdempotencyKey is deterministic per delivery and distinct across deliveries", () =>
    Effect.sync(() => {
      const a = deriveIdempotencyKey("git", ["git.push", "acme/app", "sha1", "d1"])
      const aAgain = deriveIdempotencyKey("git", ["git.push", "acme/app", "sha1", "d1"])
      const b = deriveIdempotencyKey("git", ["git.push", "acme/app", "sha1", "d2"])
      expect(a).toBe(aAgain)
      expect(a).not.toBe(b)
      expect(a.startsWith("git:")).toBe(true)
    }),
  )

  it.effect("deriveIdempotencyKey has no field-boundary ambiguity (JSON serialization)", () =>
    Effect.sync(() => {
      // (a) boundary ambiguity: a delimiter-join would hash `["a b","c"]` and `["a","b c"]` identically
      // (both "a b c"), wrongly collapsing two DISTINCT deliveries. JSON serialization keeps them apart.
      const split1 = deriveIdempotencyKey("git", ["git.push", "a b", "c"])
      const split2 = deriveIdempotencyKey("git", ["git.push", "a", "b c"])
      expect(split1).not.toBe(split2)

      // (b) all-optional fallback: two deliveries sharing only the required field (rest absent) must not
      // collide — `null` (absent) is distinct from the presence of a value.
      const onlyRequired = deriveIdempotencyKey("ci", ["ci.failure", "acme/app", undefined, undefined])
      const withPipeline = deriveIdempotencyKey("ci", ["ci.failure", "acme/app", "build", undefined])
      expect(onlyRequired).not.toBe(withPipeline)

      // determinism preserved: the SAME delivery still hashes to the SAME key (dedupe intact).
      const again = deriveIdempotencyKey("git", ["git.push", "a b", "c"])
      expect(again).toBe(split1)
    }),
  )

  it.effect("ackOf maps published / dropped / busError to distinct, non-throwing acks", () =>
    Effect.sync(() => {
      const published = ackOf("git.push", {
        published: {
          id: DeepAgentEvent.ID.make("dae_x"),
          type: "git.push",
          source: "git",
          workspaceID: "w",
          idempotencyKey: "git:k",
          priority: "normal",
          createdAt: 1,
          payload: {},
        },
      })
      expect(published.accepted).toBe(true)
      expect(published.dropped).toBe(false)
      expect(published.type).toBe("git.push")
      expect(published.eventID as string).toBe("dae_x")
      expect(published.idempotencyKey).toBe("git:k")

      const droppedAck = ackOf("ci.failure", { dropped: "rate_limited" })
      expect(droppedAck.accepted).toBe(false)
      expect(droppedAck.dropped).toBe(true)
      expect(droppedAck.type).toBe("ci.failure")
      expect("eventID" in droppedAck).toBe(false)
    }),
  )
})
