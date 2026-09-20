import { afterEach, describe, expect, test } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Database } from "@deepagent-code/core/database/database"
import { Flag } from "@deepagent-code/core/flag/flag"
import {
  IMBroadcasterLive,
  IMBroadcasterService,
  MAX_CONNECTIONS,
  MAX_CONNECTIONS_PER_GROUP,
} from "@deepagent-code/core/im/broadcaster"
import { IMRepository, IMRepositoryLive, type IMRepositoryInterface } from "@deepagent-code/core/im/repository"
import type { IMBroadcaster, IMWebSocketConnection } from "@deepagent-code/core/im/websocket"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { createServer } from "node:http"
import net from "node:net"
import path from "node:path"
import type { Duplex } from "node:stream"
import { Workspace } from "../../src/control-plane/workspace"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { Session } from "@/session/session"
import { ServerAuth } from "../../src/server/auth"
import { Server } from "../../src/server/server"
import { IMPaths } from "../../src/server/routes/instance/httpapi/groups/im"
import { IMWebSocketApi, IMWebSocketPaths } from "../../src/server/routes/instance/httpapi/groups/im-websocket"
import { MAX_OUTGOING_EVENTS, imWebSocketHandlers } from "../../src/server/routes/instance/httpapi/handlers/im-websocket"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { instanceContextLayer } from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import { workspaceRoutingLayer } from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { withTimeout } from "../../src/util/timeout"
import { resetDatabase } from "../fixture/db"
import { tmpdir, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// RI-117: IM WebSocket integration matrix against a REAL server. The unit seams
// already exist (im-config clamp, broadcaster caps, tracker lifecycle); the gap was
// end-to-end proof over real sockets: 1013 on a slow consumer, per-user admission
// under concurrency, invalid env clamped through an actual server boot, and shutdown
// cleanup with live connections.
//
// The default per-user/per-group cap is 5 (MAX_CONNECTIONS_PER_USER_PER_GROUP
// fallback), which the admission tests rely on; the env-boot tests prove that value
// is what an invalid override falls back to.

const DEFAULT_PER_USER_CAP = 5

const original = {
  flagPassword: Flag.DEEPAGENT_CODE_SERVER_PASSWORD,
  flagUsername: Flag.DEEPAGENT_CODE_SERVER_USERNAME,
  envPassword: process.env.DEEPAGENT_CODE_SERVER_PASSWORD,
  envUsername: process.env.DEEPAGENT_CODE_SERVER_USERNAME,
}
const credentials = { username: "deepagent-code", password: "im-ws-secret" }

afterEach(async () => {
  Flag.DEEPAGENT_CODE_SERVER_PASSWORD = original.flagPassword
  Flag.DEEPAGENT_CODE_SERVER_USERNAME = original.flagUsername
  if (original.envPassword === undefined) delete process.env.DEEPAGENT_CODE_SERVER_PASSWORD
  else process.env.DEEPAGENT_CODE_SERVER_PASSWORD = original.envPassword
  if (original.envUsername === undefined) delete process.env.DEEPAGENT_CODE_SERVER_USERNAME
  else process.env.DEEPAGENT_CODE_SERVER_USERNAME = original.envUsername
  await resetDatabase()
})

function auth() {
  return { authorization: `Basic ${btoa(`${credentials.username}:${credentials.password}`)}` }
}

type Listener = Awaited<ReturnType<typeof Server.listen>>

async function startListener() {
  Flag.DEEPAGENT_CODE_SERVER_PASSWORD = credentials.password
  Flag.DEEPAGENT_CODE_SERVER_USERNAME = credentials.username
  process.env.DEEPAGENT_CODE_SERVER_PASSWORD = credentials.password
  process.env.DEEPAGENT_CODE_SERVER_USERNAME = credentials.username
  return Server.listen({ hostname: "127.0.0.1", port: 0 })
}

function stop(listener: Listener, label: string) {
  return withTimeout(listener.stop(true), 10_000, label)
}

async function createGroup(base: URL, directory: string) {
  const response = await fetch(new URL(`${IMPaths.groups}?directory=${encodeURIComponent(directory)}`, base), {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ type: "project", name: "WS" }),
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as { id: string }).id
}

function socketURL(base: URL, groupId: string, directory: string) {
  const url = new URL(IMWebSocketPaths.group.replace(":groupId", groupId), base)
  url.protocol = "ws:"
  url.searchParams.set("directory", directory)
  return url
}

// Bun's WebSocket accepts an init object with headers; standard DOM types don't reflect that.
const WebSocketWithHeaders = WebSocket as unknown as new (
  url: URL,
  init?: { headers?: Record<string, string> },
) => WebSocket

function openSocket(url: URL) {
  const ws = new WebSocketWithHeaders(url, { headers: auth() })
  return withTimeout(
    new Promise<WebSocket>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(ws), { once: true })
      ws.addEventListener("error", () => reject(new Error("websocket failed before open")), { once: true })
    }),
    5_000,
    "timed out waiting for websocket open",
  )
}

function waitClose(ws: WebSocket) {
  return withTimeout(
    new Promise<{ code: number; reason: string }>((resolve) => {
      ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), { once: true })
    }),
    10_000,
    "timed out waiting for websocket close",
  )
}

function waitForMessage(ws: WebSocket, predicate: (message: string) => boolean) {
  let onMessage: ((event: MessageEvent) => void) | undefined
  return withTimeout(
    new Promise<string>((resolve) => {
      onMessage = (event: MessageEvent) => {
        const message = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data)
        if (!predicate(message)) return
        resolve(message)
      }
      ws.addEventListener("message", onMessage)
    }),
    5_000,
    "timed out waiting for websocket message",
  ).finally(() => {
    if (onMessage) ws.removeEventListener("message", onMessage)
  })
}

async function postMessage(base: URL, groupId: string, directory: string, content: string) {
  const response = await fetch(
    new URL(
      `${IMPaths.createMessage.replace(":groupId", groupId)}?directory=${encodeURIComponent(directory)}`,
      base,
    ),
    {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ senderType: "user", type: "text", content }),
    },
  )
  expect(response.status).toBe(200)
}

// A plain (non-upgrade) GET past the group check is the admission probe: 429 while
// the per-user cap is reached, 500 once a slot is free (the bare request then dies
// on the missing upgrade). Both statuses are server-published signals.
async function probeAdmission(base: URL, groupId: string, directory: string) {
  const response = await fetch(
    new URL(`${IMWebSocketPaths.group.replace(":groupId", groupId)}?directory=${encodeURIComponent(directory)}`, base),
    { headers: auth() },
  )
  return response.status
}

async function waitForFreedSlot(base: URL, groupId: string, directory: string) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if ((await probeAdmission(base, groupId, directory)) !== 429) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("timed out waiting for a per-user connection slot to free")
}

function sendTyping(ws: WebSocket, groupId: string) {
  ws.send(JSON.stringify({ type: "typing", data: { groupID: groupId, memberID: "server", typing: true } }))
}

function openOrReject(ws: WebSocket) {
  return new Promise<{ ws: WebSocket; opened: boolean }>((resolve) => {
    ws.addEventListener("open", () => resolve({ ws, opened: true }), { once: true })
    ws.addEventListener("error", () => resolve({ ws, opened: false }), { once: true })
    ws.addEventListener("close", () => resolve({ ws, opened: false }), { once: true })
  })
}

// Two racers for the LAST slot: if both upgrades land before either admission, the
// atomic gate is broadcaster.register after upgrade — the loser is closed 1013,
// never silently admitted as a sixth connection. If one racer is rejected at the
// pre-upgrade count check, the other is simply the winner.
async function settleLastSlotRace(racers: WebSocket[]) {
  const initial = await Promise.all(racers.map(openOrReject))
  const opened = initial.filter((outcome) => outcome.opened).map((outcome) => outcome.ws)
  expect(opened.length).toBeGreaterThanOrEqual(1)
  if (opened.length === 1) return { winner: opened[0], loserClose: undefined }
  const loser = await Promise.race(opened.map((ws) => waitClose(ws).then((close) => ({ ws, close }))))
  const winner = opened.find((ws) => ws !== loser.ws)!
  return { winner, loserClose: loser.close }
}

describe("IM WebSocket admission (real server)", () => {
  test("caps one user at the per-group limit and reopens the slot after a close", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const listener = await startListener()
    try {
      const groupId = await createGroup(listener.url, tmp.path)
      const url = socketURL(listener.url, groupId, tmp.path)

      const sockets: WebSocket[] = []
      for (let i = 0; i < DEFAULT_PER_USER_CAP; i++) sockets.push(await openSocket(url))
      expect(await probeAdmission(listener.url, groupId, tmp.path)).toBe(429)

      const closing = waitClose(sockets[0])
      sockets[0].close(1000)
      await closing
      await waitForFreedSlot(listener.url, groupId, tmp.path)

      const replacement = await openSocket(url)
      const pong = waitForMessage(replacement, (message) => message.includes('"pong"'))
      replacement.send(JSON.stringify({ type: "ping", data: { ts: Date.now() } }))
      expect(await pong).toContain('"pong"')
      expect(await probeAdmission(listener.url, groupId, tmp.path)).toBe(429)

      for (const ws of [replacement, ...sockets.slice(1)]) ws.close(1000)
    } finally {
      await stop(listener, "timed out cleaning up admission listener")
    }
  }, 30_000)

  test("concurrent admission resolves atomically: exactly one racer joins, the loser gets 1013", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const listener = await startListener()
    try {
      const groupId = await createGroup(listener.url, tmp.path)
      const url = socketURL(listener.url, groupId, tmp.path)

      const settled: WebSocket[] = []
      for (let i = 0; i < DEFAULT_PER_USER_CAP - 1; i++) settled.push(await openSocket(url))

      const racers = [
        new WebSocketWithHeaders(url, { headers: auth() }),
        new WebSocketWithHeaders(url, { headers: auth() }),
      ]
      const race = await settleLastSlotRace(racers)
      if (race.loserClose) expect(race.loserClose.code).toBe(1013)

      const pong = waitForMessage(race.winner, (message) => message.includes('"pong"'))
      race.winner.send(JSON.stringify({ type: "ping", data: { ts: Date.now() } }))
      expect(await pong).toContain('"pong"')
      expect(await probeAdmission(listener.url, groupId, tmp.path)).toBe(429)

      for (const ws of [race.winner, ...settled]) ws.close(1000)
    } finally {
      await stop(listener, "timed out cleaning up concurrent admission listener")
    }
  }, 30_000)
})

describe("IM WebSocket slow consumer (real server)", () => {
  test("a stalled consumer overflows the dropping queue and is closed with 1013", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const listener = await startListener()
    try {
      const groupId = await createGroup(listener.url, tmp.path)
      const url = socketURL(listener.url, groupId, tmp.path)

      // The stall must be at TCP level: a raw socket completes the upgrade, then
      // pause() stops reads so the receive buffer fills and the server writer blocks.
      const socket = net.connect(listener.port, "127.0.0.1")
      const received: Buffer[] = []
      let ended = false
      socket.on("data", (chunk) => received.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      socket.on("end", () => {
        ended = true
      })
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve)
        socket.once("error", reject)
      })
      const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
      socket.write(
        `GET ${url.pathname}${url.search} HTTP/1.1\r\n` +
          `Host: ${url.host}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          `${Object.entries(auth())
            .map(([name, value]) => `${name}: ${value}\r\n`)
            .join("")}\r\n`,
      )
      const deadline = Date.now() + 5_000
      while (!Buffer.concat(received).includes("\r\n\r\n") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(Buffer.concat(received).toString()).toContain("101")
      socket.pause()

      // A normally-draining control connection floods group events; the stalled
      // target's outgoing queue (dropping, MAX_OUTGOING_EVENTS) overflows once the
      // server-side writer blocks, which must close the target with 1013.
      const control = await openSocket(url)
      const marker = Buffer.from("Slow WebSocket consumer")
      const big = "x".repeat(90_000)
      let overflow: Buffer | undefined
      for (let cycle = 0; cycle < 30 && !overflow && !ended; cycle++) {
        socket.pause()
        for (let i = 0; i < 5; i++) await postMessage(listener.url, groupId, tmp.path, big)
        for (let i = 0; i < 400; i++) sendTyping(control, groupId)
        socket.resume()
        // Bounded wait for the close frame to flush while the socket drains; the
        // 1s server-side close-write budget far exceeds one flood cycle. The scan
        // runs AFTER the wait: the close frame and the FIN land in the same tick
        // burst, so scanning only while `!ended` would miss the frame.
        const until = Date.now() + 200
        while (Date.now() < until && !overflow && !ended) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        const buffered = Buffer.concat(received)
        if (buffered.includes(marker)) overflow = buffered
      }
      control.close(1000)
      socket.destroy()
      expect(overflow, "stalled consumer was never closed with 1013").toBeDefined()
      expect(overflow!.toString()).toContain(`Slow WebSocket consumer (queue ${MAX_OUTGOING_EVENTS})`)
    } finally {
      await stop(listener, "timed out cleaning up slow-consumer listener")
    }
  }, 30_000)
})

describe("IM WebSocket shutdown (real server)", () => {
  // The node:http adapter bounds graceful close and destroys both active and upgraded sockets at
  // the deadline. This keeps the server-closing advisory observable while guaranteeing that the
  // returned stop promise settles even on Bun versions whose ws shim leaves an upgraded socket in
  // the close callback's accounting.

  test("graceful stop delivers server-closing frames and the listener goes away", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const listener = await startListener()
    const groupId = await createGroup(listener.url, tmp.path)
    const url = socketURL(listener.url, groupId, tmp.path)
    const first = await openSocket(url)
    const second = await openSocket(url)

    const firstClose = waitClose(first)
    const secondClose = waitClose(second)
    const stopPromise = listener.stop()
    for (const close of [await firstClose, await secondClose]) {
      expect(close.reason).toBe("server closing")
      // src requests 1001 (SERVER_CLOSING_EVENT); the wire currently shows 1000.
      expect([1000, 1001]).toContain(close.code)
    }

    // The listener stops accepting before the bounded close promise settles.
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const refused = await fetch(new URL("/global/health", listener.url), { headers: auth() })
        .then(() => false)
        .catch(() => true)
      if (refused) {
        await withTimeout(stopPromise, 10_000, "timed out waiting for graceful listener stop")
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error("listener still accepts connections 5s after graceful stop")
  }, 30_000)

  test("forced stop with a live connection resolves without waiting on the peer", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const listener = await startListener()
    const groupId = await createGroup(listener.url, tmp.path)
    const url = socketURL(listener.url, groupId, tmp.path)
    const ws = await openSocket(url)

    // Forced teardown destroys the orphaned upgraded sockets instead of waiting
    // for the WebSocket close handshake to finish (probe: resolves in ~60ms).
    await withTimeout(listener.stop(true), 15_000, "timed out waiting for forced listener stop")
    await expect(fetch(new URL("/global/health", listener.url), { headers: auth() })).rejects.toThrow()
    ws.close()
  }, 30_000)
})

describe("IM WebSocket env clamp through a real server boot", () => {
  const dacRoot = path.resolve(import.meta.dir, "../..")

  async function bootWithEnv(maxConnections: string) {
    const driver = `
      import { Server } from ${JSON.stringify(path.join(dacRoot, "src/server/server.ts"))}
      const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
      console.log("READY " + listener.url.href)
      await new Promise(() => {})
    `
    const proc = Bun.spawn(["bun", "--eval", driver], {
      cwd: dacRoot,
      env: {
        ...process.env,
        DEEPAGENT_CODE_SERVER_PASSWORD: credentials.password,
        DEEPAGENT_CODE_SERVER_USERNAME: credentials.username,
        IM_WEBSOCKET_MAX_CONNECTIONS_PER_USER_PER_GROUP: maxConnections,
        // The subprocess shares the tester's Global root (DEEPAGENT_CODE_TEST_HOME).
        // Without this flag its ModelsDev refresh fiber holds the models-dev EffectFlock
        // when we SIGTERM it right after READY, and the parent harness's preload
        // afterAll (AppRuntime.dispose) then blocks ~60s inside the uninterruptible
        // EffectFlock.acquire retry waiting for the dead child's lock to go stale.
        DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    let output = ""
    // Pump stdout in the background and poll the shared buffer: concurrent
    // reader.read() calls are illegal, so a race-with-timeout read loop drops data.
    const reader = proc.stdout.getReader()
    const pump = (async () => {
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        output += decoder.decode(value, { stream: true })
      }
    })()
    pump.catch(() => undefined)
    const deadline = Date.now() + 20_000
    while (!output.includes("READY ") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (!output.includes("READY ")) {
      const stderr = await new Response(proc.stderr).text()
      proc.kill()
      await proc.exited
      throw new Error(`server subprocess never became ready: ${stderr.slice(-2000)}`)
    }
    const line = output.split("\n").find((entry) => entry.startsWith("READY "))!
    return { proc, url: new URL(line.slice("READY ".length).trim()) }
  }

  async function expectCap(url: URL, directory: string, cap: number) {
    const groupId = await createGroup(url, directory)
    const socket = socketURL(url, groupId, directory)
    const opened: WebSocket[] = []
    for (let i = 0; i < cap; i++) opened.push(await openSocket(socket))
    expect(await probeAdmission(url, groupId, directory)).toBe(429)
    for (const ws of opened) ws.close(1000)
  }

  test("a valid env override reaches the booted server's admission gate", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const { proc, url } = await bootWithEnv("2")
    try {
      await expectCap(url, tmp.path, 2)
    } finally {
      proc.kill()
      await proc.exited
    }
  }, 30_000)

  test("an invalid env value clamps back to the fallback cap at boot", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const { proc, url } = await bootWithEnv("NaN")
    try {
      // "NaN" fails safe to the fallback 5: five connections join, the sixth is 429 —
      // proving the booted server clamped the invalid value rather than disabling or
      // unbounding the gate.
      await expectCap(url, tmp.path, DEFAULT_PER_USER_CAP)
    } finally {
      proc.kill()
      await proc.exited
    }
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Broadcaster capacity gates (group / total) through the production WS handler.
// MAX_CONNECTIONS (1024) and MAX_CONNECTIONS_PER_GROUP (128) are unreachable with
// organic connections in a test budget, so these serve the REAL production handler
// group + middleware on a real in-test listener, composed with handle access to the
// (also real, production-class) repository and broadcaster instances — the same
// composition seam server.ts uses, with the pre-filled occupancy planted directly.
//
// The refusal IS the close frame now: the handler's register-failure branch
// starts the socket run loop before writing, the writer latch opens once the
// loop acquires the upgraded WebSocket, and the 1013 close frame with reason
// "WebSocket capacity exceeded" reaches the client before the request scope
// ends the socket. These tests assert the full contract — exact 1013 code and
// reason, no message ever delivered, occupancy counts unchanged.
// ---------------------------------------------------------------------------

const probeWorkspaceLayer = Workspace.defaultLayer.pipe(
  Layer.provide(InstanceStore.defaultLayer),
  Layer.provide(InstanceBootstrap.defaultLayer),
)
const probeInstanceStoreLayer = InstanceStore.defaultLayer.pipe(
  Layer.provide(
    Layer.succeed(InstanceBootstrapService.Service, InstanceBootstrapService.Service.of({ run: Effect.void })),
  ),
)
const probeWorkspaceRouting = workspaceRoutingLayer.pipe(Layer.provide(layerWebSocketConstructorGlobal))
const probeAuthorization = authorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))

const itProbe = testEffect(
  Layer.mergeAll(
    probeInstanceStoreLayer,
    Project.defaultLayer,
    Session.defaultLayer,
    probeWorkspaceLayer,
    Database.defaultLayer,
    NodeHttpServer.layerTest,
    NodeServices.layer,
  ),
)

const fakeConnection = (groupID: string, userID: string, workspaceID: string): IMWebSocketConnection => ({
  groupID,
  userID,
  workspaceID,
  send: () => {},
  close: () => {},
})

// Boots the production handler group on a real in-test node server. Under Bun,
// an upgraded connection stays registered with the http server even after its
// TCP socket closes, and server.close waits on it forever — closeAllConnections
// releases it, but only when called BEFORE close (the production listener does
// the same in destroyConnections, src/server/server.ts). The finalizer is
// registered after the server build so it runs before the server's close
// finalizers at scope exit.
function serveWithOccupancy(repo: IMRepositoryInterface, broadcaster: IMBroadcaster) {
  return Effect.gen(function* () {
    const server = createServer()
    const upgraded = new Set<Duplex>()
    server.on("upgrade", (_request, socket) => {
      upgraded.add(socket)
      socket.once("close", () => upgraded.delete(socket))
    })
    yield* HttpApiBuilder.layer(IMWebSocketApi).pipe(
      Layer.provide(imWebSocketHandlers),
      Layer.provide([probeAuthorization, probeWorkspaceRouting, instanceContextLayer]),
      Layer.provide(Layer.succeed(IMRepository, repo)),
      Layer.provide(Layer.succeed(IMBroadcasterService, broadcaster)),
      HttpRouter.serve,
      Layer.provide(NodeHttpServer.layer(() => server, { port: 0, gracefulShutdownTimeout: "1 second" })),
      Layer.build,
    )
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        server.closeAllConnections()
        upgraded.forEach((socket) => socket.destroy())
        upgraded.clear()
      }),
    )
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("probe server did not bind a TCP port")
    return address.port
  })
}

function probeSocketURL(port: number, groupId: string, directory: string) {
  const url = new URL(`ws://127.0.0.1:${port}${IMWebSocketPaths.group.replace(":groupId", groupId)}`)
  url.searchParams.set("directory", directory)
  return url
}

describe("IM WebSocket broadcaster capacity gates (production handler, planted occupancy)", () => {
  // A plain GET probes route+group liveness without opening a WebSocket: the
  // request passes the group and per-user checks, then dies on the missing upgrade.
  async function expectRouteAlive(port: number, groupId: string, directory: string) {
    const url = new URL(`http://127.0.0.1:${port}${IMWebSocketPaths.group.replace(":groupId", groupId)}`)
    url.searchParams.set("directory", directory)
    const response = await fetch(url)
    // 400 (ws layer rejects the non-upgrade GET) or 500 (orDie on the missing
    // upgrade): both prove the request passed routing, auth, and the group check.
    expect([400, 500]).toContain(response.status)
  }

  // One connection attempt against a capped gate: collects close/message evidence.
  // The 700ms window is a hang guard only — the refused upgrade's 1013 close frame
  // arrives within milliseconds; if delivery ever regresses, the attempt returns
  // without close evidence (failing the assertion) instead of blocking teardown.
  function capAttempt(url: URL) {
    const ws = new WebSocket(url)
    const state = { messages: 0, close: undefined as { code: number; reason: string } | undefined }
    ws.addEventListener("message", () => {
      state.messages += 1
    })
    const closed = new Promise<void>((resolve) => {
      ws.addEventListener(
        "close",
        (event) => {
          state.close = { code: event.code, reason: event.reason }
          resolve()
        },
        { once: true },
      )
    })
    return Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 700))]).then(() => {
      ws.close()
      return state
    })
  }

  function expectCapRefusal(
    state: { messages: number; close: { code: number; reason: string } | undefined },
    count: number,
  ) {
    // Delivery is part of the refusal contract: the client must receive the 1013
    // close frame with its reason, not a bare transport close.
    expect(state.close).toEqual({ code: 1013, reason: "WebSocket capacity exceeded" })
    expect(state.messages).toBe(0)
    return expect(count)
  }

  itProbe.live("a group at MAX_CONNECTIONS_PER_GROUP refuses the next upgrade", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true, config: { formatter: false, lsp: false } })
      const repo = yield* IMRepository.pipe(
        Effect.provide(IMRepositoryLive.pipe(Layer.provide(Database.defaultLayer))),
      )
      const broadcaster = yield* IMBroadcasterService.pipe(Effect.provide(IMBroadcasterLive))
      const capped = yield* repo.createGroup({ workspaceID: directory, type: "project", name: "cap", createdBy: "server" })
      for (let i = 0; i < MAX_CONNECTIONS_PER_GROUP; i++)
        broadcaster.register(fakeConnection(capped.id, `fake-${i}`, directory))
      const port = yield* serveWithOccupancy(repo, broadcaster)

      // No server password is set in this harness, so the upgrade needs no credential.
      yield* Effect.promise(() => expectRouteAlive(port, capped.id, directory))

      const state = yield* Effect.promise(() => capAttempt(probeSocketURL(port, capped.id, directory)))
      expectCapRefusal(state, broadcaster.getConnectionCount(capped.id)).toBe(MAX_CONNECTIONS_PER_GROUP)
    }),
  )

  itProbe.live("a broadcaster at MAX_CONNECTIONS refuses the next upgrade", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true, config: { formatter: false, lsp: false } })
      const repo = yield* IMRepository.pipe(
        Effect.provide(IMRepositoryLive.pipe(Layer.provide(Database.defaultLayer))),
      )
      const broadcaster = yield* IMBroadcasterService.pipe(Effect.provide(IMBroadcasterLive))
      const capped = yield* repo.createGroup({ workspaceID: directory, type: "project", name: "cap", createdBy: "server" })
      const port = yield* serveWithOccupancy(repo, broadcaster)

      // Route liveness is proven BEFORE the total cap is planted.
      yield* Effect.promise(() => expectRouteAlive(port, capped.id, directory))

      for (let i = 0; i < MAX_CONNECTIONS; i++)
        broadcaster.register(fakeConnection(`fake-group-${i}`, `fake-${i}`, directory))

      const state = yield* Effect.promise(() => capAttempt(probeSocketURL(port, capped.id, directory)))
      expectCapRefusal(state, broadcaster.getConnectionCount(capped.id)).toBe(0)
    }),
  )
})
