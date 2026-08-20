import { describe, expect } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Context, Effect, Fiber, Layer, Option, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { ChildProcessSpawner } from "effect/unstable/process"
import { eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { DeepAgentEventTable } from "@deepagent-code/core/deepagent/deepagent-event-sql"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
import { readPinnedPacks, writePinnedPacks } from "@deepagent-code/core/deepagent/pinned-packs"
import { Flag } from "@deepagent-code/core/flag/flag"
import {
  packChangedIdempotencyKey,
  publishPackChanged,
} from "../../src/server/routes/instance/httpapi/handlers/deepagent"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { ServerAuth } from "../../src/server/auth"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// FEAT-003 — pack.changed eventing for packsPin/packsUnpin. Runs the REAL publish path
// (publishPackChanged, the exact seam the handlers call after committing the pinned-set file)
// against the REAL §A2 bus over an in-memory database — the same fixture pattern as
// packages/core/test/deepagent-event-bus.test.ts.

let clock = 0
const now = () => clock++

const database = Database.layerFromPath(":memory:")
const busLayer = DeepAgentEventBus.layerWith({ now }).pipe(Layer.provideMerge(database))
const it = testEffect(busLayer)

const WORKSPACE = "/tmp/workspace-a"

const collectPackEvents = (bus: DeepAgentEventBus.Interface) =>
  Stream.runCollect(bus.replay({ from: 0, type: LMNEvents.PACK_CHANGED })).pipe(Effect.map((c) => Array.from(c)))

describe("FEAT-003 pack.changed (pin/unpin eventing)", () => {
  it.effect("pin publishes pack.changed with the after-write payload + set-hash idempotency key", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      // Mirror the handler flow: file write first, then publish with the authoritative after-write set.
      const memoryDir = mkdtempSync(path.join(tmpdir(), "packs-events-"))
      writePinnedPacks(memoryDir, ["pack-b", "pack-a"])
      yield* publishPackChanged(bus, {
        workspacePath: WORKSPACE,
        packId: "pack-a",
        action: "pin",
        pinnedIds: readPinnedPacks(memoryDir),
      })

      const events = yield* collectPackEvents(bus)
      expect(events.length).toBe(1)
      const event = events[0]!
      expect(event.type).toBe(LMNEvents.PACK_CHANGED) // type
      expect(event.source).toBe("system")
      expect(event.workspaceID).toBe(WORKSPACE)
      expect(event.priority).toBe("normal")
      // payload: workspacePath / packId / action / pinnedIds (the after-write set, deduped + sorted)
      expect(event.payload).toEqual({
        workspacePath: WORKSPACE,
        packId: "pack-a",
        action: "pin",
        pinnedIds: ["pack-a", "pack-b"],
      })
      // idempotency key = workspace-scoped hash of the after-write set (+ action discriminator)
      expect(event.idempotencyKey).toBe(
        packChangedIdempotencyKey({ workspacePath: WORKSPACE, action: "pin", pinnedIds: ["pack-a", "pack-b"] }),
      )
    }),
  )

  it.effect("unpinning the LAST pack still publishes (empty after-write set)", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      yield* publishPackChanged(bus, {
        workspacePath: WORKSPACE,
        packId: "pack-solo",
        action: "unpin",
        pinnedIds: [], // the after-write set of an unpin of the last pinned pack
      })

      const events = yield* collectPackEvents(bus)
      expect(events.length).toBe(1)
      const event = events[0]!
      expect(event.type).toBe(LMNEvents.PACK_CHANGED)
      expect(event.payload).toEqual({
        workspacePath: WORKSPACE,
        packId: "pack-solo",
        action: "unpin",
        pinnedIds: [],
      })
      // the empty set still yields a stable, publishable key — distinct from any pin key
      expect(event.idempotencyKey).toBe(
        packChangedIdempotencyKey({ workspacePath: WORKSPACE, action: "unpin", pinnedIds: [] }),
      )
      expect(event.idempotencyKey).not.toBe(
        packChangedIdempotencyKey({ workspacePath: WORKSPACE, action: "pin", pinnedIds: [] }),
      )
    }),
  )

  it.effect("repeated pin leaving the SAME after-write set does not re-publish (§A3 key dedupe)", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const input = {
        workspacePath: WORKSPACE,
        packId: "pack-a",
        action: "pin" as const,
        pinnedIds: ["pack-a", "pack-b"],
      }
      // first click publishes; a duplicate click (double-click / retried request) resolves to the
      // same after-write set ⇒ same idempotency key ⇒ the bus returns the existing event, no new row.
      yield* publishPackChanged(bus, input)
      yield* publishPackChanged(bus, input)
      yield* publishPackChanged(bus, { ...input, pinnedIds: ["pack-b", "pack-a", "pack-a"] }) // order/dupes vary

      const events = yield* collectPackEvents(bus)
      expect(events.length).toBe(1)
      // and live subscribers see exactly ONE delivery too
    }),
  )

  it.effect("idempotency key is stable under set order/duplication, scoped by workspace + action", () =>
    Effect.gen(function* () {
      const base = packChangedIdempotencyKey({ workspacePath: WORKSPACE, action: "pin", pinnedIds: ["a", "b"] })
      // same set, different order/duplication ⇒ same key
      expect(
        packChangedIdempotencyKey({ workspacePath: WORKSPACE, action: "pin", pinnedIds: ["b", "a", "a"] }),
      ).toBe(base)
      // different workspace / action / set ⇒ different keys (no cross-workspace or cross-action swallow)
      expect(
        packChangedIdempotencyKey({ workspacePath: "/tmp/workspace-b", action: "pin", pinnedIds: ["a", "b"] }),
      ).not.toBe(base)
      expect(
        packChangedIdempotencyKey({ workspacePath: WORKSPACE, action: "unpin", pinnedIds: ["a", "b"] }),
      ).not.toBe(base)
      expect(
        packChangedIdempotencyKey({ workspacePath: WORKSPACE, action: "pin", pinnedIds: ["a", "b", "c"] }),
      ).not.toBe(base)
    }),
  )

  it.effect("pack.changed is subscribable — a live type-filtered subscriber receives it", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const fiber = yield* bus
        .subscribe({ type: LMNEvents.PACK_CHANGED })
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      yield* publishPackChanged(bus, {
        workspacePath: WORKSPACE,
        packId: "pack-a",
        action: "pin",
        pinnedIds: ["pack-a"],
      })
      const received = Array.from(yield* Fiber.join(fiber))
      expect(received.length).toBe(1)
      expect(received[0]!.type).toBe(LMNEvents.PACK_CHANGED)
      expect((received[0]!.payload as { packId: string }).packId).toBe("pack-a")
    }),
  )
})

// END-TO-END: the full production route tree (same harness as httpapi-instance.test.ts) — proves the
// handler layer ACTUALLY obtains DeepAgentEventBus.Service and the event lands in the durable log.
const e2eStateLayer = Layer.effectDiscard(
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
const e2eRoutes = HttpRouter.serve(HttpApiApp.routes, { disableListenLog: true, disableLogger: true }).pipe(
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
  Layer.provide(ServerAuth.Config.layer({ password: Option.none(), username: "deepagent-code" })),
)
const itE2e = testEffect(
  Layer.mergeAll(
    e2eStateLayer,
    // same proven harness as httpapi-instance.test.ts; the cast silences serve()'s generic noise and
    // keeps the two services the test body actually draws (HttpClient + the spawner tmpdirScoped needs).
    e2eRoutes as unknown as Layer.Layer<
      HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner,
      never,
      never
    >,
  ),
)

const directoryHeader = (dir: string) => HttpClientRequest.setHeader("x-deepagent-code-directory", dir)

describe("FEAT-003 pack.changed end-to-end (full route tree)", () => {
  itE2e.live(
    "packsPin/packsUnpin publish pack.changed durably; a duplicate pin does not re-publish",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        const call = (route: string, packId: string) =>
          HttpClientRequest.post(route).pipe(
            directoryHeader(dir),
            HttpClientRequest.bodyJson({ packId }),
            Effect.flatMap(HttpClient.execute),
          )

        const pin1 = yield* call("/deepagent/packs/pin", "feat-003-pack")
        expect(pin1.status).toBe(200)
        // duplicate click: same after-write set ⇒ same idempotency key ⇒ bus no-op
        const pin2 = yield* call("/deepagent/packs/pin", "feat-003-pack")
        expect(pin2.status).toBe(200)
        // unpinning the LAST pack must still emit
        const unpin = yield* call("/deepagent/packs/unpin", "feat-003-pack")
        expect(unpin.status).toBe(200)

        // Observe the durable log through a connection to the SAME db file the server uses.
        const { db } = yield* Database.layerFromPath(Database.path()).pipe(
          Layer.build,
          Effect.map((ctx) => Context.get(ctx, Database.Service)),
        )
        const rows = yield* db
          .select()
          .from(DeepAgentEventTable)
          .where(eq(DeepAgentEventTable.type, LMNEvents.PACK_CHANGED))
          .all()
          .pipe(Effect.orDie)
        expect(rows.length).toBe(2) // pin + unpin; the duplicate pin was deduped on the idempotency key
        const pin = rows.find((r) => (r.payload as { action: string }).action === "pin")!
        const last = rows.find((r) => (r.payload as { action: string }).action === "unpin")!
        expect(pin.idempotency_key).toBe(
          packChangedIdempotencyKey({ workspacePath: dir, action: "pin", pinnedIds: ["feat-003-pack"] }),
        )
        expect(pin.payload).toEqual({
          workspacePath: dir,
          packId: "feat-003-pack",
          action: "pin",
          pinnedIds: ["feat-003-pack"],
        })
        expect(last.idempotency_key).toBe(
          packChangedIdempotencyKey({ workspacePath: dir, action: "unpin", pinnedIds: [] }),
        )
        expect((last.payload as { pinnedIds: string[] }).pinnedIds).toEqual([])
      }),
    30_000,
  )
})
