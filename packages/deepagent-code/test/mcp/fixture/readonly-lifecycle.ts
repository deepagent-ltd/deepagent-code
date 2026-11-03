import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Global } from "@deepagent-code/core/global"
import { Config } from "../../../src/config/config"
import { MCP } from "../../../src/mcp/index"
import { oauthHttp } from "../../fixture/mcp-oauth-http"
import { serve } from "../../fixture/http-server"

export function configWatch(directory: string) {
  return Effect.gen(function* () {
    const fixture = yield* oauthHttp
    const file = path.join(directory, "deepagent-code.json")
    const original = JSON.stringify({
      mcp: { fixture: { ...fixture.config, headers: { "x-api-key": "synthetic-preserved" } } },
    })
    yield* Effect.promise(() => fs.writeFile(file, original))
    const mcp = yield* MCP.Service
    const config = yield* Config.Service
    const before = [...fixture.requests]
    const initial = (yield* mcp.status()).fixture
    assert(initial?.status === "disconnected")
    assert.equal(initial.authStatus, "not_authenticated")
    assert.deepEqual(yield* mcp.tools(), {})
    assert.deepEqual(fixture.requests, before)
    assert.equal(yield* Effect.promise(() => fs.readFile(file, "utf8")), original)
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
    yield* Effect.gen(function* () {
      while (!observed.changed) yield* Effect.sleep("20 millis")
    }).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(new Error("MCP config change was not observed")),
      }),
    )
    assert.deepEqual((yield* mcp.status()).fixture, {
      status: "disconnected",
      authStatus: "not_authenticated",
      reason: "scope_changed",
    })
    assert.equal((yield* mcp.finishAuth("fixture", "late-code", pending.oauthState).pipe(Effect.exit))._tag, "Failure")
    assert.deepEqual(fixture.requests, remote)
    assert.deepEqual(yield* Effect.promise(() => fs.readFile(journal)), saved)
    assert.equal(yield* Effect.promise(() => fs.readFile(file, "utf8")), replacement)
    return { configPreserved: true, journalUnchanged: true, lateExchangeRejected: true }
  })
}

export function publicEndpoint(directory: string) {
  return Effect.gen(function* () {
    const fixture = yield* oauthHttp
    fixture.control.open = true
    yield* Effect.promise(() =>
      fs.writeFile(path.join(directory, "deepagent-code.json"), JSON.stringify({ mcp: { public: fixture.config } })),
    )
    const mcp = yield* MCP.Service
    const initial = (yield* mcp.status()).public
    assert(initial?.status === "disconnected")
    assert.equal(initial.authStatus, "not_authenticated")
    assert.deepEqual(yield* mcp.tools(), {})
    assert.equal(fixture.requests.length, 0)
    yield* mcp.connect("public")
    const connected = (yield* mcp.status()).public
    assert.equal(connected?.status, "connected", JSON.stringify(connected))
    assert(fixture.methods.includes("initialize"))
    assert.deepEqual(
      fixture.requests.filter(
        (value) => value.includes("well-known") || value.includes("token") || value.includes("register"),
      ),
      [],
    )
    return { idleReads: true, explicitConnect: true, oauthDiscoveryRequests: 0 }
  })
}

export function refreshRotation() {
  return Effect.gen(function* () {
    const grants: string[] = []
    const state = { accepted: "refresh-1", fail: false }
    const callback = yield* Effect.promise(() => serve(() => new Response()))
    const callbackPort = callback.port
    yield* Effect.promise(() => callback.stop())
    const listener = yield* Effect.promise(() =>
      serve(async (request) => {
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
      }),
    )
    yield* Effect.addFinalizer(() => Effect.promise(() => listener.stop()))
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
    assert.equal((yield* mcp.finishAuth("refresh", "fixture-code", pending.oauthState)).status, "connected")
    assert.deepEqual(grants, ["authorization_code", "refresh_token"])
    state.accepted = "refresh-2"
    yield* mcp.connect("refresh")
    assert.equal((yield* mcp.status()).refresh?.status, "connected")
    assert.deepEqual(grants, ["authorization_code", "refresh_token", "refresh_token"])
    state.accepted = "refresh-3"
    state.fail = true
    yield* mcp.connect("refresh")
    const unknown = (yield* mcp.status()).refresh
    assert(unknown?.status === "disconnected")
    assert.equal(unknown.authStatus, "unknown")
    assert.equal(unknown.reason, "unknown_outcome")
    const journal = path.join(Global.Path.config, "mcp-oauth", "journal.sqlite")
    const saved = yield* Effect.promise(() => fs.readFile(journal))
    assert.equal((yield* mcp.connect("refresh").pipe(Effect.exit))._tag, "Failure")
    assert.deepEqual(grants, ["authorization_code", "refresh_token", "refresh_token", "refresh_token"])
    assert.deepEqual(yield* Effect.promise(() => fs.readFile(journal)), saved)
    return { grants: [...grants], unknownReconnectBlocked: true, journalUnchanged: true }
  })
}
