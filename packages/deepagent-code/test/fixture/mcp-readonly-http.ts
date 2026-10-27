import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Server } from "../../src/server/server"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Database } from "@deepagent-code/core/database/database"
import { PrivateSqlite } from "@deepagent-code/core/database/private-sqlite"
import { Global } from "@deepagent-code/core/global"
import { Effect, Option } from "effect"
import { eq } from "drizzle-orm"
import { AccountTable } from "@deepagent-code/core/account/sql"
import { Account } from "../../src/account/account"
import { AccountRepo } from "../../src/account/repo"
import { AccountID, OrgID, AccessToken, RefreshToken } from "../../src/account/schema"
import { Skill } from "../../src/skill"
import { McpReadModel } from "../../src/mcp/read-model"
import { InstanceStore } from "../../src/project/instance-store"
import { MCP } from "../../src/mcp"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceRegistry } from "../../src/effect/instance-registry"
import { Workspace } from "../../src/control-plane/workspace"
import { registerAdapter } from "../../src/control-plane/adapters"
import { Project } from "../../src/project/project"
import { ConfigFileWrite } from "../../src/config/file-write"
import { SettingsTransaction } from "../../src/settings/transaction"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"

const root = process.env.DAC_MCP_READONLY_ROOT
assert(root && path.basename(root).startsWith("dac-mcp-readonly-"))
assert.equal(await fs.realpath(root), root)
const mode = process.argv[2]
assert(
  mode === "idle" ||
    mode === "reads" ||
    mode === "denied" ||
    mode === "warm" ||
    mode === "pending" ||
    mode === "oversized" ||
    mode === "proxy" ||
    mode === "proxyread" ||
    mode === "account" || mode === "damaged",
)
assert.equal(process.env.DEEPAGENT_CODE_DB, path.join(root, "home", ".deepagent", "code", "authority.sqlite"))
const connected = mode === "warm" || mode === "oversized"
assert.equal(process.env.DEEPAGENT_CODE_SERVER_PASSWORD, connected ? "fixture-readonly-password" : "")
const directory = path.join(root, "project")
const requests: string[] = []
const remote = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    if (mode === "account" && new URL(request.url).pathname === "/api/config") {
      requests.push("GET /api/config")
      assert.equal(request.headers.get("authorization"), "Bearer fixture-account-token")
      assert.equal(request.headers.get("x-org-id"), "fixture-org")
      return Response.json({
        config: {
          command: { organization: { template: "organization command" } },
          skills: { paths: [path.join(root!, "organization-skills")] },
        },
      })
    }
    if (new URL(request.url).pathname === "/global/event")
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"payload":{"type":"server.connected","properties":{}}}\n\n'),
            )
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    if (new URL(request.url).pathname === "/sync/history") return Response.json([])
    if (mode === "proxy" || mode === "proxyread") {
      requests.push(`${request.method} ${new URL(request.url).pathname}`)
      return Response.json({ accepted: true })
    }
    if (new URL(request.url).pathname !== "/mcp") {
      requests.push(`${request.method} ${new URL(request.url).pathname}`)
      return Response.json({ skills: [] })
    }
    if (request.method === "DELETE") return new Response(null, { status: 204 })
    if (request.method !== "POST") return new Response(null, { status: 405 })
    const body = (await request.json()) as { id?: string | number; method: string }
    requests.push(body.method)
    if (body.id === undefined) return new Response(null, { status: 202 })
    const result =
      body.method === "initialize"
        ? {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {}, prompts: {}, resources: {} },
            serverInfo: { name: "readonly-fixture", version: "1" },
          }
        : body.method === "prompts/list"
          ? {
              prompts:
                mode === "oversized"
                  ? Array.from({ length: 1001 }, (_, index) => ({ name: `fixture_${index}` }))
                  : [
                      {
                        name: "fixture_prompt",
                        description: "MCP prompt metadata",
                        arguments: [{ name: "text", required: true }],
                      },
                    ],
            }
          : body.method === "resources/list"
            ? {
                resources: [
                  { name: "fixture_resource", uri: "fixture://readonly", description: "MCP resource metadata" },
                ],
              }
            : body.method === "prompts/get"
              ? { messages: [{ role: "user", content: { type: "text", text: "executed" } }] }
              : { tools: [] }
    return Response.json({ jsonrpc: "2.0", id: body.id, result })
  },
})
const marker = path.join(root, "mcp-spawned")
const local = {
  type: "local",
  command: [process.execPath, "-e", `await Bun.write(${JSON.stringify(marker)}, String(process.pid))`],
  timeout: 200,
}
await fs.writeFile(
  path.join(directory, "deepagent-code.json"),
  JSON.stringify({
    formatter: false,
    lsp: false,
    mcp: connected
      ? { fixture: { type: "remote", url: `${remote.url.origin}/mcp`, oauth: false, enabled: false } }
      : mode === "damaged" ? {
          oauth: { type: "remote", url: `${remote.url.origin}/mcp` },
          public: { type: "remote", url: `${remote.url.origin}/mcp`, oauth: false },
          disabled: { type: "remote", url: `${remote.url.origin}/mcp`, enabled: false },
          local,
        } : { local: mode === "pending" || mode === "account" ? { ...local, enabled: false } : local },
    skills: { urls: [remote.url.origin] },
    command: { fixture: { template: "local fixture text", description: "read-only fixture command" } },
  }),
)
await fs.mkdir(path.join(directory, ".deepagent-code", "commands"), { recursive: true })
await fs.mkdir(path.join(directory, ".deepagent-code", "skills", "local_skill"), { recursive: true })
await fs.writeFile(
  path.join(directory, ".deepagent-code", "commands", "local.md"),
  "---\ndescription: Local markdown command\n---\nlocal markdown $ARGUMENTS",
)
await fs.writeFile(
  path.join(directory, ".deepagent-code", "skills", "local_skill", "SKILL.md"),
  "---\nname: local_skill\ndescription: Local skill\n---\nlocal skill content",
)
const rg = Bun.which("rg")
assert(rg)
await fs.mkdir(Global.Path.bin, { recursive: true })
await fs.copyFile(rg, path.join(Global.Path.bin, "rg"))
if (mode === "damaged") {
  await fs.mkdir(Global.Path.config, { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(Global.Path.config, "mcp-auth.json"), "damaged credential fixture", { mode: 0o600 })
}
await AppRuntime.runPromise(Database.Service)
const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
const inventory = async (dir: string): Promise<Record<string, string>> => {
  const result: Record<string, string> = {}
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      for (const [name, value] of Object.entries(await inventory(file))) result[`${entry.name}/${name}`] = value
    }
    if (entry.isFile())
      result[entry.name] = createHash("sha256")
        .update(await fs.readFile(file))
        .digest("hex")
  }
  return result
}
const database = new PrivateSqlite.Database(process.env.DEEPAGENT_CODE_DB!, { readonly: true })
const facts = () =>
  Object.fromEntries(
    database
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
      .all()
      .map((row) => {
        const name = (row as { name: string }).name
        return [
          name,
          createHash("sha256")
            .update(JSON.stringify(database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()))
            .digest("hex"),
        ]
      }),
  )
const startup = { tables: facts(), config: await inventory(Global.Path.config), project: await inventory(directory) }
const deadline = Date.now() + 5000
// Root starts these two named schedules independently of HTTP and InstanceStore.
// Observe their actual registration; do not load a project to warm the fixture.
while (
  (
    database
      .prepare(
        "SELECT count(*) AS n FROM deepagent_schedule WHERE schedule_key IN ('v4:maintenance-scan','v4:ci-3x-failure-repair')",
      )
      .get() as { n: number }
  ).n !== 2
) {
  assert(Date.now() < deadline, "Root startup schedule registration did not finish")
  await Bun.sleep(5)
}
const call = (route: string, method = "GET", body?: object) =>
  fetch(new URL(route, listener.url), {
    method,
    ...(method === "GET" ? { signal: AbortSignal.timeout(3000) } : {}),
    headers: {
      "content-type": "application/json",
      "x-deepagent-code-directory": directory,
      ...(connected
        ? { authorization: `Basic ${Buffer.from("deepagent-code:fixture-readonly-password").toString("base64")}` }
        : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
if (connected) {
  const response = await call("/mcp/fixture/connect", "POST")
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal(requests.filter((value) => value === "prompts/list").length, 1)
  assert.equal(requests.filter((value) => value === "resources/list").length, 1)
  assert.equal(requests.filter((value) => value === "prompts/get").length, 0)
  const context = await AppRuntime.runPromise(InstanceStore.Service.use((store) => store.peek(directory)))
  assert(context)
  const prompt = await AppRuntime.runPromise(
    MCP.Service.use((mcp) => mcp.getPrompt("fixture", "fixture_prompt")).pipe(
      Effect.provideService(InstanceRef, context),
    ),
  )
  assert.equal(prompt?.messages[0]?.content.type, "text")
  assert.equal(requests.filter((value) => value === "prompts/get").length, 1)
}
const pendingGate = Promise.withResolvers<void>()
const reachedGate = Promise.withResolvers<void>()
const pending =
  mode === "pending"
    ? await (async () => {
        const unregister = await AppRuntime.runPromise(
          InstanceRegistry.Service.use((registry) =>
            Effect.sync(() =>
              registry.registerInitializer(async () => {
                reachedGate.resolve()
                await pendingGate.promise
              }),
            ),
          ),
        )
        const loading = AppRuntime.runPromise(InstanceStore.Service.use((store) => store.load({ directory })))
        await reachedGate.promise
        assert.equal(
          await AppRuntime.runPromise(InstanceStore.Service.use((store) => store.peek(directory))),
          undefined,
        )
        return { unregister, loading }
      })()
    : undefined
const workspace =
  mode === "proxy" || mode === "proxyread"
    ? await AppRuntime.runPromise(
        Effect.gen(function* () {
          const project = yield* (yield* Project.Service).fromDirectory(directory)
          registerAdapter(project.project.id, "readonly-remote", {
            name: "readonly remote fixture",
            description: "loopback only",
            configure: (info) => ({ ...info, directory }),
            create: async () => {},
            remove: async () => {},
            target: () => ({ type: "remote", url: remote.url.origin }),
          })
          return yield* (yield* Workspace.Service).create({
            projectID: project.project.id,
            type: "readonly-remote",
            branch: null,
          })
        }),
      )
    : undefined
if (workspace)
  assert.equal(await AppRuntime.runPromise(Workspace.Service.use((service) => service.isSyncing(workspace.id))), true)
const accountReads: { phase: string; remoteCount: number; commands: string[] }[] = []
if (mode === "account") {
  await fs.mkdir(path.join(root, "organization-skills", "organization_skill"), { recursive: true })
  await fs.writeFile(
    path.join(root, "organization-skills", "organization_skill", "SKILL.md"),
    "---\nname: organization_skill\ndescription: Organization skill\n---\norganization secret content",
  )
  await AppRuntime.runPromise(
    AccountRepo.Service.use((repo) =>
      repo.persistAccount({
        id: AccountID.make("fixture-account"),
        email: "fixture@example.invalid",
        url: remote.url.origin,
        accessToken: AccessToken.make("fixture-account-token"),
        refreshToken: RefreshToken.make("fixture-refresh"),
        expiry: Date.now() + 3600000,
        orgID: Option.some(OrgID.make("fixture-org")),
      }),
    ).pipe(Effect.provide(AccountRepo.layer)),
  )
  const context = await AppRuntime.runPromise(InstanceStore.Service.use((store) => store.load({ directory })))
  const skills = await AppRuntime.runPromise(
    Skill.Service.use((skill) => skill.all()).pipe(Effect.provideService(InstanceRef, context)),
  )
  assert(skills.some((skill) => skill.name === "organization_skill"))
  const observeAccount = async (phase: string, expected: boolean) => {
    const count = requests.length
    const before = { tables: facts(), config: await inventory(Global.Path.config), project: await inventory(directory) }
    const response = await call("/command")
    assert.equal(response.status, 200, await response.clone().text())
    const commands = (await response.json()) as { name: string; template?: string }[]
    assert.equal(
      commands.some((item) => item.name === "organization"),
      expected,
    )
    assert.equal(
      commands.some((item) => item.name === "organization_skill"),
      expected,
    )
    assert.equal(requests.length, count)
    assert.deepEqual(
      { tables: facts(), config: await inventory(Global.Path.config), project: await inventory(directory) },
      before,
    )
    accountReads.push({ phase, remoteCount: requests.length - count, commands: commands.map((item) => item.name) })
  }
  await observeAccount("current-A", true)
  for (const expiry of [Date.now() + 240000, Date.now() - 1, null, Number.MAX_SAFE_INTEGER + 1, Date.now() + 3600000]) {
    await AppRuntime.runPromise(
      Database.Service.use(({ db }) =>
        db
          .update(AccountTable)
          .set({ token_expiry: expiry })
          .where(eq(AccountTable.id, AccountID.make("fixture-account")))
          .run(),
      ),
    )
    const source = await AppRuntime.runPromise(Account.Service.use((account) => account.source()))
    assert.equal(
      source !== undefined,
      expiry !== null && Number.isSafeInteger(expiry) && expiry > Date.now(),
      "expired account remained a current config source",
    )
    assert.equal(
      await AppRuntime.runPromise(
        AccountRepo.Service.use((repo) => repo.authority()).pipe(Effect.provide(AccountRepo.layer)),
      ).then((value) => value.account?.id),
      "fixture-account",
      "source expiry changed the durable principal",
    )
    await observeAccount(
      expiry === null
        ? "expiry-null"
        : !Number.isSafeInteger(expiry)
          ? "expiry-unsafe"
          : expiry <= Date.now()
            ? "expired"
            : expiry < Date.now() + 300000
              ? "near-expiry-4min"
              : "same-principal-renewed",
      expiry !== null && Number.isSafeInteger(expiry) && expiry > Date.now(),
    )
  }
  for (const id of ["fixture-B", "fixture-account"]) {
    await AppRuntime.runPromise(
      AccountRepo.Service.use((repo) =>
        repo.persistAccount({
          id: AccountID.make(id),
          email: "fixture@example.invalid",
          url: remote.url.origin,
          accessToken: AccessToken.make("fixture-account-token"),
          refreshToken: RefreshToken.make("fixture-refresh"),
          expiry: Date.now() + 3600000,
          orgID: Option.some(OrgID.make("fixture-org")),
        }),
      ).pipe(Effect.provide(AccountRepo.layer)),
    )
    await observeAccount(id === "fixture-B" ? "switched-B" : "returned-A-new-incarnation", false)
  }
  // Keep the actual InstanceRef/cache alive while the durable account identity changes.
  await AppRuntime.runPromise(
    AccountRepo.Service.use((repo) => repo.remove(AccountID.make("fixture-account"))).pipe(
      Effect.provide(AccountRepo.layer),
    ),
  )
}
const release = Promise.withResolvers<void>()
const acquired = Promise.withResolvers<void>()
// Warm mode deliberately edits a watched config below. Hold the real writer locks
// while measuring reads so its unrelated reload cannot overlap the full snapshot.
// A read that enters a writer path must still fail its HTTP deadline.
const locking = mode === "warm"
  ? ConfigFileWrite.run(ConfigFileWrite.transaction(
      [...SettingsTransaction.globalFiles(), ...Object.values(SettingsTransaction.paths())],
      () => Effect.promise(async () => {
        acquired.resolve()
        await release.promise
      }),
    ))
  : undefined
if (locking) await Promise.race([acquired.promise, locking])
const before = { tables: facts(), config: await inventory(Global.Path.config), project: await inventory(directory) }
const previousRequests = [...requests]
const responses: { route: string; status: number }[] = []
try {
  const routes =
    mode === "idle"
      ? []
      : mode !== "denied" && mode !== "proxy"
        ? ["/mcp", "/mcp/catalog", "/experimental/resource", "/command"]
        : [
            "/mcp/local/auth",
            "/mcp",
            "/mcp/catalog/enable",
            "/mcp/local/auth/callback",
            "/mcp/local/auth/authenticate",
            "/mcp/local/connect",
            "/mcp/local/disconnect",
            "/mcp/local/auth?delete=1",
          ]
  for (const route of routes) {
    const bodyInput =
      route === "/mcp"
        ? { name: "added", config: local }
        : route === "/mcp/catalog/enable"
          ? { id: "fixture-missing", params: {}, credentialRefs: {} }
          : route.endsWith("/callback")
            ? { code: "fixture", oauthState: "fixture" }
            : undefined
    const response: Response = await Promise.race([
      call(
        route.replace("?delete=1", "") + (workspace ? `?workspace=${workspace.id}` : ""),
        mode === "denied" || mode === "proxy" ? (route.endsWith("?delete=1") ? "DELETE" : "POST") : "GET",
        mode === "denied" || mode === "proxy" ? bodyInput : undefined,
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Read awaited pending instance")), 3000).unref(),
      ),
    ])
    responses.push({ route, status: response.status })
    if (mode === "proxyread") {
      await response.text()
      continue
    }
    if (mode === "oversized" && ["/command", "/experimental/resource"].includes(route)) {
      assert.equal(response.status, 500, await response.clone().text())
      await response.text()
      continue
    }
    const body: unknown = await response.json()
    if (mode === "damaged" && route === "/mcp") {
      assert.equal(response.status, 200)
      assert.deepEqual(body, {
        oauth: { status: "failed", error: "MCP authentication storage or scope is unavailable" },
        public: { status: "disconnected", authStatus: "not_authenticated", reason: "explicit_connect_required" },
        disabled: { status: "disabled" },
        local: { status: "disconnected", authStatus: "not_authenticated", reason: "explicit_connect_required" },
      })
      assert.deepEqual(requests, previousRequests)
    }
    if (route === "/command") {
      assert(Array.isArray(body))
      assert.equal(
        body.find((value: { name?: string }) => value.name === "local").template,
        "local markdown $ARGUMENTS",
      )
      assert.equal(
        body.find((value: { name?: string }) => value.name === "local_skill").template,
        "local skill content",
      )
    }
    if (mode === "account" && route === "/command") {
      assert(Array.isArray(body))
      assert.equal(
        body.some((value: { name?: string }) => value.name === "organization_skill"),
        false,
        "old organization skill survived account removal",
      )
      assert.equal(
        body.some((value: { name?: string }) => value.name === "organization"),
        false,
      )
    }
    if (mode === "warm" && route === "/command") {
      assert(Array.isArray(body))
      const prompt = body.find((value: { source?: string }) => value.source === "mcp")
      assert(prompt)
      assert.equal(prompt.availability, "available")
      assert.equal(Object.hasOwn(prompt, "template"), false)
      assert.equal(body.find((value: { name?: string }) => value.name === "fixture").template, "local fixture text")
    }
    if (mode === "warm" && route === "/experimental/resource") assert.equal(Object.keys(body as object).length, 1)
  }
  if (mode === "warm") {
    const explicit = await AppRuntime.runPromise(
      Effect.exit(
        McpReadModel.Service.use((reads) =>
          reads.resources({ directory, workspaceID: WorkspaceV2.ID.make("wrk_fixture_explicit") }),
        ).pipe(Effect.provide(McpReadModel.layer)),
      ),
    )
    assert.equal(explicit._tag, "Failure", "explicit workspace reused implicit-local cache")
    const file = path.join(directory, "deepagent-code.json")
    await fs.writeFile(
      file,
      (await fs.readFile(file, "utf8")).replace("read-only fixture command", "changed source command"),
    )
    const resource = await call("/experimental/resource")
    assert.equal(resource.status, 200)
    assert.deepEqual(await resource.json(), {})
    const command = await call("/command")
    const body = (await command.json()) as { source?: string }[]
    assert.equal(body.filter((value) => value.source === "mcp").length, 0)
    const status = await call("/mcp")
    assert.equal(((await status.json()) as { fixture: { reason: string } }).fixture.reason, "scope_changed")
    const context = await AppRuntime.runPromise(InstanceStore.Service.use((store) => store.peek(directory)))
    assert(context)
    const execution = await AppRuntime.runPromise(
      Effect.exit(
        MCP.Service.use((mcp) => mcp.getPrompt("fixture", "fixture_prompt")).pipe(
          Effect.provideService(InstanceRef, context),
        ),
      ),
    )
    assert.equal(execution._tag, "Failure")
    // Restore our explicit fixture edit before comparing producer writes.
    await fs.writeFile(
      file,
      (await fs.readFile(file, "utf8")).replace("changed source command", "read-only fixture command"),
    )
  }
  const after = { tables: facts(), config: await inventory(Global.Path.config), project: await inventory(directory) }
  const changed = Object.fromEntries(
    Object.entries(before).map(([group, values]) => [
      group,
      [...new Set([...Object.keys(values), ...Object.keys(after[group as keyof typeof after])])].filter(
        (key) => values[key] !== after[group as keyof typeof after][key],
      ),
    ]),
  )
  const spawned = await fs.stat(marker).then(
    () => true,
    () => false,
  )
  await fs.writeFile(
    path.join(root, "evidence.json"),
    JSON.stringify(
      {
        mode,
        pid: process.pid,
        port: listener.port,
        responses,
        previousRequests,
        requests,
        accountReads,
        spawned,
        changed,
        startup,
        before,
        after,
      },
      null,
      2,
    ),
  )
  assert.equal(spawned, false, "read or unauthenticated MCP HTTP bootstrapped an executable MCP client")
  assert.deepEqual(requests, previousRequests, "read or unauthenticated MCP HTTP performed a remote request")
  assert.deepEqual(changed, { tables: [], config: [], project: [] })
  assert(
    responses.every(
      (response) =>
        response.status ===
        (mode === "denied" || mode === "proxy"
          ? 401
          : mode === "proxyread"
            ? 503
            : mode === "oversized" && ["/command", "/experimental/resource"].includes(response.route)
              ? 500
              : 200),
    ),
  )
} finally {
  release.resolve()
  await locking
  pendingGate.resolve()
  if (pending) {
    const loaded = await pending.loading
    assert.equal(await AppRuntime.runPromise(InstanceStore.Service.use((store) => store.peek(directory))), loaded)
    pending.unregister()
  }
  if (workspace) await AppRuntime.runPromise(Workspace.Service.use((service) => service.remove(workspace.id)))
  database.close()
  await listener.stop(true)
  await remote.stop(true)
}
process.exit(0)
