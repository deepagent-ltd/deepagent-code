import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import type { ReadInput } from "../../src/mcp/app-resource"

if (!process.env.DEEPAGENT_TEST_MCP_APPS_CHILD) {
  test("MCP Apps resource authority uses an isolated real SDK wire process", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dac-mcp-app-resource-"))
    await Promise.all(["home", "tmp", "config", "data", "cache", "state"].map((name) => mkdir(path.join(root, name))))
    const child = Bun.spawn({
      cmd: [process.execPath, "test", import.meta.path, "--timeout", "30000"],
      cwd: path.resolve(import.meta.dir, "../.."),
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: path.join(root, "home"),
        TMPDIR: path.join(root, "tmp"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
        DEEPAGENT_TEST_MCP_APPS_CHILD: "1",
        DEEPAGENT_TEST_MCP_APPS_EVIDENCE: process.env.DEEPAGENT_TEST_MCP_APPS_EVIDENCE,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const deadline = setTimeout(() => child.kill(), 45000)
    try {
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      const output = stdout + stderr
      if (process.env.DEEPAGENT_TEST_MCP_APPS_EVIDENCE)
        await Bun.write(process.env.DEEPAGENT_TEST_MCP_APPS_EVIDENCE, output)
      expect({ status, output: status === 0 ? "ok" : output }).toEqual({ status: 0, output: "ok" })
      expect(output).toMatch(/\b0 fail\b/)
      console.info(output)
    } finally {
      clearTimeout(deadline)
      child.kill()
      await rm(root, { recursive: true, force: true })
    }
  }, 50000)
}

if (process.env.DEEPAGENT_TEST_MCP_APPS_CHILD) {
  const { Effect, Exit, Fiber, Layer } = await import("effect")
  const { Server, createMcpHandler } = await import("@modelcontextprotocol/server")
  const { MCP } = await import("../../src/mcp/index")
  const { McpAppResource } = await import("../../src/mcp/app-resource")
  const { Config } = await import("../../src/config/config")
  const { CrossSpawnSpawner } = await import("@deepagent-code/core/cross-spawn-spawner")
  const { provideTmpdirInstance } = await import("../fixture/fixture")
  const { testEffect, pollWithTimeout } = await import("../lib/effect")
  const it = testEffect(Layer.mergeAll(MCP.defaultLayer, Config.defaultLayer, CrossSpawnSpawner.defaultLayer))
  it.instance(
    "explicit consent, exact provenance, bounded HTML and lifecycle invalidation use actual MCP resources/read",
    () =>
      Effect.gen(function* () {
        const state = {
          reads: 0,
          tools: 0,
          mode: "normal",
          revision: 1,
          release: undefined as (() => void) | undefined,
          appsCapability: false,
        }
        const handler = createMcpHandler(
          () => {
            const server = new Server(
              { name: "apps-wire", version: "1" },
              { capabilities: { tools: { listChanged: true }, resources: {} } },
            )
            server.setRequestHandler("tools/list", () => ({
              tools: [
                {
                  name: "view",
                  inputSchema: { type: "object", properties: {} },
                  _meta: { ui: { resourceUri: `ui://wire/view-${state.revision}` } },
                },
                {
                  name: "app_only",
                  inputSchema: { type: "object", properties: {} },
                  _meta: { ui: { resourceUri: "ui://wire/only", visibility: ["app"] } },
                },
                {
                  name: "model_only",
                  inputSchema: { type: "object", properties: {} },
                  _meta: { ui: { resourceUri: "ui://wire/model", visibility: ["model"] } },
                },
                {
                  name: "legacy",
                  inputSchema: { type: "object", properties: {} },
                  _meta: { "ui/resourceUri": "ui://wire/legacy" },
                },
                { name: "plain", inputSchema: { type: "object", properties: {} } },
              ],
            }))
            server.setRequestHandler("resources/list", () => ({
              resources: [
                {
                  name: "view",
                  uri: `ui://wire/view-${state.revision}`,
                  mimeType: McpAppResource.MIME_TYPE,
                  _meta: { ui: { prefersBorder: true } },
                },
              ],
            }))
            server.setRequestHandler("resources/read", async (request) => {
              state.reads += 1
              if (state.mode === "delay")
                await new Promise<void>((resolve) => {
                  state.release = resolve
                })
              return {
                contents: [
                  {
                    uri: state.mode === "uri" ? "ui://other/secret" : request.params.uri,
                    mimeType: state.mode === "mime" ? "text/html" : McpAppResource.MIME_TYPE,
                    text:
                      state.mode === "large"
                        ? "中".repeat(87382)
                        : "<!doctype html><html><body>Actual MCP App</body></html>",
                    _meta:
                      state.mode === "fallback"
                        ? {}
                        : {
                            ui:
                              state.mode === "metadata"
                                ? null
                                : {
                                    prefersBorder: false,
                                    csp: { connectDomains: ["https://secret.example"] },
                                    permissions: { camera: {}, clipboardWrite: {} },
                                  },
                          },
                  },
                ],
              }
            })
            server.setRequestHandler("tools/call", () => {
              state.tools += 1
              return { content: [{ type: "text", text: "not called by the resource host" }] }
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
                method?: string
                params?: {
                  capabilities?: { extensions?: Record<string, { mimeTypes?: string[] }> }
                  _meta?: Record<string, unknown>
                }
              }
              if (body.method === "initialize")
                state.appsCapability =
                  body.params?.capabilities?.extensions?.["io.modelcontextprotocol/ui"]?.mimeTypes?.includes(
                    McpAppResource.MIME_TYPE,
                  ) === true
              // The pinned modern protocol carries initialize capabilities in its request envelope.
              const capabilities = body.params?._meta?.["io.modelcontextprotocol/clientCapabilities"]
              if (typeof capabilities === "object" && capabilities !== null && "extensions" in capabilities)
                state.appsCapability = JSON.stringify(capabilities).includes(McpAppResource.MIME_TYPE)
            }
            return handler.fetch(request)
          },
        })
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            state.release?.()
            await handler.close()
            await listener.stop(true)
          }),
        )
        const mcp = yield* MCP.Service
        expect(yield* mcp.appResources!()).toEqual([])
        yield* mcp.add("wire", {
          type: "remote",
          url: new URL("/mcp", listener.url).href,
          oauth: false,
          protocol: "2026-07-28",
        })
        const descriptors = yield* mcp.appResources!()
        expect(descriptors.map((item) => item.tool)).toEqual(["view", "app_only", "model_only", "legacy"])
        expect(descriptors[0]!.toolName).toBe("mcp__wire__view")
        expect(Object.keys(descriptors[0]!)).toEqual([
          "server",
          "tool",
          "toolName",
          "generation",
          "resourceUri",
          "mimeType",
        ])
        expect(Object.keys(yield* mcp.tools())).toEqual(["wire_view", "wire_model_only", "wire_legacy", "wire_plain"])
        expect(state.reads).toBe(0)
        const input = { ...descriptors[0]!, consent: true as const }
        const { toolName, mimeType, ...read } = input
        expect(toolName).toBe("mcp__wire__view")
        expect(mimeType).toBe(McpAppResource.MIME_TYPE)
        expect(
          Exit.isFailure(
            yield* mcp.appResourceRead!({ ...read, consent: false } as unknown as ReadInput).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(Exit.isFailure(yield* mcp.appResourceRead!({ ...read, server: "other" }).pipe(Effect.exit))).toBe(true)
        expect(
          Exit.isFailure(
            yield* mcp.appResourceRead!({ ...read, resourceUri: "ui://wire/arbitrary" }).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(state.reads).toBe(0)
        const view = yield* mcp.appResourceRead!(read)
        expect(view.html).toContain("Actual MCP App")
        expect(view.prefersBorder).toBe(false)
        expect(view.csp).toContain("connect-src 'none'")
        expect(view.csp).toContain("frame-src 'none'")
        expect(view.csp).not.toContain("secret.example")
        expect(yield* mcp.appResourceCheck!({ viewID: view.viewID })).toEqual(view.descriptor)
        state.mode = "fallback"
        const fallback = yield* mcp.appResourceRead!(read)
        expect(fallback.prefersBorder).toBe(true)
        yield* mcp.appResourceClose!({ viewID: fallback.viewID })
        expect(yield* provideTmpdirInstance(() => mcp.appResources!())).toEqual([])
        expect(
          Exit.isFailure(
            yield* provideTmpdirInstance(() => mcp.appResourceCheck!({ viewID: view.viewID })).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(yield* mcp.appResourceCheck!({ viewID: view.viewID })).toEqual(view.descriptor)
        yield* mcp.appResourceClose!({ viewID: view.viewID })
        expect(Exit.isFailure(yield* mcp.appResourceCheck!({ viewID: view.viewID }).pipe(Effect.exit))).toBe(true)
        for (const mode of ["mime", "uri", "large", "metadata"]) {
          state.mode = mode
          expect(Exit.isFailure(yield* mcp.appResourceRead!(read).pipe(Effect.exit))).toBe(true)
        }
        state.mode = "delay"
        const pending = yield* mcp.appResourceRead!(read).pipe(Effect.forkScoped)
        yield* pollWithTimeout(
          Effect.sync(() => (state.release ? true : undefined)),
          "actual resource read not dispatched",
        )
        state.revision = 2
        handler.notify.toolsChanged()
        yield* pollWithTimeout(
          mcp.appResources!().pipe(
            Effect.map((items) => (items[0]?.resourceUri === "ui://wire/view-2" ? true : undefined)),
          ),
          "actual tool snapshot not replaced",
        )
        state.release!()
        expect(Exit.isFailure(yield* Fiber.await(pending))).toBe(true)
        expect(Exit.isFailure(yield* mcp.appResourceRead!(read).pipe(Effect.exit))).toBe(true)
        state.mode = "normal"
        const replacement = (yield* mcp.appResources!())[0]!
        expect(replacement.generation).not.toBe(read.generation)
        const bounded = yield* Effect.forEach(Array.from({ length: McpAppResource.LIMITS.views }), () =>
          mcp.appResourceRead!({
            server: replacement.server,
            tool: replacement.tool,
            generation: replacement.generation,
            resourceUri: replacement.resourceUri,
            consent: true,
          }),
        )
        const atCapacity = state.reads
        expect(
          Exit.isFailure(
            yield* mcp.appResourceRead!({
              server: replacement.server,
              tool: replacement.tool,
              generation: replacement.generation,
              resourceUri: replacement.resourceUri,
              consent: true,
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(state.reads).toBe(atCapacity)
        yield* Effect.forEach(bounded, (view) => mcp.appResourceClose!({ viewID: view.viewID }))
        const current = yield* mcp.appResourceRead!({
          server: replacement.server,
          tool: replacement.tool,
          generation: replacement.generation,
          resourceUri: replacement.resourceUri,
          consent: true,
        })
        yield* mcp.disconnect("wire")
        expect(Exit.isFailure(yield* mcp.appResourceCheck!({ viewID: current.viewID }).pipe(Effect.exit))).toBe(true)
        expect(yield* mcp.appResources!()).toEqual([])
        yield* mcp.connect("wire")
        const reconnected = (yield* mcp.appResources!())[0]!
        expect(reconnected.generation).not.toBe(replacement.generation)
        expect(Exit.isFailure(yield* mcp.appResourceCheck!({ viewID: current.viewID }).pipe(Effect.exit))).toBe(true)
        const authorized = yield* mcp.appResourceRead!({
          server: reconnected.server,
          tool: reconnected.tool,
          generation: reconnected.generation,
          resourceUri: reconnected.resourceUri,
          consent: true,
        })
        const beforeRevoke = state.reads
        const config = yield* Config.Service
        yield* config.update({
          mcp: {
            wire: {
              type: "remote",
              url: new URL("/mcp", listener.url).href,
              oauth: false,
              protocol: "2026-07-28",
              enabled: false,
            },
          },
        })
        expect(Exit.isFailure(yield* mcp.appResourceCheck!({ viewID: authorized.viewID }).pipe(Effect.exit))).toBe(true)
        expect(
          Exit.isFailure(
            yield* mcp.appResourceRead!({
              server: reconnected.server,
              tool: reconnected.tool,
              generation: reconnected.generation,
              resourceUri: reconnected.resourceUri,
              consent: true,
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(state.reads).toBe(beforeRevoke)
        expect(state.tools).toBe(0)
        expect(state.appsCapability).toBe(true)
      }),
    { config: { mcp: {} } },
    30000,
  )
}
