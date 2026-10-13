// Separate process: fixed auth/config from startup, private file DB, no PTY shell or provider call.
import assert from "node:assert/strict"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { Effect } from "effect"
import { AppRuntime, builtAppRuntimeRoot } from "../../src/effect/app-runtime"
import { Server } from "../../src/server/server"
import { IMPaths } from "../../src/server/routes/instance/httpapi/groups/im"
import { IMWebSocketPaths } from "../../src/server/routes/instance/httpapi/groups/im-websocket"
import { PtyPaths } from "../../src/server/routes/instance/httpapi/groups/pty"
import { PTY_CONNECT_TOKEN_HEADER, PTY_CONNECT_TOKEN_HEADER_VALUE } from "../../src/server/shared/pty-ticket"
import { withTimeout } from "../../src/util/timeout"

const directory = Bun.argv[2]
assert(directory)
const auth = {
  authorization: `Basic ${btoa(`${process.env.DEEPAGENT_CODE_SERVER_USERNAME}:${process.env.DEEPAGENT_CODE_SERVER_PASSWORD}`)}`,
}
const origins = ["https://listener-a.example.test", "https://listener-b.example.test"]
const database = await AppRuntime.runPromise(Database.Service)
assert.equal(builtAppRuntimeRoot()?.databasePath, Database.path())
assert.equal((await Server.Default().app.request("/global/health", { headers: auth })).status, 200)
const listeners: Awaited<ReturnType<typeof Server.listen>>[] = []
const sockets: WebSocket[] = []
const socketConstructor = WebSocket as unknown as new (url: URL, init: { headers: Record<string, string> }) => WebSocket
const url = (base: URL, pathname: string) => {
  const target = new URL(pathname, base)
  target.searchParams.set("directory", directory)
  return target
}
const request = (base: URL, pathname: string, origin: string, method = "GET", ticket = false) =>
  fetch(url(base, pathname), {
    method,
    headers: { ...auth, origin, ...(ticket ? { [PTY_CONNECT_TOKEN_HEADER]: PTY_CONNECT_TOKEN_HEADER_VALUE } : {}) },
  })

async function connect(base: URL, group: string, origin: string) {
  const target = url(base, IMWebSocketPaths.group.replace(":groupId", group))
  target.protocol = "ws:"
  const socket = new socketConstructor(target, { headers: { ...auth, origin } })
  sockets.push(socket)
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true })
      socket.addEventListener("error", () => reject(new Error(`IM upgrade rejected for ${origin}`)), { once: true })
    }),
    5_000,
    "IM upgrade timed out",
  )
  return socket
}
function message(socket: WebSocket, type: string) {
  return withTimeout(
    new Promise<string>((resolve) => {
      const receive = (event: MessageEvent) => {
        if (typeof event.data !== "string" || !event.data.includes(`"${type}"`)) return
        socket.removeEventListener("message", receive)
        resolve(event.data)
      }
      socket.addEventListener("message", receive)
    }),
    5_000,
    `missing ${type} frame`,
  )
}

try {
  for (const origin of origins) listeners.push(await Server.listen({ hostname: "127.0.0.1", port: 0, cors: [origin] }))
  const created = await fetch(url(listeners[1].url, IMPaths.groups), {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ type: "project", name: "CORS" }),
  })
  assert.equal(created.status, 200)
  const group = (await created.json()) as { id: string }
  assert(group.id)
  // HTTP mutation is visible through the already-built root's actual database service.
  const count = await AppRuntime.runPromise(
    database.db
      .get<{ count: number }>(sql`select count(*) as count from im_groups where id = ${group.id}`)
      .pipe(Effect.orDie),
  )
  assert.equal(count?.count, 1)
  assert.equal(await AppRuntime.runPromise(Database.Service), database)
  for (const [index, listener] of listeners.entries()) {
    const own = origins[index]
    const other = origins[1 - index]
    const socket = await connect(listener.url, group.id, own)
    const pong = message(socket, "pong")
    socket.send(JSON.stringify({ type: "ping", data: { ts: index + 1 } }))
    assert((await pong).includes('"pong"'))
    assert.equal((await request(listener.url, IMWebSocketPaths.group.replace(":groupId", group.id), other)).status, 403)
    assert.equal(
      (
        await fetch(url(listener.url, IMWebSocketPaths.group.replace(":groupId", group.id)), {
          headers: { origin: own },
        })
      ).status,
      401,
    )
    const health = await request(listener.url, "/global/health", own)
    assert.equal(health.status, 200)
    assert.equal(health.headers.get("access-control-allow-origin"), own)
    assert.equal(
      (await request(listener.url, "/global/health", other)).headers.get("access-control-allow-origin"),
      null,
    )
    // Token origin check precedes PTY lookup: allowed -> absent resource 404; other listener's origin -> 403.
    const token = PtyPaths.connectToken.replace(":ptyID", "pty_absent_cors")
    assert.equal((await request(listener.url, token, own, "POST", true)).status, 404)
    assert.equal((await request(listener.url, token, other, "POST", true)).status, 403)
    assert.equal((await request(listener.url, token, own, "POST")).status, 403)
    // Connect keeps its established lookup-before-ticket ordering. No shell is created for this oracle.
    assert.equal((await request(listener.url, PtyPaths.connect.replace(":ptyID", "pty_absent_cors"), own)).status, 404)
  }
  for (const listener of listeners) {
    for (const origin of ["oc://renderer", "http://127.0.0.1:4465"]) {
      const socket = await connect(listener.url, group.id, origin)
      const pong = message(socket, "pong")
      socket.send(JSON.stringify({ type: "ping", data: { ts: 4 } }))
      assert((await pong).includes('"pong"'))
      const closed = withTimeout(
        new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true })),
        5_000,
        "product-origin socket did not close",
      )
      socket.close(1000)
      await closed
    }
    assert.equal(
      (
        await request(
          listener.url,
          IMWebSocketPaths.group.replace(":groupId", group.id),
          "https://untrusted.example.test",
        )
      ).status,
      403,
    )
    assert.equal(
      (
        await fetch(url(listener.url, IMWebSocketPaths.group.replace(":groupId", group.id)), {
          headers: { origin: "oc://renderer" },
        })
      ).status,
      401,
    )
  }
  const typing = message(sockets[1], "typing")
  sockets[0].send(JSON.stringify({ type: "typing", data: { groupID: group.id, memberID: "server", typing: true } }))
  assert((await typing).includes(group.id)) // broadcaster authority is shared across listeners
  await listeners[0].stop(true)
  const pong = message(sockets[1], "pong")
  sockets[1].send(JSON.stringify({ type: "ping", data: { ts: 3 } }))
  assert((await pong).includes('"pong"')) // stopping one listener preserves the other's resources
  console.log("LISTENER_CORS_SHARED_ROOT_PASS")
} finally {
  for (const socket of sockets) socket.close()
  for (const listener of listeners) await withTimeout(listener.stop(true), 10_000, "listener cleanup timed out")
  await Server.disposeDefault()
  await AppRuntime.dispose()
}
