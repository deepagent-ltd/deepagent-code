import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Exit, Layer, Option, Scope } from "effect"
import { sql } from "drizzle-orm"
import { testEffect } from "../lib/effect"
import { tmpdirScoped, provideInstance } from "../fixture/fixture"
import { InstanceRef } from "../../src/effect/instance-ref"
import { McpAuthScope } from "../../src/mcp/auth-scope"
import { McpAuthJournalSchema } from "../../src/mcp/auth-journal-schema"
import { McpAuth } from "../../src/mcp/auth"
import { MCP } from "../../src/mcp/index"
import { oauthHttp } from "../fixture/mcp-oauth-http"
import { Config } from "../../src/config/config"
import { LocalAuthority } from "../../src/installation/local-authority"
import { AccountRepo } from "../../src/account/repo"
import { Account } from "../../src/account/account"
import { AccountID, AccessToken, RefreshToken, OrgID } from "../../src/account/schema"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Database } from "@deepagent-code/core/database/database"
import { Global } from "@deepagent-code/core/global"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { SecretStore } from "../../src/mcp/secret-store"
import { McpOAuthProvider } from "../../src/mcp/oauth-provider"
import { SecretRefScope } from "../../src/mcp/secret-ref-scope"
import type { McpWindowsStorage } from "../../src/mcp/windows-storage"
import type { Codec } from "../../src/mcp/dpapi"
import { WindowsPrivateStorage } from "../../src/installation/windows-private-storage"
import { windowsMcpStorage } from "../fixture/windows-mcp-storage"

const it = testEffect(
  Layer.mergeAll(
    MCP.defaultLayer,
    McpAuthScope.defaultLayer,
    McpAuth.defaultLayer,
    Config.defaultLayer,
    AccountRepo.defaultLayer,
    Account.defaultLayer,
    Database.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
  windowsMcpStorage,
)
const config = { type: "remote" as const, url: "http://127.0.0.1:9/mcp", oauth: { clientId: "fixture-client" } }

it.instance(
  "original OAuth provider auth callbacks preserve the captured Root context and retire with their flow",
  () => Effect.gen(function* () {
    const root = Context.Reference<string | undefined>("test/McpAuthFlowRoot", { defaultValue: () => undefined })
    const accounts = yield* AccountRepo.Service
    const observed: (string | undefined)[] = []
    const context = yield* Layer.build(Layer.fresh(McpAuthScope.layer).pipe(
      Layer.provide(SecretStore.defaultLayer),
      Layer.provide(LocationIdentity.defaultLayer),
    )).pipe(Effect.provideService(AccountRepo.Service, {
      ...accounts,
      authority: () => Effect.gen(function* () {
        const value = yield* root
        observed.push(value)
        expect(value).toBe("flow-root")
        return yield* accounts.authority()
      }),
    }))
    const scope = Context.get(context, McpAuthScope.Service)
    yield* scope.configure("root-callback", config)
    const flow = yield* scope.begin("root-callback", config, false).pipe(Effect.provideService(root, "flow-root"))
    yield* Effect.addFinalizer(() => Effect.sync(flow.close))
    const provider = new McpOAuthProvider("root-callback", config.url, config.oauth, {
      onRedirect: () => undefined,
      current: flow.current,
      authorizationGeneration: flow.state,
    }, flow.auth)

    expect((yield* Effect.promise(() => provider.clientInformation()))?.client_id).toBe("fixture-client")
    yield* Effect.promise(() => provider.saveCodeVerifier("v".repeat(43)))
    expect(yield* Effect.promise(() => provider.codeVerifier())).toBe("v".repeat(43))
    expect(observed.length).toBeGreaterThan(2)
    expect(observed.every((value) => value === "flow-root")).toBe(true)
    flow.close()
    expect(yield* Effect.promise(() => provider.clientInformation()).pipe(Effect.exit, Effect.map((exit) => exit._tag))).toBe("Failure")
  }),
  { config: { mcp: {} } },
)

it.instance(
  "transient configuration capacity refuses before connecting and never evicts an original live flow",
  () => Effect.gen(function* () {
    const scope = yield* McpAuthScope.Service
    yield* Effect.forEach(Array.from({ length: McpAuthJournalSchema.LIMITS.slots }, (_, n) => `bounded-${n}`),
      (name) => scope.configure(name, config), { discard: true, concurrency: 16 })
    const original = yield* scope.begin("bounded-0", config, false)
    yield* Effect.addFinalizer(() => Effect.sync(original.close))
    expect(yield* scope.configure("overflow", config).pipe(Effect.match({ onFailure: (error) => error.reason, onSuccess: () => "accepted" }))).toBe("capacity")
    expect(yield* Effect.promise(original.current)).toBe(true)
    const mcp = yield* MCP.Service
    expect(yield* mcp.add("overflow", { ...config, enabled: false }).pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => "accepted" }))).toBe("MCP authentication journal capacity")
    expect((yield* mcp.status()).overflow).toBeUndefined()
    const replacement = { ...config, url: "http://127.0.0.1:8/mcp" }
    yield* scope.configure("bounded-0", replacement)
    expect(yield* Effect.promise(original.current)).toBe(false)
    const current = yield* scope.begin("bounded-0", replacement, false)
    yield* Effect.addFinalizer(() => Effect.sync(current.close))
    expect(yield* Effect.promise(current.current)).toBe(true)
    yield* scope.retire("bounded-0")
    expect(yield* Effect.promise(current.current)).toBe(false)
    yield* scope.configure("overflow", config)
    expect(yield* scope.configure("overflow-next", config).pipe(Effect.match({ onFailure: (error) => error.reason, onSuccess: () => "accepted" }))).toBe("capacity")
  }),
  { config: { mcp: {} } },
)

it.instance(
  "persisting the exact source retires only its transient witness and frees capacity without reviving the old flow",
  () => Effect.gen(function* () {
    const scope = yield* McpAuthScope.Service
    yield* Effect.forEach(Array.from({ length: McpAuthJournalSchema.LIMITS.slots }, (_, n) => `persisted-${n}`),
      (name) => scope.configure(name, config), { discard: true })
    const old = yield* scope.begin("persisted-0", config, false)
    yield* Effect.addFinalizer(() => Effect.sync(old.close))
    const other = yield* scope.begin("persisted-1", config, false)
    yield* Effect.addFinalizer(() => Effect.sync(other.close))
    yield* (yield* Config.Service).update({ mcp: { "persisted-0": config } })
    yield* scope.configure("persisted-0", config)
    expect(yield* Effect.promise(old.current)).toBe(false)
    expect(yield* Effect.promise(other.current)).toBe(false)
    const surviving = yield* scope.begin("persisted-1", config, false)
    yield* Effect.addFinalizer(() => Effect.sync(surviving.close))
    expect(yield* Effect.promise(surviving.current)).toBe(true)
    yield* scope.configure("new-transient", config)
    expect(yield* scope.configure("second-new-transient", config).pipe(Effect.match({ onFailure: (error) => error.reason, onSuccess: () => "accepted" }))).toBe("capacity")
    const durable = yield* scope.begin("persisted-0", config, false)
    yield* Effect.addFinalizer(() => Effect.sync(durable.close))
    expect(yield* Effect.promise(durable.current)).toBe(true)
  }),
  { config: { mcp: {} } },
)

it.instance(
  "a local principal needs neither a DAC account nor enrolled IM operator and two real locations isolate the same name",
  () =>
    Effect.gen(function* () {
      const scope = yield* McpAuthScope.Service
      const repo = yield* AccountRepo.Service
      const before = yield* repo.authority()
      yield* scope.configure("same", config)
      const a = yield* scope.begin("same", config, false)
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await a.revoke()
          a.close()
        }),
      )
      const directory = yield* tmpdirScoped({ config: { mcp: {} } })
      const b = yield* InstanceRef.pipe(provideInstance(directory))
      yield* scope.configure("same", config).pipe(Effect.provideService(InstanceRef, b))
      const other = yield* scope.begin("same", config, false).pipe(Effect.provideService(InstanceRef, b))
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await other.revoke()
          other.close()
        }),
      )
      expect(a.state).not.toBe(other.state)
      expect(yield* Effect.promise(a.current)).toBe(true)
      expect(yield* Effect.promise(other.current)).toBe(true)
      expect(yield* repo.authority()).toEqual(before)
      expect((yield* LocalAuthority.readInstallation).instanceID).toMatch(/^local_[a-f0-9]{32}$/)
      const db = (yield* Database.Service).db
      expect(yield* db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM local_operator_authority`)).toEqual({ n: 0 })
      expect(yield* McpAuth.use.get("same")).toBeUndefined()
    }),
  { config: { mcp: {} } },
)

it.instance(
  "temporary-to-persisted configuration and later edits fence the old flow without sending HTTP",
  () =>
    Effect.gen(function* () {
      const scope = yield* McpAuthScope.Service
      const settings = yield* Config.Service
      yield* scope.configure("temporary", config)
      const first = yield* scope.begin("temporary", config, false)
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await first.revoke()
          first.close()
        }),
      )
      expect(yield* Effect.promise(first.current)).toBe(true)
      yield* settings.update({ mcp: { temporary: config } })
      expect(yield* Effect.promise(first.current)).toBe(false)
      const second = yield* scope.begin("temporary", config, false)
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await second.revoke()
          second.close()
        }),
      )
      expect(yield* Effect.promise(second.current)).toBe(true)
      yield* settings.update({ mcp: { temporary: { ...config, url: "http://127.0.0.1:8/mcp" } } })
      expect(yield* Effect.promise(second.current)).toBe(false)
    }),
  { config: { mcp: {} } },
)

it.instance(
  "actual account identity and organization verification reject foreign selection and fence an earlier local flow",
  () =>
    Effect.gen(function* () {
      const requests: string[] = []
      const listener = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          requests.push(new URL(request.url).pathname)
          if (request.headers.get("authorization") !== "Bearer fixture-account-token")
            return new Response(null, { status: 401 })
          return Response.json(
            new URL(request.url).pathname === "/api/user"
              ? { id: "scope-account", email: "fixture@example.invalid" }
              : [{ id: "org-one", name: "Fixture" }],
          )
        },
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => listener.stop(true)))
      const scope = yield* McpAuthScope.Service
      const repo = yield* AccountRepo.Service
      const account = yield* Account.Service
      yield* scope.configure("account", config)
      const local = yield* scope.begin("account", config, false)
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await local.revoke()
          local.close()
        }),
      )
      yield* repo.persistAccount({
        id: AccountID.make("scope-account"),
        email: "fixture@example.invalid",
        url: listener.url.origin,
        accessToken: AccessToken.make("fixture-account-token"),
        refreshToken: RefreshToken.make("fixture-refresh"),
        expiry: Date.now() + 3600000,
        orgID: Option.some(OrgID.make("org-one")),
      })
      expect(yield* Effect.promise(local.current)).toBe(false)
      const selected = yield* repo.authority()
      const bad = yield* account
        .use(AccountID.make("scope-account"), Option.some(OrgID.make("foreign-org")))
        .pipe(Effect.exit)
      expect(bad._tag).toBe("Failure")
      expect(yield* repo.authority()).toEqual(selected)
      const authenticated = yield* scope.begin("account", config, false)
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await authenticated.revoke()
          authenticated.close()
        }),
      )
      expect(yield* Effect.promise(authenticated.current)).toBe(true)
      expect(requests.filter((value) => value === "/api/user").length).toBeGreaterThan(0)
      expect(requests.filter((value) => value === "/api/orgs").length).toBeGreaterThan(0)
      yield* repo.remove(AccountID.make("scope-account"))
      expect(yield* Effect.promise(authenticated.current)).toBe(false)
    }),
  { config: { mcp: {} } },
)

it.instance(
  "read-only metadata leaves a legacy credential file byte-identical and does not adopt its token",
  () =>
    Effect.gen(function* () {
      const auth = yield* McpAuth.Service
      yield* auth.set("legacy-only", {
        serverUrl: config.url,
        tokens: { accessToken: "synthetic-old-token", issuer: "http://127.0.0.1:9" },
      })
      const before = yield* Effect.promise(() => fs.readFile(path.join(Global.Path.config, "mcp-auth.json")))
      const metadata = yield* (yield* McpAuthScope.Service).metadata("legacy-only", config)
      expect(metadata).toEqual({ tokens: false, expired: false, unknown: false, legacy: true })
      expect(yield* Effect.promise(() => fs.readFile(path.join(Global.Path.config, "mcp-auth.json")))).toEqual(before)
    }),
  { config: { mcp: { "legacy-only": config } } },
)

it.instance(
  "an observed remote configuration cannot move across the real account selection epoch",
  () =>
    Effect.gen(function* () {
      const listener = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const route = new URL(request.url).pathname
          if (request.headers.get("authorization") !== "Bearer source-token") return new Response(null, { status: 401 })
          if (route === "/api/config") return Response.json({ config: { mcp: { remote: config } } })
          if (route === "/api/user") return Response.json({ id: "source-account", email: "fixture@example.invalid" })
          return Response.json([{ id: "org-source", name: "Source" }])
        },
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => listener.stop(true)))
      const repo = yield* AccountRepo.Service
      yield* repo.persistAccount({
        id: AccountID.make("source-account"),
        email: "fixture@example.invalid",
        url: listener.url.origin,
        accessToken: AccessToken.make("source-token"),
        refreshToken: RefreshToken.make("source-refresh"),
        expiry: Date.now() + 3600000,
        orgID: Option.some(OrgID.make("org-source")),
      })
      yield* Effect.addFinalizer(() => repo.remove(AccountID.make("source-account")).pipe(Effect.ignore))
      const settings = yield* Config.Service
      expect((yield* settings.get()).mcp?.remote).toEqual(config)
      const scope = yield* McpAuthScope.Service
      const first = yield* scope.begin("remote", config, false)
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await first.revoke()
          first.close()
        }),
      )
      yield* (yield* Account.Service).use(AccountID.make("source-account"), Option.some(OrgID.make("org-source")))
      expect(yield* Effect.promise(first.current)).toBe(false)
      const rejected = yield* scope.begin("remote", config, false).pipe(Effect.exit)
      expect(rejected._tag).toBe("Failure")
      yield* settings.invalidate()
      yield* settings.get()
      const second = yield* scope.begin("remote", config, false)
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await second.revoke()
          second.close()
        }),
      )
      expect(yield* Effect.promise(second.current)).toBe(true)
    }),
  { config: { mcp: {} } },
)

it.instance(
  "account A to B to A selection cannot revive an old actual SDK callback or mutate its private journal",
  () =>
    Effect.gen(function* () {
      const fixture = yield* oauthHttp
      const accountServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          if (request.headers.get("authorization") !== "Bearer aba-account-token")
            return new Response(null, { status: 401 })
          return Response.json(
            new URL(request.url).pathname === "/api/user"
              ? { id: "aba-account", email: "fixture@example.invalid" }
              : [
                  { id: "org-a", name: "A" },
                  { id: "org-b", name: "B" },
                ],
          )
        },
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => accountServer.stop(true)))
      const repo = yield* AccountRepo.Service
      const account = yield* Account.Service
      yield* repo.persistAccount({
        id: AccountID.make("aba-account"),
        email: "fixture@example.invalid",
        url: accountServer.url.origin,
        accessToken: AccessToken.make("aba-account-token"),
        refreshToken: RefreshToken.make("aba-refresh"),
        expiry: Date.now() + 3600000,
        orgID: Option.some(OrgID.make("org-a")),
      })
      yield* Effect.addFinalizer(() => repo.remove(AccountID.make("aba-account")).pipe(Effect.ignore))
      yield* (yield* Config.Service).update({ mcp: { aba: fixture.config } })
      const mcp = yield* MCP.Service
      const pending = yield* mcp.startAuth("aba")
      const before = yield* repo.authority()
      yield* account.use(AccountID.make("aba-account"), Option.some(OrgID.make("org-b")))
      yield* account.use(AccountID.make("aba-account"), Option.some(OrgID.make("org-a")))
      expect((yield* repo.authority()).selectionRevision).toBe(before.selectionRevision + 2)
      const journal = path.join(Global.Path.config, "mcp-oauth", "journal.sqlite")
      const bytes = yield* Effect.promise(() => fs.readFile(journal))
      const requests = [...fixture.requests]
      expect((yield* mcp.finishAuth("aba", "late-code", pending.oauthState).pipe(Effect.exit))._tag).toBe("Failure")
      expect(fixture.requests).toEqual(requests)
      expect(fixture.requests.filter((request) => request === "POST /token")).toEqual([])
      expect(yield* Effect.promise(() => fs.readFile(journal))).toEqual(bytes)
      expect((yield* mcp.status()).aba).toMatchObject({ status: "disconnected", reason: "scope_changed" })
    }),
  { config: { mcp: {} } },
)

it.instance(
  "two actual clients at one durable source compete for one private flow",
  () =>
    Effect.gen(function* () {
      yield* (yield* Config.Service).update({ mcp: { exclusive: config } })
      const scope = yield* McpAuthScope.Service
      const owner = yield* scope.begin("exclusive", config, false)
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await owner.revoke()
          owner.close()
        }),
      )
      expect((yield* scope.begin("exclusive", config, false).pipe(Effect.exit))._tag).toBe("Failure")
      expect(yield* Effect.promise(owner.current)).toBe(true)
    }),
  { config: { mcp: {} } },
)


it.instance(
  "scoped HTTP dispatch checks its real scope once per ordinary request without caching across requests",
  () => Effect.gen(function* () {
    const accounts = yield* AccountRepo.Service
    const captures = { count: 0 }
    const context = yield* Layer.build(Layer.fresh(McpAuthScope.layer).pipe(
      Layer.provide(SecretStore.defaultLayer),
      Layer.provide(LocationIdentity.defaultLayer),
    )).pipe(Effect.provideService(AccountRepo.Service, {
      ...accounts,
      authority: () => accounts.authority().pipe(Effect.tap(() => Effect.sync(() => captures.count++))),
    }))
    const calls: string[] = []
    const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      calls.push(`${request.method} ${new URL(request.url).pathname}`)
      return Response.json({ ok: true })
    } })
    yield* Effect.addFinalizer(() => Effect.promise(() => listener.stop(true)))
    const scope = Context.get(context, McpAuthScope.Service)
    const remote = { ...config, url: new URL("/mcp", listener.url).href }
    yield* scope.configure("http-once", remote)
    const flow = yield* scope.begin("http-once", remote, false)
    yield* Effect.addFinalizer(() => Effect.sync(flow.close))
    const before = captures.count
    const fences = { count: 0 }
    for (const method of ["POST", "GET"]) {
      const response = yield* Effect.promise(() => flow.fetch(remote.url, { method }, () => {
        fences.count++
        return undefined
      }))
      expect(response.status).toBe(200)
      yield* Effect.promise(() => response.arrayBuffer())
    }
    expect(captures.count - before).toBe(2)
    expect(fences.count).toBe(2)
    expect(calls).toEqual(["POST /mcp", "GET /mcp"])
  }),
  { config: { mcp: {} } },
)

it.instance(
  "scoped HTTP dispatch rejects an owner revoked during its full asynchronous scope check",
  () => Effect.gen(function* () {
    const accounts = yield* AccountRepo.Service
    const owner = { current: true, armed: false }
    const context = yield* Layer.build(Layer.fresh(McpAuthScope.layer).pipe(
      Layer.provide(SecretStore.defaultLayer),
      Layer.provide(LocationIdentity.defaultLayer),
    )).pipe(Effect.provideService(AccountRepo.Service, {
      ...accounts,
      authority: () => accounts.authority().pipe(Effect.tap(() => Effect.sync(() => {
        if (owner.armed) owner.current = false
      }))),
    }))
    const calls: string[] = []
    const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      calls.push(request.method)
      return new Response()
    } })
    yield* Effect.addFinalizer(() => Effect.promise(() => listener.stop(true)))
    const scope = Context.get(context, McpAuthScope.Service)
    const remote = { ...config, url: new URL("/mcp", listener.url).href }
    yield* scope.configure("http-owner", remote)
    const flow = yield* scope.begin("http-owner", remote, false)
    yield* Effect.addFinalizer(() => Effect.sync(flow.close))
    owner.armed = true
    expect((yield* Effect.promise(() => flow.fetch(remote.url, undefined, () => {
      if (!owner.current) throw new Error("owner revoked")
      return undefined
    })).pipe(Effect.exit))._tag).toBe("Failure")
    expect(owner.current).toBe(false)
    expect(calls).toEqual([])
  }),
  { config: { mcp: {} } },
)

it.instance(
  "scoped HTTP dispatch retains its final durable journal fence after the full scope snapshot",
  () => Effect.gen(function* () {
    const fixture = yield* oauthHttp
    const scope = yield* McpAuthScope.Service
    yield* scope.configure("http-journal", fixture.config)
    const flow = yield* scope.begin("http-journal", fixture.config, false)
    yield* Effect.addFinalizer(() => Effect.sync(flow.close))
    const retired: Promise<void>[] = []
    expect((yield* Effect.promise(() => flow.fetch(fixture.config.url, undefined, () => {
      // revoke changes the real journal synchronously before returning its promise.
      retired.push(flow.revoke())
      return undefined
    })).pipe(Effect.exit))._tag).toBe("Failure")
    yield* Effect.promise(() => Promise.all(retired))
    expect(fixture.requests).toEqual([])
    expect(yield* Effect.promise(flow.current)).toBe(false)
  }),
  { config: { mcp: {} } },
)

it.instance(
  "scoped OAuth mutation checks the owner inside the identity gate before recording any dispatch",
  () => Effect.gen(function* () {
    const fixture = yield* oauthHttp
    const scope = yield* McpAuthScope.Service
    yield* scope.configure("http-mutation", fixture.config)
    const flow = yield* scope.begin("http-mutation", fixture.config, false, true)
    yield* Effect.addFinalizer(() => Effect.sync(flow.close))
    yield* flow.auth.updateDiscoveryState("http-mutation", {
      authorizationServerUrl: new URL(fixture.config.url).origin,
    }, fixture.config.url, flow.state)
    const journal = path.join(Global.Path.config, "mcp-oauth", "journal.sqlite")
    const before = yield* Effect.promise(() => fs.readFile(journal))
    expect((yield* Effect.promise(() => flow.fetch(new URL("/register", fixture.config.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }, () => { throw new Error("owner revoked") })).pipe(Effect.exit))._tag).toBe("Failure")
    expect(fixture.requests).toEqual([])
    expect(yield* Effect.promise(() => fs.readFile(journal))).toEqual(before)
    expect(yield* Effect.promise(flow.current)).toBe(true)
  }),
  { config: { mcp: {} } },
)

it.instance(
  "scoped provider writes retain one real full proof per durable mutation without duplicate reads",
  () =>
    Effect.gen(function* () {
      const accounts = yield* AccountRepo.Service
      const captures = { count: 0 }
      const context = yield* Layer.build(
        Layer.fresh(McpAuthScope.layer).pipe(
          Layer.provide(SecretStore.defaultLayer),
          Layer.provide(LocationIdentity.defaultLayer),
        ),
      ).pipe(
        Effect.provideService(AccountRepo.Service, {
          ...accounts,
          authority: () => accounts.authority().pipe(Effect.tap(() => Effect.sync(() => captures.count++))),
        }),
      )
      const scope = Context.get(context, McpAuthScope.Service)
      yield* scope.configure("provider-write", config)
      const flow = yield* scope.begin("provider-write", config, false)
      yield* Effect.addFinalizer(() => Effect.sync(flow.close))
      const owner = { current: true, checks: 0 }
      const provider = new McpOAuthProvider(
        "provider-write",
        config.url,
        config.oauth,
        {
          onRedirect: () => undefined,
          currentEntry: () => Effect.runPromise(flow.auth.getForUrl("provider-write", config.url)),
          currentLocal: () => {
            owner.checks++
            return owner.current
          },
          authorizationGeneration: flow.state,
        },
        flow.auth,
      )
      const before = captures.count
      yield* Effect.promise(() => provider.saveDiscoveryState({ authorizationServerUrl: "http://127.0.0.1:9" }))
      expect(captures.count - before).toBe(1)
      expect((yield* flow.auth.getForUrl("provider-write", config.url))?.discoveryState?.authorizationServerUrl).toBe(
        "http://127.0.0.1:9",
      )
      const next = captures.count
      yield* Effect.promise(() => provider.saveCodeVerifier("v".repeat(43)))
      expect(captures.count - next).toBe(1)
      expect((yield* flow.auth.getForUrl("provider-write", config.url))?.codeVerifier).toBe("v".repeat(43))
      expect(owner.checks).toBeGreaterThanOrEqual(6)
    }),
  { config: { mcp: {} } },
)
;["owner", "configuration"].forEach((reason) =>
  it.instance(
    `scoped provider discovery parse rejects ${reason} change before its real durable mutation`,
    () =>
      Effect.gen(function* () {
        const scope = yield* McpAuthScope.Service
        const name = `provider-parse-${reason}`
        yield* scope.configure(name, config)
        const flow = yield* scope.begin(name, config, false)
        yield* Effect.addFinalizer(() => Effect.sync(flow.close))
        const owner = { current: true, first: true }
        const settings: { clientId: string; clientSecret?: string } = { clientId: "fixture-client" }
        const provider = new McpOAuthProvider(
          name,
          config.url,
          settings,
          {
            onRedirect: () => undefined,
            currentEntry: () => Effect.runPromise(flow.auth.getForUrl(name, config.url)),
            currentLocal: () => {
              if (owner.first) {
                owner.first = false
                queueMicrotask(() => {
                  if (reason === "owner") owner.current = false
                  if (reason === "configuration") settings.clientSecret = ""
                })
              }
              return owner.current
            },
            authorizationGeneration: flow.state,
          },
          flow.auth,
        )
        const journal = path.join(Global.Path.config, "mcp-oauth", "journal.sqlite")
        const before = yield* Effect.promise(() => fs.readFile(journal))
        expect(
          (yield* Effect.promise(() =>
            provider.saveDiscoveryState({ authorizationServerUrl: "http://127.0.0.1:9" }),
          ).pipe(Effect.exit))._tag,
        ).toBe("Failure")
        expect(yield* Effect.promise(() => fs.readFile(journal))).toEqual(before)
        expect((yield* flow.auth.getForUrl(name, config.url))?.discoveryState).toBeUndefined()
      }),
    { config: { mcp: {} } },
  ),
)

it.instance(
  "scoped provider writes reject changed real scope proof even while the process owner remains current",
  () =>
    Effect.gen(function* () {
      const scope = yield* McpAuthScope.Service
      yield* scope.configure("provider-proof", config)
      const flow = yield* scope.begin("provider-proof", config, false)
      yield* Effect.addFinalizer(() => Effect.sync(flow.close))
      const provider = new McpOAuthProvider(
        "provider-proof",
        config.url,
        config.oauth,
        {
          onRedirect: () => undefined,
          currentEntry: () => Effect.runPromise(flow.auth.getForUrl("provider-proof", config.url)),
          currentLocal: () => true,
          authorizationGeneration: flow.state,
        },
        flow.auth,
      )
      const journal = path.join(Global.Path.config, "mcp-oauth", "journal.sqlite")
      const before = yield* Effect.promise(() => fs.readFile(journal))
      yield* scope.configure("provider-proof", { ...config, url: "http://127.0.0.1:8/mcp" })
      expect((yield* Effect.promise(() => provider.saveCodeVerifier("v".repeat(43))).pipe(Effect.exit))._tag).toBe(
        "Failure",
      )
      expect(yield* Effect.promise(() => fs.readFile(journal))).toEqual(before)
      expect(yield* Effect.promise(flow.current)).toBe(false)
    }),
  { config: { mcp: {} } },
)

it.instance(
  "legacy provider writes preserve their original current callback and full lookup before the real mutation",
  () =>
    Effect.gen(function* () {
      const accounts = yield* AccountRepo.Service
      const captures = { count: 0 }
      const context = yield* Layer.build(
        Layer.fresh(McpAuthScope.layer).pipe(
          Layer.provide(SecretStore.defaultLayer),
          Layer.provide(LocationIdentity.defaultLayer),
        ),
      ).pipe(
        Effect.provideService(AccountRepo.Service, {
          ...accounts,
          authority: () => accounts.authority().pipe(Effect.tap(() => Effect.sync(() => captures.count++))),
        }),
      )
      const scope = Context.get(context, McpAuthScope.Service)
      yield* scope.configure("provider-legacy", config)
      const flow = yield* scope.begin("provider-legacy", config, false)
      yield* Effect.addFinalizer(() => Effect.sync(flow.close))
      const provider = new McpOAuthProvider(
        "provider-legacy",
        config.url,
        config.oauth,
        {
          onRedirect: () => undefined,
          current: flow.current,
          authorizationGeneration: flow.state,
        },
        flow.auth,
      )
      const before = captures.count
      yield* Effect.promise(() => provider.saveCodeVerifier("l".repeat(43)))
      expect(captures.count - before).toBe(3)
      expect((yield* flow.auth.getForUrl("provider-legacy", config.url))?.codeVerifier).toBe("l".repeat(43))
    }),
  { config: { mcp: {} } },
)


// This exercises the managed Backend/Codec seam with real, scoped permits. The
// observed DTO grants no Native authority; it never reaches a Native guard.
function managedScopedRead(
  account: string,
  hooks: {
    read?: () => Promise<void>
    current?: (count: number) => Promise<void>
    unprotect?: () => Promise<void>
    missing?: boolean
    legacy?: boolean
  } = {},
) {
  const events: string[] = []
  const observed = { current: 0, unprotect: 0, bytes: undefined as Uint8Array | undefined }
  const witness = Object.freeze({}) as WindowsPrivateStorage.Snapshot
  const native: McpWindowsStorage.Port = {
    current: async () => {
      events.push("current")
      observed.current++
      await hooks.current?.(observed.current)
    },
    legacySecrets: async () => {
      events.push("legacy")
      return hooks.legacy ?? false
    },
    openJournal: async () => {
      throw new Error("Unexpected journal call")
    },
    read: async (purpose) => {
      expect(purpose).toBe("mcp_secret_envelopes")
      events.push("read")
      await hooks.read?.()
      return {
        text: JSON.stringify(hooks.missing ? {} : { [account]: Buffer.from("fixture-ciphertext").toString("base64") }),
        hash: "0".repeat(64),
        witness,
      }
    },
    publish: async () => {
      throw new Error("Unexpected publication")
    },
    mutateSecrets: async () => {
      throw new Error("Unexpected mutation")
    },
  }
  const codec: Codec = {
    id: "managed-read-order-fixture",
    available: async () => true,
    protect: async () => {
      throw new Error("Unexpected encryption")
    },
    unprotect: async () => {
      events.push("unprotect")
      observed.unprotect++
      observed.bytes = new TextEncoder().encode("fixture-scoped-value")
      await hooks.unprotect?.()
      return observed.bytes
    },
  }
  const backend = SecretStore.windowsBackend(native, codec)
  const get = backend.getScoped!
  return {
    native,
    codec,
    backend: {
      ...backend,
      getScoped: (key: string, beforeDecrypt: () => void) =>
        get(key, () => {
          events.push("permit")
          beforeDecrypt()
        }),
    },
    events,
    observed,
    witness,
  }
}

const managedReadPermit = Effect.gen(function* () {
  const owner = yield* Scope.make()
  yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void))
  const context = yield* Layer.build(Layer.fresh(SecretRefScope.defaultLayer)).pipe(
    Effect.provideService(Scope.Scope, owner),
  )
  const scopes = Context.get(context, SecretRefScope.Service)
  const captured = yield* scopes.capture("managed-get", true)
  const account = `${SecretRefScope.prefix(captured, "headers", "Authorization")}${"a".repeat(32)}`
  return {
    account,
    permit: SecretRefScope.permit(captured, "headers", "Authorization", account),
    revoke: () => Effect.runPromise(Scope.close(owner, Exit.void)),
  }
})
const managedReadConfig = {
  mcp: {
    "managed-get": {
      type: "remote" as const,
      url: "http://127.0.0.1:9/mcp",
      headers: { Authorization: "fixture" },
      enabled: false,
    },
  },
}

it.instance(
  "managed scoped getter reads one envelope and preserves its intermediate permit order",
  () =>
    Effect.gen(function* () {
      const permit = yield* managedReadPermit
      const fixture = managedScopedRead(permit.account)
      const store = SecretStore.make(fixture.backend)
      expect(WindowsPrivateStorage.describe(fixture.witness)).toBeUndefined()
      expect(yield* store.resolveScoped(permit.permit)).toBe("fixture-scoped-value")
      expect(fixture.events).toEqual(["read", "current", "permit", "unprotect", "current"])
      expect(fixture.observed.unprotect).toBe(1)
      expect(fixture.observed.bytes?.every((value) => value === 0)).toBe(true)
    }),
  { config: managedReadConfig },
)

it.instance(
  "managed scoped getter rejects a permit retired during read before any unprotect",
  () =>
    Effect.gen(function* () {
      const permit = yield* managedReadPermit
      const fixture = managedScopedRead(permit.account, { read: permit.revoke })
      const result = yield* SecretStore.make(fixture.backend).resolveScoped(permit.permit).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(SecretRefScope.Error)
      expect(fixture.events).toEqual(["read", "current", "permit"])
      expect(fixture.observed.unprotect).toBe(0)
    }),
  { config: managedReadConfig },
)

it.instance(
  "managed scoped getter clears decoded bytes when Native current rejects after decryption",
  () =>
    Effect.gen(function* () {
      const permit = yield* managedReadPermit
      const fixture = managedScopedRead(permit.account, {
        current: async (count) => {
          if (count === 2) throw new WindowsPrivateStorage.Error({ reason: "changed" })
        },
      })
      const result = yield* SecretStore.make(fixture.backend).resolveScoped(permit.permit).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(SecretStore.FileError)
      expect(fixture.observed.unprotect).toBe(1)
      expect(fixture.observed.bytes?.every((value) => value === 0)).toBe(true)
    }),
  { config: managedReadConfig },
)

it.instance(
  "managed scoped getter refuses its result and clears bytes when its permit retires during decryption",
  () =>
    Effect.gen(function* () {
      const permit = yield* managedReadPermit
      const fixture = managedScopedRead(permit.account, { unprotect: permit.revoke })
      const result = yield* SecretStore.make(fixture.backend).resolveScoped(permit.permit).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(SecretRefScope.Error)
      expect(fixture.observed.unprotect).toBe(1)
      expect(fixture.observed.bytes?.every((value) => value === 0)).toBe(true)
    }),
  { config: managedReadConfig },
)

it.instance(
  "managed scoped getter retains missing legacy and non-managed fallback rules",
  () =>
    Effect.gen(function* () {
      const permit = yield* managedReadPermit
      const missing = managedScopedRead(permit.account, { missing: true })
      expect(yield* SecretStore.make(missing.backend).resolveScoped(permit.permit)).toBeUndefined()
      expect(missing.events).toEqual(["read", "current", "permit", "legacy"])
      expect(missing.observed.unprotect).toBe(0)
      const legacy = managedScopedRead(permit.account, { missing: true, legacy: true })
      const rejected = yield* SecretStore.make(legacy.backend).resolveScoped(permit.permit).pipe(Effect.result)
      expect(rejected._tag).toBe("Failure")
      if (rejected._tag === "Failure") expect(rejected.failure).toMatchObject({ reason: "legacy_unverified" })
      expect(legacy.observed.unprotect).toBe(0)
      const events: string[] = []
      const fallback = SecretStore.make({
        ...SecretStore.inMemoryBackend(),
        validateScoped: async () => {
          events.push("validate")
        },
        get: async () => {
          events.push("get")
          return "fallback-value"
        },
      })
      expect(yield* fallback.resolveScoped(permit.permit)).toBe("fallback-value")
      expect(events).toEqual(["validate", "get"])
      const revokedFallback = SecretStore.make({
        ...SecretStore.inMemoryBackend(),
        validateScoped: async () => {
          events.push("revoke")
          await permit.revoke()
        },
        get: async () => {
          events.push("forbidden-get")
          return "forbidden"
        },
      })
      expect((yield* revokedFallback.resolveScoped(permit.permit).pipe(Effect.result))._tag).toBe("Failure")
      expect(events).not.toContain("forbidden-get")
      const missingPermit = yield* managedReadPermit
      const revokedMissing = managedScopedRead(missingPermit.account, {
        missing: true,
        legacy: true,
        read: missingPermit.revoke,
      })
      const refusedMissing = yield* SecretStore.make(revokedMissing.backend)
        .resolveScoped(missingPermit.permit)
        .pipe(Effect.result)
      expect(refusedMissing._tag).toBe("Failure")
      if (refusedMissing._tag === "Failure") expect(refusedMissing.failure).toBeInstanceOf(SecretRefScope.Error)
      expect(revokedMissing.events).toEqual(["read", "current", "permit"])
      expect(revokedMissing.observed.unprotect).toBe(0)
    }),
  { config: managedReadConfig },
)


test("managed legacy getter retains FileError mapping when its codec throws a scope error", async () => {
  const fixture = managedScopedRead("legacy-fixture-account", {
    unprotect: async () => {
      throw new SecretRefScope.Error({ reason: "unavailable" })
    },
  })
  const result = await fixture.backend.get("legacy-fixture-account").then(
    () => undefined,
    (error) => error,
  )
  expect(result).toBeInstanceOf(SecretStore.FileError)
  expect(result).toMatchObject({ reason: "io" })
  expect(result).not.toBeInstanceOf(SecretRefScope.Error)
  expect(fixture.events).toEqual(["read", "current", "unprotect"])
})


it.instance(
  "managed Native codec default retains permit checks and clears decrypted bytes",
  () => Effect.gen(function* () {
    const permit = yield* managedReadPermit
    const fixture = managedScopedRead(permit.account)
    const backend = SecretStore.windowsBackend({ ...fixture.native, codec: fixture.codec })
    expect(yield* SecretStore.make(backend).resolveScoped(permit.permit)).toBe("fixture-scoped-value")
    expect(fixture.events).toEqual(["read", "current", "unprotect", "current"])
    expect(fixture.observed.unprotect).toBe(1)
    expect(fixture.observed.bytes?.every((value) => value === 0)).toBe(true)
  }),
  { config: managedReadConfig },
)

it.instance(
  "managed Native codec default refuses a retired post-decrypt current and clears bytes",
  () => Effect.gen(function* () {
    const permit = yield* managedReadPermit
    const fixture = managedScopedRead(permit.account, { current: async (count) => {
      if (count === 2) throw new WindowsPrivateStorage.Error({ reason: "changed" })
    } })
    const backend = SecretStore.windowsBackend({ ...fixture.native, codec: fixture.codec })
    const result = yield* SecretStore.make(backend).resolveScoped(permit.permit).pipe(Effect.result)
    expect(result._tag).toBe("Failure")
    expect(fixture.observed.unprotect).toBe(1)
    expect(fixture.observed.bytes?.every((value) => value === 0)).toBe(true)
  }),
  { config: managedReadConfig },
)
