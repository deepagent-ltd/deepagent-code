import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

if (!process.env.DEEPAGENT_TEST_MCP_PROTOCOL_CHILD) {
  test("real MCP protocol negotiation runs in an isolated authority process", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dac-mcp-protocol-"))
    await Promise.all(["home", "tmp", "config", "data", "cache", "state"].map((name) => mkdir(path.join(root, name))))
    const child = Bun.spawn({
      cmd: [process.execPath, "test", import.meta.path, "--timeout", "30000"],
      cwd: path.resolve(import.meta.dir, "../.."),
      env: {
        PATH: process.env.PATH,
        HOME: path.join(root, "home"),
        TMPDIR: path.join(root, "tmp"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
        DEEPAGENT_TEST_MCP_PROTOCOL_CHILD: "1",
        DEEPAGENT_TEST_MCP_PROTOCOL_EVIDENCE: process.env.DEEPAGENT_TEST_MCP_PROTOCOL_EVIDENCE,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const deadline = setTimeout(() => child.kill(), 45_000)
    try {
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      const output = stdout + stderr
      if (process.env.DEEPAGENT_TEST_MCP_PROTOCOL_EVIDENCE)
        await Bun.write(process.env.DEEPAGENT_TEST_MCP_PROTOCOL_EVIDENCE, output)
      expect({ status, output: status === 0 ? "ok" : output }).toEqual({ status: 0, output: "ok" })
      expect(output).toMatch(/\b0 fail\b/)
      console.info(output)
    } finally {
      clearTimeout(deadline)
      child.kill()
      await rm(root, { recursive: true, force: true })
    }
  }, 50_000)
}

if (process.env.DEEPAGENT_TEST_MCP_PROTOCOL_CHILD) {
  const { Cause, Effect, Exit } = await import("effect")
  const { ProtocolError } = await import("@modelcontextprotocol/client")
  const { Server, createMcpHandler } = await import("@modelcontextprotocol/server")
  const { MCP } = await import("../../src/mcp/index")
  const { testEffect, pollWithTimeout } = await import("../lib/effect")
  const it = testEffect(MCP.defaultLayer)

  it.instance(
    "modern HTTP uses request envelopes, subscriptions and cancellation",
    () =>
      Effect.gen(function* () {
        const state = { name: "probe", bodies: 0, cancelled: 0 }
        const requests: { method: string; version?: unknown }[] = []
        const handler = createMcpHandler(
          () => {
            const server = new Server(
              { name: "modern-http", version: "1" },
              { capabilities: { tools: { listChanged: true } } },
            )
            server.setRequestHandler("tools/list", () => ({
              tools: [
                { name: state.name, inputSchema: { type: "object", properties: {} } },
                { name: "wait", inputSchema: { type: "object", properties: {} } },
              ],
            }))
            server.setRequestHandler("tools/call", async (request, context) => {
              state.bodies += 1
              if (request.params.name !== "wait") return { content: [{ type: "text", text: "modern-result" }] }
              await new Promise<void>((resolve) => {
                if (context.mcpReq.signal.aborted) {
                  state.cancelled += 1
                  resolve()
                  return
                }
                context.mcpReq.signal.addEventListener(
                  "abort",
                  () => {
                    state.cancelled += 1
                    resolve()
                  },
                  { once: true },
                )
              })
              return { content: [{ type: "text", text: "cancel-observed" }] }
            })
            return server
          },
          { legacy: "reject", keepAliveMs: 0 },
        )
        const listener = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: async (request) => {
            if (request.method === "POST") {
              const body = (await request.clone().json()) as {
                method: string
                params?: { _meta?: Record<string, unknown> }
              }
              requests.push({
                method: body.method,
                version: body.params?._meta?.["io.modelcontextprotocol/protocolVersion"],
              })
            }
            return handler.fetch(request)
          },
        })
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await handler.close()
            await listener.stop(true)
          }),
        )
        const mcp = yield* MCP.Service
        yield* mcp.add("modern", {
          type: "remote",
          url: new URL("/mcp", listener.url).href,
          oauth: false,
          protocol: "2026-07-28",
          timeout: 3000,
        })
        const client = (yield* mcp.clients()).modern!
        expect((yield* mcp.status()).modern?.status).toBe("connected")
        expect(client.getProtocolEra()).toBe("modern")
        expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28")
        expect(requests.map((request) => request.method)).toContain("subscriptions/listen")
        expect(requests.map((request) => request.method)).not.toContain("initialize")
        const tool = (yield* mcp.tools()).modern_probe!
        expect(
          yield* Effect.promise(() => Promise.resolve(tool.execute!({}, { toolCallId: "call-modern", messages: [] }))),
        ).toMatchObject({
          content: [{ type: "text", text: "modern-result" }],
        })
        expect(state.bodies).toBe(1)
        expect(requests.find((request) => request.method === "tools/call")?.version).toBe("2026-07-28")
        state.name = "updated"
        handler.notify.toolsChanged()
        yield* pollWithTimeout(
          mcp.tools().pipe(Effect.map((tools) => tools.modern_updated || undefined)),
          "modern tools subscription did not refresh",
        )
        const stale = yield* Effect.tryPromise(() =>
          Promise.resolve(tool.execute!({}, { toolCallId: "call-stale", messages: [] })),
        ).pipe(Effect.exit)
        expect(Exit.isFailure(stale)).toBe(true)
        expect(state.bodies).toBe(1)
        const controller = new AbortController()
        const waiting = (yield* mcp.tools()).modern_wait!
        const result = Promise.resolve(
          waiting.execute!({}, { toolCallId: "call-cancel", messages: [], abortSignal: controller.signal }),
        ).then(
          () => "completed",
          () => "rejected",
        )
        yield* pollWithTimeout(
          Effect.sync(() => state.bodies === 2 || undefined),
          "tool body not dispatched",
        )
        controller.abort()
        expect(yield* Effect.promise(() => result)).toBe("rejected")
        yield* pollWithTimeout(
          Effect.sync(() => state.cancelled === 1 || undefined),
          "modern stream close did not cancel server handler",
        )
        expect(state.bodies).toBe(2)
        yield* mcp.disconnect("modern")
        expect(Object.keys(yield* mcp.tools())).toEqual([])
      }),
    { config: { mcp: {} } },
    30_000,
  )

  it.instance(
    "a modern protocol error never automatically repeats an admitted tool call",
    () =>
      Effect.gen(function* () {
        const state = { bodies: 0, lists: 0 }
        const handler = createMcpHandler(
          () => {
            const server = new Server({ name: "single-dispatch", version: "1" }, { capabilities: { tools: {} } })
            server.setRequestHandler("tools/list", () => {
              state.lists += 1
              return { tools: [{ name: "probe", inputSchema: { type: "object", properties: {} } }] }
            })
            server.setRequestHandler("tools/call", () => {
              state.bodies += 1
              // A remote error cannot establish that an external effect did not occur.
              throw new ProtocolError(-32020, "fixture header mismatch after body marker")
            })
            return server
          },
          { legacy: "reject", keepAliveMs: 0 },
        )
        const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handler.fetch(request) })
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await handler.close()
            await listener.stop(true)
          }),
        )
        const mcp = yield* MCP.Service
        yield* mcp.add("single", {
          type: "remote",
          url: listener.url.href,
          oauth: false,
          protocol: "2026-07-28",
          timeout: 3000,
        })
        const tool = (yield* mcp.tools()).single_probe!
        const lists = state.lists
        const result = yield* Effect.tryPromise({
          try: () => Promise.resolve(tool.execute!({}, { toolCallId: "one-admission", messages: [] })),
          catch: (error) => error,
        }).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBeInstanceOf(ProtocolError)
        expect(state.bodies).toBe(1)
        expect(state.lists).toBe(lists)
      }),
    { config: { mcp: {} } },
    30_000,
  )

  it.instance(
    "auto falls back to a real legacy HTTP endpoint while modern pin refuses it",
    () =>
      Effect.gen(function* () {
        const methods: string[] = []
        const handler = createMcpHandler(
          () => {
            const server = new Server({ name: "legacy", version: "1" }, { capabilities: { tools: {} } })
            server.setRequestHandler("tools/list", () => ({
              tools: [{ name: "probe", inputSchema: { type: "object", properties: {} } }],
            }))
            return server
          },
          { keepAliveMs: 0 },
        )
        const listener = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: async (request) => {
            if (request.method !== "POST") return handler.fetch(request)
            const body = (await request.clone().json()) as { method: string; id: string | number }
            methods.push(body.method)
            if (body.method === "server/discover")
              return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Legacy only" } })
            return handler.fetch(request)
          },
        })
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await handler.close()
            await listener.stop(true)
          }),
        )
        const mcp = yield* MCP.Service
        const url = new URL("/mcp", listener.url).href
        yield* mcp.add("default", { type: "remote", url, oauth: false, timeout: 2000 })
        expect((yield* mcp.clients()).default?.getProtocolEra()).toBe("legacy")
        expect(methods).not.toContain("server/discover")
        yield* mcp.add("auto", { type: "remote", url, oauth: false, protocol: "auto", timeout: 2000 })
        expect((yield* mcp.clients()).auto?.getProtocolEra()).toBe("legacy")
        expect(methods).toContain("server/discover")
        const initializes = methods.filter((method) => method === "initialize").length
        yield* mcp.add("pin", { type: "remote", url, oauth: false, protocol: "2026-07-28", timeout: 2000 })
        expect((yield* mcp.status()).pin?.status).toBe("failed")
        expect((yield* mcp.clients()).pin).toBeUndefined()
        expect(methods.filter((method) => method === "initialize")).toHaveLength(initializes)
      }),
    { config: { mcp: {} } },
    30_000,
  )

  it.instance(
    "stdio legacy stays single-spawn while explicit modern modes subscribe and refresh",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        for (const protocol of [undefined, "auto", "2026-07-28"] as const) {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(path.join(tmpdir(), "dac-modern-stdio-"))),
            (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
          )
          yield* Effect.promise(() => Bun.write(path.join(directory, "body.log"), ""))
          const name = protocol ?? "default"
          yield* mcp.add(name, {
            type: "local",
            command: [process.execPath, path.join(import.meta.dir, "fixture/modern-wire-server.ts"), directory],
            protocol,
            timeout: 3000,
          })
          const client = (yield* mcp.clients())[name]!
          expect((yield* mcp.status())[name]?.status).toBe("connected")
          expect(client.getProtocolEra()).toBe(protocol ? "modern" : "legacy")
          const spawns = (yield* Effect.promise(() => Bun.file(path.join(directory, "spawns.log")).text()))
            .trim()
            .split("\n")
          expect(spawns).toHaveLength(protocol ? 2 : 1)
          const initial = (yield* mcp.tools())[`${name}_probe`]!
          yield* Effect.promise(() => Promise.resolve(initial.execute!({}, { toolCallId: "call-stdio", messages: [] })))
          const before = yield* Effect.promise(() => Bun.file(path.join(directory, "body.log")).text())
          expect(before).toContain(`probe:${client.getNegotiatedProtocolVersion()}`)
          yield* Effect.promise(() => client.callTool({ name: "fixture_refresh", arguments: {} }))
          yield* pollWithTimeout(
            mcp.tools().pipe(Effect.map((tools) => tools[`${name}_updated`] || undefined)),
            "stdio list change was not observed",
          )
          const old = yield* Effect.tryPromise(() =>
            Promise.resolve(initial.execute!({}, { toolCallId: "call-stdio-stale", messages: [] })),
          ).pipe(Effect.exit)
          expect(Exit.isFailure(old)).toBe(true)
          expect(yield* Effect.promise(() => Bun.file(path.join(directory, "body.log")).text())).toBe(before)
          yield* mcp.disconnect(name)
        }
        expect(Object.keys(yield* mcp.tools())).toEqual([])
      }),
    { config: { mcp: {} } },
    30_000,
  )

  it.instance(
    "HTTP auth and server failures never select a legacy transport",
    () =>
      Effect.gen(function* () {
        const state = { status: 401 }
        const methods: string[] = []
        const listener = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: async (request) => {
            if (request.method === "POST") methods.push(((await request.json()) as { method: string }).method)
            return new Response("fixture failure", { status: state.status })
          },
        })
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await listener.stop(true)
          }),
        )
        const mcp = yield* MCP.Service
        for (const status of [401, 403, 503]) {
          state.status = status
          yield* mcp.add(`failure-${status}`, {
            type: "remote",
            url: listener.url.href,
            oauth: false,
            protocol: "auto",
            timeout: 2000,
          })
          expect((yield* mcp.status())[`failure-${status}`]?.status).not.toBe("connected")
        }
        expect(methods).toEqual(["server/discover", "server/discover", "server/discover"])
        expect(Object.keys(yield* mcp.clients())).toEqual([])
      }),
    { config: { mcp: {} } },
    30_000,
  )
}
