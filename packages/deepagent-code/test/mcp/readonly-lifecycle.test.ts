import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Global } from "@deepagent-code/core/global"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import { oauthHttp } from "../fixture/mcp-oauth-http"
import { Config } from "../../src/config/config"
import { MCP } from "../../src/mcp/index"

const it = testEffect(Layer.mergeAll(MCP.defaultLayer, Config.defaultLayer, CrossSpawnSpawner.defaultLayer))

it.instance(
  "actual config watch fences a pending scope without OAuth, secret migration or journal writes",
  () =>
    Effect.gen(function* () {
      const fixture = yield* oauthHttp
      const instance = yield* TestInstance
      const file = path.join(instance.directory, "deepagent-code.json")
      const original = JSON.stringify({
        mcp: { fixture: { ...fixture.config, headers: { "x-api-key": "synthetic-preserved" } } },
      })
      yield* Effect.promise(() => fs.writeFile(file, original))
      const mcp = yield* MCP.Service
      const config = yield* Config.Service
      const before = [...fixture.requests]
      expect((yield* mcp.status()).fixture).toMatchObject({ status: "disconnected", authStatus: "not_authenticated" })
      expect(yield* mcp.tools()).toEqual({})
      expect(fixture.requests).toEqual(before)
      expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(original)
      const pending = yield* mcp.startAuth("fixture")
      const journal = path.join(Global.Path.config, "mcp-oauth", "journal.sqlite")
      const saved = yield* Effect.promise(() => fs.readFile(journal))
      const remote = [...fixture.requests]
      const observed = { changed: false }
      const stop = yield* config.watch!(
        () =>
          Effect.gen(function* () {
            yield* mcp.reconcileConfig!()
            observed.changed = true
          }),
        { mcpOnly: true },
      )
      yield* Effect.addFinalizer(() => Effect.sync(stop))
      const replacement = JSON.stringify({
        mcp: { fixture: { ...fixture.config, timeout: 1750, headers: { "x-api-key": "synthetic-replacement" } } },
      })
      yield* Effect.promise(() => fs.writeFile(file, replacement))
      yield* pollWithTimeout(
        Effect.sync(() => (observed.changed ? true : undefined)),
        "MCP config change was not observed",
      )
      expect((yield* mcp.status()).fixture).toEqual({
        status: "disconnected",
        authStatus: "not_authenticated",
        reason: "scope_changed",
      })
      expect((yield* mcp.finishAuth("fixture", "late-code", pending.oauthState).pipe(Effect.exit))._tag).toBe("Failure")
      expect(fixture.requests).toEqual(remote)
      expect(yield* Effect.promise(() => fs.readFile(journal))).toEqual(saved)
      expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(replacement)
    }),
  { config: { mcp: {} } },
)

it.instance(
  "OAuth-optional public endpoints stay idle on reads and connect only on an explicit action",
  () =>
    Effect.gen(function* () {
      const fixture = yield* oauthHttp
      fixture.control.open = true
      const instance = yield* TestInstance
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(instance.directory, "deepagent-code.json"),
          JSON.stringify({ mcp: { public: fixture.config } }),
        ),
      )
      const mcp = yield* MCP.Service
      expect((yield* mcp.status()).public).toMatchObject({ status: "disconnected", authStatus: "not_authenticated" })
      expect(yield* mcp.tools()).toEqual({})
      expect(fixture.requests).toEqual([])
      yield* mcp.connect("public")
      expect((yield* mcp.status()).public.status).toBe("connected")
      expect(fixture.methods).toContain("initialize")
      expect(
        fixture.requests.filter(
          (value) => value.includes("well-known") || value.includes("token") || value.includes("register"),
        ),
      ).toEqual([])
    }),
  { config: { mcp: {} } },
)

it.instance(
  "actual SDK refresh rotates each credential revision once and an unknown later refresh blocks reconnect",
  () =>
    Effect.gen(function* () {
      const grants: string[] = []
      const state = { accepted: "refresh-1", fail: false }
      const callback = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
      const callbackPort = callback.port!
      yield* Effect.promise(() => callback.stop(true))
      const listener = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const url = new URL(request.url)
          if (url.pathname.includes("oauth-protected-resource"))
            return Response.json({ resource: `${url.origin}/mcp`, authorization_servers: [url.origin] })
          if (url.pathname.includes("oauth-authorization-server") || url.pathname.includes("openid-configuration"))
            return Response.json({
              issuer: url.origin,
              authorization_endpoint: `${url.origin}/authorize`,
              token_endpoint: `${url.origin}/token`,
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
            })
          if (url.pathname === "/token") {
            const grant = new URLSearchParams(await request.text()).get("grant_type") ?? "missing"
            grants.push(grant)
            if (state.fail) return new Response(null, { status: 502 })
            return Response.json({
              access_token: grant === "authorization_code" ? "initial-expired" : state.accepted,
              refresh_token: `synthetic-refresh-${grants.length}`,
              token_type: "Bearer",
              expires_in: grant === "authorization_code" ? 0 : 600,
            })
          }
          if (request.method === "DELETE") return new Response(null, { status: 204 })
          if (request.headers.get("authorization") !== `Bearer ${state.accepted}`)
            return new Response(null, {
              status: 401,
              headers: {
                "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
              },
            })
          if (request.method === "GET") return new Response(null, { status: 405 })
          const body = (await request.json()) as { id?: number; method: string }
          if (body.id === undefined) return new Response(null, { status: 202 })
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result:
              body.method === "initialize"
                ? {
                    protocolVersion: "2025-11-25",
                    serverInfo: { name: "refresh-fixture", version: "1" },
                    capabilities: { tools: {} },
                  }
                : { tools: [] },
          })
        },
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => listener.stop(true)))
      const mcp = yield* MCP.Service
      const config = yield* Config.Service
      yield* config.update({
        mcp: {
          refresh: {
            type: "remote",
            url: new URL("/mcp", listener.url).href,
            oauth: { clientId: "fixture", callbackPort },
          },
        },
      })
      const pending = yield* mcp.startAuth("refresh")
      expect((yield* mcp.finishAuth("refresh", "fixture-code", pending.oauthState)).status).toBe("connected")
      expect(grants).toEqual(["authorization_code", "refresh_token"])
      state.accepted = "refresh-2"
      yield* mcp.connect("refresh")
      expect((yield* mcp.status()).refresh.status).toBe("connected")
      expect(grants).toEqual(["authorization_code", "refresh_token", "refresh_token"])
      state.accepted = "refresh-3"
      state.fail = true
      yield* mcp.connect("refresh")
      expect((yield* mcp.status()).refresh).toMatchObject({
        status: "disconnected",
        authStatus: "unknown",
        reason: "unknown_outcome",
      })
      const saved = yield* Effect.promise(() =>
        fs.readFile(path.join(Global.Path.config, "mcp-oauth", "journal.sqlite")),
      )
      expect((yield* mcp.connect("refresh").pipe(Effect.exit))._tag).toBe("Failure")
      expect(grants).toEqual(["authorization_code", "refresh_token", "refresh_token", "refresh_token"])
      expect(
        yield* Effect.promise(() => fs.readFile(path.join(Global.Path.config, "mcp-oauth", "journal.sqlite"))),
      ).toEqual(saved)
    }),
  { config: { mcp: {} } },
)
