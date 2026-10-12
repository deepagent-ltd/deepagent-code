import { describe, expect, test } from "bun:test"
import { stat } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { validateIMName } from "@deepagent-code/core/im/facade-contract"
import { parseMatrixArgs, readMatrixMessages, runMatrix } from "../../script/im-gray-matrix"
import { tmpdir } from "../fixture/fixture"

const message = (id: string, groupID: string, senderID: string, content: string) => ({
  id,
  groupID,
  senderID,
  senderType: "user",
  type: "text",
  content,
  mentions: [],
  metadata: null,
  replyToID: "",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
})
const group = (id: string, kernelConvID: string) => ({
  id,
  kernelConvID,
  name: "fixture",
  type: kernelConvID.startsWith("k:1:") ? "direct" : "project",
  workspaceID: "ws",
  projectID: "",
  createdBy: "server",
  createdAt: 1,
  updatedAt: 1,
})

function fixture(directories?: { a: string; b: string }) {
  const sides = {
    a: {
      uuid: "alice",
      name: "甲",
      groups: [] as ReturnType<typeof group>[],
      messages: [] as ReturnType<typeof message>[],
      receipts: new Map<string, ReturnType<typeof message>>(),
    },
    b: {
      uuid: "bob",
      name: "乙",
      groups: [] as ReturnType<typeof group>[],
      messages: [] as ReturnType<typeof message>[],
      receipts: new Map<string, ReturnType<typeof message>>(),
    },
  }
  const requests: { side: "a" | "b"; path: string; body?: unknown }[] = []
  const invited = new Set<string>()
  const handler = (side: "a" | "b") => async (request: Request) => {
    const local = sides[side]
    const peer = sides[side === "a" ? "b" : "a"]
    const url = new URL(request.url)
    requests.push({ side, path: url.pathname })
    if (directories && url.pathname.startsWith("/api/") && url.searchParams.get("directory") !== directories[side])
      return new Response("project directory required", { status: 400 })
    if (url.pathname === "/global/health") return Response.json({ healthy: true })
    if (url.pathname === "/api/v1/im/status")
      return Response.json({
        facade: "active",
        kernel: "connected",
        recovery: { status: "ready" },
        viewer: { memberID: "server" },
        identity: { uuid: local.uuid, name: local.name, orgID: 7, orgAllGroupID: "org7" },
        keyOrigin: "env",
      })
    if (url.pathname === "/api/v1/im/groups") return Response.json(local.groups)
    if (url.pathname === "/api/v1/im/facade/direct") {
      const body = z.object({ name: z.string() }).parse(await request.json())
      if (body.name !== peer.name) return new Response("wrong peer", { status: 400 })
      const found = local.groups.find((item) => item.kernelConvID === `k:1:${peer.uuid}`)
      if (found) return Response.json(found)
      const created = group(`${side}-local-direct`, `k:1:${peer.uuid}`)
      local.groups.push(created)
      return Response.json(created)
    }
    if (url.pathname === "/api/v1/im/facade/groups") {
      const body = z.object({ name: z.string(), memberNames: z.array(z.string()) }).parse(await request.json())
      requests.at(-1)!.body = body
      if (!validateIMName(body.name).ok) return new Response("invalid group name", { status: 400 })
      if (body.memberNames.length) return new Response("must invite separately", { status: 400 })
      const created = group(`${side}-local-group-${local.groups.length}`, `k:2:kernel-${crypto.randomUUID()}`)
      local.groups.push(created)
      return Response.json(created)
    }
    const invitation = url.pathname.match(/^\/api\/v1\/im\/facade\/groups\/([^/]+)\/invite$/)
    if (invitation) {
      const target = local.groups.find((item) => item.id === invitation[1])
      const body = z.object({ name: z.string() }).parse(await request.json())
      if (!target || body.name !== peer.name) return new Response("invalid invite", { status: 400 })
      invited.add(target.kernelConvID)
      return Response.json({ ok: true })
    }
    const route = url.pathname.match(/^\/api\/v1\/im\/groups\/([^/]+)\/messages$/)
    const target = local.groups.find((item) => item.id === route?.[1])
    if (!route || !target) return new Response("unknown local group", { status: 404 })
    if (request.method === "GET") {
      const all = local.messages.filter((item) => item.groupID === target.id).toReversed()
      const offset = Number(url.searchParams.get("cursor") ?? 0)
      const limit = Number(url.searchParams.get("limit") ?? 20)
      return Response.json({
        messages: all.slice(offset, offset + limit),
        nextCursor: String(offset + limit),
        hasMore: offset + limit < all.length,
      })
    }
    const body = z
      .object({
        content: z.string(),
        clientRequestID: z.string(),
        senderType: z.literal("user"),
        type: z.literal("text"),
      })
      .parse(await request.json())
    const existing = local.receipts.get(body.clientRequestID)
    if (existing) return Response.json(existing)
    if (target.kernelConvID.startsWith("k:2:") && !invited.has(target.kernelConvID))
      return new Response("invite required", { status: 403 })
    const own = message(`${side}-own-${local.messages.length}`, target.id, "server", body.content)
    local.messages.push(own)
    local.receipts.set(body.clientRequestID, own)
    const binding = target.kernelConvID.startsWith("k:1:") ? `k:1:${local.uuid}` : target.kernelConvID
    const remote =
      peer.groups.find((item) => item.kernelConvID === binding) ??
      group(`${peer.uuid}-discovered-${peer.groups.length}`, binding)
    if (!peer.groups.includes(remote)) peer.groups.push(remote)
    peer.messages.push(message(`${peer.uuid}-received-${peer.messages.length}`, remote.id, local.uuid, body.content))
    return Response.json(own)
  }
  const servers = {
    a: Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler("a") }),
    b: Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler("b") }),
  }
  const a = servers.a.url.origin
  const b = servers.b.url.origin
  return {
    a,
    b,
    sides,
    requests,
    stopA: () => servers.a.stop(true),
    resumeA: () => {
      servers.a = Bun.serve({ hostname: "127.0.0.1", port: Number(new URL(a).port), fetch: handler("a") })
    },
    [Symbol.dispose]: () => {
      servers.a.stop(true)
      servers.b.stop(true)
    },
  }
}

describe("IM gray matrix real HTTP driver", () => {
  test("discovers independent direct/group local IDs, verifies both senders and exact retry, persists a private state", async () => {
    await using temporary = await tmpdir()
    using servers = fixture({ a: "/project/A", b: "/project/B" })
    const options = {
      a: servers.a,
      b: servers.b,
      state: path.join(temporary.path, "matrix.json"),
      timeoutMs: 200,
      pollMs: 1,
      aDirectory: "/project/A",
      bDirectory: "/project/B",
    }
    const direct = await runMatrix({ ...options, phase: "direct" })
    expect(direct.result).toBe("DIRECT_FIRST_DISCOVERY_PASS")
    const state = await Bun.file(options.state).json()
    expect(state.direct.a).not.toBe(state.direct.b)
    expect(state.direct.aKernel).toBe("k:1:bob")
    expect(state.direct.bKernel).toBe("k:1:alice")
    expect(servers.sides.a.messages).toHaveLength(2)
    expect(servers.sides.b.messages).toHaveLength(2)
    expect((await stat(options.state)).mode & 0o777).toBe(0o600)
    await expect(runMatrix({ ...options, phase: "direct" })).rejects.toThrow("RECEIVER_DIRECT_ALREADY_EXISTS")
    expect((await runMatrix({ ...options, phase: "direct", allowExistingDirect: true })).result).toBe(
      "DIRECT_EXISTING_PASS",
    )
    const grouped = await runMatrix({ ...options, phase: "group" })
    expect(grouped.result).toBe("GROUP_INVITE_FIRST_DISCOVERY_PASS")
    const after = await Bun.file(options.state).json()
    expect(after.group.a).not.toBe(after.group.b)
    expect(after.group.aKernel).toBe(after.group.bKernel)
    expect(servers.requests.find((request) => request.path === "/api/v1/im/facade/groups")?.body).toEqual({
      name: `灰度验收${state.run.replaceAll("-", "").slice(0, 12)}`,
      memberNames: [],
    })
    expect(servers.requests.filter((request) => request.path.endsWith("/invite"))).toHaveLength(1)
    expect(servers.sides.a.messages).toHaveLength(4)
    expect(servers.sides.b.messages).toHaveLength(4)
  })

  test("requires offline A, verifies every ordinal across pages, and rejects missing or duplicated ordinals", async () => {
    await using temporary = await tmpdir()
    using servers = fixture()
    const options = {
      a: servers.a,
      b: servers.b,
      state: path.join(temporary.path, "matrix.json"),
      timeoutMs: 30,
      pollMs: 1,
    }
    await runMatrix({ ...options, phase: "group" })
    await expect(runMatrix({ ...options, phase: "burst-send", count: 21 })).rejects.toThrow("A_MUST_BE_OFFLINE")
    servers.stopA()
    expect((await runMatrix({ ...options, phase: "burst-send", count: 21 })).result).toBe("BURST_SENT")
    servers.resumeA()
    const verified = await runMatrix({ ...options, phase: "burst-verify" })
    expect(verified).toMatchObject({ result: "BURST_OFFLINE_RECOVERY_PASS", count: 21, pages: 2 })
    const missing = servers.sides.a.messages.splice(10, 1)[0]
    await expect(runMatrix({ ...options, phase: "burst-verify" })).rejects.toThrow("OBSERVATION_TIMEOUT")
    servers.sides.a.messages.push(missing)
    servers.sides.a.messages.push({ ...missing, id: "different-id-same-ordinal" })
    await expect(runMatrix({ ...options, phase: "burst-verify" })).rejects.toThrow("DUPLICATE_BURST_ORDINAL")
  })

  for (const fault of ["duplicate-id", "stalled-cursor"] as const) {
    test(`rejects ${fault} from a real paginated HTTP endpoint`, async () => {
      const count = { value: 0 }
      using server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () =>
          Response.json({
            messages: [message(fault === "duplicate-id" ? "same" : `page-${count.value++}`, "local", "bob", "text")],
            hasMore: true,
            nextCursor: "same-cursor",
          }),
      })
      const client = createDeepAgentCodeClient({ baseUrl: server.url.origin })
      await expect(readMatrixMessages(client, "local")).rejects.toThrow(
        fault === "duplicate-id" ? "DUPLICATE_PAGE_MESSAGE" : "STALLED_CURSOR",
      )
    })
  }

  test("counts use the real singular table and are diagnostic only", async () => {
    await using temporary = await tmpdir()
    const { Database } = await import("bun:sqlite")
    const file = path.join(temporary.path, "test.db")
    using db = new Database(file)
    db.exec(
      "CREATE TABLE session_input (id text); CREATE TABLE im_mention_intent (id text); INSERT INTO im_mention_intent VALUES ('existing')",
    )
    expect(
      await runMatrix({
        a: "http://127.0.0.1:1",
        b: "http://127.0.0.1:2",
        state: path.join(temporary.path, "state.json"),
        phase: "counts",
        db: file,
      }),
    ).toEqual({ result: "COUNTS_DIAGNOSTIC_ONLY", sessionInputs: 0, mentionIntents: 1 })
  })

  test("rejects remote and credential-bearing URLs and sanitizes CLI errors", async () => {
    await using temporary = await tmpdir()
    const options = {
      a: "https://example.com",
      b: "http://127.0.0.1:2",
      state: path.join(temporary.path, "state.json"),
      phase: "status" as const,
    }
    await expect(runMatrix(options)).rejects.toThrow("LOOPBACK_URL_REQUIRED")
    await expect(runMatrix({ ...options, a: "http://secret@127.0.0.1:1" })).rejects.toThrow("LOOPBACK_URL_REQUIRED")
    const child = Bun.spawn(
      [process.execPath, path.resolve(import.meta.dir, "../../script/im-gray-matrix.ts"), "--unrecognized-sk-secret"],
      { stdout: "pipe", stderr: "pipe" },
    )
    expect(await child.exited).toBe(1)
    expect(await new Response(child.stderr).text()).toBe('{"result":"FAIL","code":"MATRIX_FAILED"}\n')
    expect(
      parseMatrixArgs([
        "--a",
        "http://127.0.0.1:1",
        "--b",
        "http://127.0.0.1:2",
        "--phase",
        "status",
        "--state",
        options.state,
      ]).phase,
    ).toBe("status")
  })

  test("CLI HTTP failures do not disclose server error bodies", async () => {
    await using temporary = await tmpdir()
    using a = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ message: "sk-private-http-error" }, { status: 500 }),
    })
    using b = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ message: "sk-private-http-error" }, { status: 500 }),
    })
    const child = Bun.spawn(
      [
        process.execPath,
        path.resolve(import.meta.dir, "../../script/im-gray-matrix.ts"),
        "--a",
        a.url.origin,
        "--b",
        b.url.origin,
        "--phase",
        "status",
        "--state",
        path.join(temporary.path, "state.json"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    expect(await child.exited).toBe(1)
    expect(await new Response(child.stderr).text()).toBe('{"result":"FAIL","code":"HTTP_500"}\n')
    expect(await new Response(child.stdout).text()).toBe("")
  })
})
