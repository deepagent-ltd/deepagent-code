import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer, Option } from "effect"
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
import { LocalTaskAuthority } from "../../src/im/local-task-authority"
import { AccountRepo } from "../../src/account/repo"
import { Account } from "../../src/account/account"
import { AccountID, AccessToken, RefreshToken, OrgID } from "../../src/account/schema"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Database } from "@deepagent-code/core/database/database"
import { Global } from "@deepagent-code/core/global"

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
)
const config = { type: "remote" as const, url: "http://127.0.0.1:9/mcp", oauth: { clientId: "fixture-client" } }

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
      expect((yield* LocalTaskAuthority.readInstallation).instanceID).toMatch(/^local_[a-f0-9]{32}$/)
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
