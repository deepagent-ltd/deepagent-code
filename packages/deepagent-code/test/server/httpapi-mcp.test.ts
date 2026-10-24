import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Context, Effect, Layer } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { McpPaths } from "../../src/server/routes/instance/httpapi/groups/mcp"
import { Server } from "../../src/server/server"
import * as Log from "@deepagent-code/core/util/log"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

if (!process.env.DAC_MCP_HTTP_COMPAT_CHILD) {
  test("authenticated legacy MCP HTTP oracles run with their own actual auth configuration", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-mcp-http-compat-")))
    await Promise.all(["home", "tmp"].map((name) => fs.mkdir(path.join(root, name))))
    // The isolated process must retain CI's original per-case budget; Bun's
    // default 5s can interrupt the actual cold application/DB setup mid-write.
    const child = Bun.spawn([process.execPath, "test", "--timeout", "30000", import.meta.path], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: {
        PATH: process.env.PATH,
        HOME: path.join(root, "home"),
        TMPDIR: path.join(root, "tmp"),
        DAC_MCP_HTTP_COMPAT_CHILD: "1",
        DEEPAGENT_IM_FACADE_URL: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill(), 60000)
    try {
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      await fs.writeFile(path.join(root, "process.log"), stdout + stderr)
      expect({ status, diagnostic: status === 0 ? null : stdout + stderr }).toEqual({ status: 0, diagnostic: null })
      console.info("MCP_HTTP_COMPAT_EVIDENCE", root, stdout + stderr)
    } finally {
      clearTimeout(timer)
      child.kill()
    }
  }, 65000)
}

if (process.env.DAC_MCP_HTTP_COMPAT_CHILD) {
  process.env.DEEPAGENT_CODE_SERVER_PASSWORD = "fixture-current-http-auth"
  const authorization = `Basic ${Buffer.from("deepagent-code:fixture-current-http-auth").toString("base64")}`
  void Log.init({ print: false })

  const context = Context.empty() as Context.Context<unknown>
  const testStateLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      yield* Effect.promise(() => resetDatabase())
      yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()).pipe(Effect.ignore))
    }),
  )
  const it = testEffect(testStateLayer)

  function app() {
    return Server.Default().app
  }
  type TestApp = ReturnType<typeof app>
  type TestHandler = ReturnType<typeof HttpApiApp.webHandler>

  const request = Effect.fnUntraced(function* (
    handler: TestHandler,
    route: string,
    directory: string,
    init?: RequestInit,
  ) {
    const headers = new Headers(init?.headers)
    headers.set("x-deepagent-code-directory", directory)
    headers.set("authorization", authorization)
    return yield* Effect.promise(() =>
      Promise.resolve(
        handler.handler(
          new Request(`http://localhost${route}`, {
            ...init,
            headers,
          }),
          context,
        ),
      ),
    )
  })

  const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>)

  const expectStatus = Effect.fnUntraced(function* (response: Response, expected: number) {
    const diagnostic = response.status === expected ? undefined : yield* Effect.promise(() => response.clone().text())
    expect(response.status, diagnostic).toBe(expected)
  })

  const readResponse = Effect.fnUntraced(function* (input: { app: TestApp; path: string; headers: HeadersInit }) {
    const response = yield* Effect.promise(() =>
      Promise.resolve(input.app.request(input.path, { method: "POST", headers: input.headers })),
    )
    return {
      status: response.status,
      body: yield* Effect.promise(() => response.text()),
    }
  })

  describe("mcp HttpApi", () => {
    it.instance(
      "serves status endpoint",
      () =>
        Effect.gen(function* () {
          const tmp = yield* TestInstance
          const handler = HttpApiApp.webHandler()
          const response = yield* request(handler, McpPaths.status, tmp.directory)

          yield* expectStatus(response, 200)
          expect(yield* json(response)).toEqual({ demo: { status: "disabled" } })
        }),
      {
        config: {
          mcp: {
            demo: {
              type: "local",
              command: ["echo", "demo"],
              enabled: false,
            },
          },
        },
      },
    )

    it.instance(
      "serves add, connect, and disconnect endpoints",
      () =>
        Effect.gen(function* () {
          const tmp = yield* TestInstance
          const handler = HttpApiApp.webHandler()
          const added = yield* request(handler, McpPaths.status, tmp.directory, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: "added",
              config: {
                type: "local",
                command: ["echo", "added"],
                enabled: false,
              },
            }),
          })
          yield* expectStatus(added, 200)
          expect(yield* json(added)).toMatchObject({ added: { status: "disabled" } })

          const addedDisconnected = yield* request(handler, "/mcp/added/disconnect", tmp.directory, { method: "POST" })
          yield* expectStatus(addedDisconnected, 200)
          expect(yield* json(addedDisconnected)).toBe(true)

          const connected = yield* request(handler, "/mcp/demo/connect", tmp.directory, { method: "POST" })
          yield* expectStatus(connected, 200)
          expect(yield* json(connected)).toBe(true)

          const disconnected = yield* request(handler, "/mcp/demo/disconnect", tmp.directory, { method: "POST" })
          yield* expectStatus(disconnected, 200)
          expect(yield* json(disconnected)).toBe(true)
        }),
      {
        config: {
          mcp: {
            demo: {
              type: "local",
              command: ["echo", "demo"],
              enabled: false,
            },
          },
        },
      },
    )

    it.instance(
      "rejects add when mcp installation is denied by ServerCapabilities",
      () =>
        Effect.gen(function* () {
          const KEY = "DEEPAGENT_SERVER_CAPABILITIES"
          const original = process.env[KEY]
          process.env[KEY] = JSON.stringify({ allowMcpInstall: false })
          try {
            const tmp = yield* TestInstance
            const handler = HttpApiApp.webHandler()
            const added = yield* request(handler, McpPaths.status, tmp.directory, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                name: "blocked",
                config: { type: "local", command: ["echo", "blocked"], enabled: false },
              }),
            })
            yield* expectStatus(added, 400)
          } finally {
            if (original === undefined) delete process.env[KEY]
            else process.env[KEY] = original
          }
        }),
      { config: { mcp: {} } },
    )

    it.instance(
      "serves deterministic OAuth endpoints",
      () =>
        Effect.gen(function* () {
          const tmp = yield* TestInstance
          const handler = HttpApiApp.webHandler()
          const start = yield* request(handler, "/mcp/demo/auth", tmp.directory, { method: "POST" })
          yield* expectStatus(start, 400)

          const authenticate = yield* request(handler, "/mcp/demo/auth/authenticate", tmp.directory, { method: "POST" })
          yield* expectStatus(authenticate, 400)

          const removed = yield* request(handler, "/mcp/demo/auth", tmp.directory, { method: "DELETE" })
          yield* expectStatus(removed, 200)
          expect(yield* json(removed)).toEqual({ success: true })
        }),
      {
        config: {
          mcp: {
            demo: {
              type: "local",
              command: ["echo", "demo"],
              enabled: false,
            },
          },
        },
      },
    )

    it.instance(
      "returns unsupported OAuth error responses",
      () =>
        Effect.gen(function* () {
          const tmp = yield* TestInstance
          const dir = tmp.directory
          const headers = { "x-deepagent-code-directory": dir, authorization }

          yield* Effect.forEach(["/mcp/demo/auth", "/mcp/demo/auth/authenticate"], (path) =>
            Effect.gen(function* () {
              const response = yield* readResponse({ app: app(), path, headers })

              expect(response).toEqual({
                status: 400,
                body: JSON.stringify({ error: "MCP server demo does not support OAuth" }),
              })
            }),
          )
        }),
      {
        config: {
          formatter: false,
          lsp: false,
          mcp: {
            demo: {
              type: "local",
              command: ["echo", "demo"],
              enabled: false,
            },
          },
        },
      },
    )

    it.instance(
      "returns typed not found errors for missing MCP servers",
      () =>
        Effect.gen(function* () {
          const tmp = yield* TestInstance
          const handler = HttpApiApp.webHandler()

          for (const input of [
            { method: "POST", route: "/mcp/missing/auth" },
            { method: "POST", route: "/mcp/missing/auth/authenticate" },
            {
              method: "POST",
              route: "/mcp/missing/auth/callback",
              body: JSON.stringify({ code: "code", oauthState: "fixture-state" }),
            },
            { method: "DELETE", route: "/mcp/missing/auth" },
            { method: "POST", route: "/mcp/missing/connect" },
            { method: "POST", route: "/mcp/missing/disconnect" },
          ]) {
            const response = yield* request(handler, input.route, tmp.directory, {
              method: input.method,
              headers: input.body ? { "content-type": "application/json" } : undefined,
              body: input.body,
            })

            yield* expectStatus(response, 404)
            expect(yield* json(response)).toEqual({
              _tag: "McpServerNotFoundError",
              name: "missing",
              message: "MCP server not found: missing",
            })
          }
        }),
      { config: { mcp: {} } },
    )
  })
}
