import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import assert from "node:assert/strict"
import { Cause, Effect, Exit, Option } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { Database } from "@deepagent-code/core/database/database"
import { RemoteTaskAuthority } from "@/im/remote-task-authority"

if (process.env.DAC_REMOTE_TLS_TEST_ROOT) {
  await actual(process.env.DAC_REMOTE_TLS_TEST_ROOT)
  process.exit(0)
}

test("remote task authentication refuses Web HTTPS and forwarding claims before reading enrollment", async () => {
  const root = await fs.mkdtemp("/private/tmp/dac-remote-task-auth-")
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const before = yield* db.all("SELECT total_changes() changes")
      const failures = yield* Effect.forEach([
        new Request("https://receiver.example/im/tasks", { headers: { authorization: "Basic dXNlcjpwYXNzd29yZA==" } }),
        new Request("http://receiver.example/im/tasks", { headers: { authorization: "Basic dXNlcjpwYXNzd29yZA==",
          forwarded: "proto=https;host=receiver.example", "x-forwarded-proto": "https" } }),
        new Request("https://receiver.example/im/tasks?auth_token=caller-credential"),
        new Request("https://receiver.example/im/tasks", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ encrypted: true, protocol: "TLSv1.3", authorized: true, operator: "server" }) }),
      ], (request) => RemoteTaskAuthority.authenticate(db, { username: "user", password: Option.some("password") },
        HttpServerRequest.fromWeb(request), { origin: "https://receiver.example" }).pipe(Effect.exit))
      expect(failures.map((result) => Exit.isFailure(result) ? Cause.squash(result.cause) : result.value))
        .toEqual(Array.from({ length: 4 }, () => expect.objectContaining({ code: "LOCAL_OPERATOR_AUTH_REQUIRED" })))
      expect(yield* db.all("SELECT total_changes() changes")).toEqual(before)
      expect(yield* db.all(`SELECT (SELECT count(*) FROM local_operator_authority) operators,
        (SELECT count(*) FROM im_task_request) requests,(SELECT count(*) FROM im_task_grant) grants,
        (SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM work_execution) work,
        (SELECT count(*) FROM session_provider_attempt) providers`))
        .toEqual([{ operators: 0, requests: 0, grants: 0, inputs: 0, work: 0, providers: 0 }])
    }).pipe(Effect.provide(Database.layerFromPath(path.join(root, "authority.sqlite"))), Effect.scoped))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("same Root HTTPS task capability and targets use real TLS, exact origins and current credential generation", async () => {
  const root = await fs.realpath(await fs.mkdtemp("/private/tmp/dac-remote-task-tls-"))
  await Promise.all(["home", "tmp", "config", "data", "cache", "state", "managed", "project", "other"]
    .map((name) => fs.mkdir(path.join(root, name), { mode: 0o700 })))
  const child = Bun.spawn([process.execPath, import.meta.path], { cwd: path.join(root, "project"), env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    DAC_REMOTE_TLS_TEST_ROOT: root,
    HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"), DEEPAGENT_CODE_HOME: path.join(root, "data"),
    DEEPAGENT_CODE_DB: path.join(root, "authority.sqlite"), DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
    DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
    DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1", DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "",
    DEEPAGENT_CODE_V2_OWNER_CAMPAIGN: "", DEEPAGENT_CODE_V2_OWNER_PUBLIC_KEY: "",
    DEEPAGENT_CODE_SERVER_USERNAME: "private-tls-operator", DEEPAGENT_CODE_SERVER_PASSWORD: "private-tls-password-before",
    DEEPAGENT_IM_AGENT_RESPONDER: "off", NO_COLOR: "1",
  }, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill("SIGKILL"), 110_000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    await fs.writeFile(path.join(root, "child.log"), stdout + stderr, { mode: 0o600 })
    console.info("REMOTE_TASK_TLS_EVIDENCE", root)
    expect({ code, output: code === 0 ? "ok" : stdout + stderr }).toEqual({ code: 0, output: "ok" })
    expect(await Bun.file(path.join(root, "result.json")).json()).toMatchObject({ closed: true,
      capability: 200, targets: 200, nativeOrigins: [200, 200, 200, 200], explicitHTTPSOrigin: 200,
      wrongOrigins: [403, 403, 403, 403, 403], queryCredential: 401, wrongPassword: 401,
      wrongListenerOrigin: 403, oldListenerAfterRotate: 503, oldPasswordAfterRestart: 401,
      cleartextRejected: true, tls11Rejected: true,
      newCredential: 200, operatorRevision: 2, credentialGeneration: 2, policyRevision: 2,
      protectedDrift: 0, newInputs: 0, newWork: 0, newProviders: 0, newCounts: 0 })
  } finally {
    clearTimeout(timer)
    child.kill()
  }
}, 120_000)

async function actual(root: string) {
  const { command } = await import("@/cli/cmd/operator")
  const { LocalOperator } = await import("@deepagent-code/core/im/local-operator")
  const { RemoteTaskScope } = await import("@deepagent-code/core/im/remote-task-scope")
  const { LocationIdentity } = await import("@deepagent-code/core/context-federation/identity")
  const { WorkAuthorityPolicy } = await import("@deepagent-code/core/session/work-authority-policy")
  const { FSUtil } = await import("@deepagent-code/core/fs-util")
  const { LocalTaskAuthority } = await import("@/im/local-task-authority")
  const { AuthRuntime } = await import("@/im/auth-runtime")
  const { ServerAuth } = await import("@/server/auth")
  const { AppRuntime } = await import("@/effect/app-runtime")
  const { Server } = await import("@/server/server")
  const { Layer } = await import("effect")
  const directory = path.join(root, "project")
  await Bun.write(path.join(directory, "deepagent-code.json"), JSON.stringify({ formatter: false, lsp: false,
    model: "fixture/test-model", providers: { fixture: { api: { type: "native", url: "https://example.invalid/v1/responses",
      settings: {}, protocol: "openai.responses" }, models: { "test-model": { api: { id: "test-model" } } } } } }))
  const policyPath = path.join(root, "policy.json")
  await fs.writeFile(policyPath, JSON.stringify({ version: 1, targets: [{ id: "review", directory, agentID: "auto",
    providerID: "fixture", modelID: "test-model", budget: { ...WorkAuthorityPolicy.TEXT_ONLY_PROFILE.budget, maxTotalTokens: 8_000 } }] }), { mode: 0o600 })
  const database = Database.defaultLayer
  await Effect.runPromise(command({ action: "enroll", operationID: "private-tls-enroll", policyPath }).pipe(
    Effect.provide(LocationIdentity.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer))),
    Effect.provide(database), Effect.provide(ServerAuth.Config.defaultLayer), Effect.scoped))
  const rg = Bun.which("rg")
  assert(rg)
  const bin = path.join(root, "home/.deepagent/code/cache/bin")
  await fs.mkdir(bin, { recursive: true })
  await fs.copyFile(rg, path.join(bin, "rg"))
  const certificate = path.join(root, "certificate.pem")
  const key = path.join(root, "key.pem")
  const generated = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", key, "-out", certificate, "-subj", "/CN=DAC private remote TLS", "-addext", "subjectAltName=IP:127.0.0.1"],
  { stdout: "ignore", stderr: "pipe" })
  assert.equal(generated.exitCode, 0)
  await fs.chmod(key, 0o600)
  const tls = { key: await fs.readFile(key), cert: await fs.readFile(certificate) }
  const ca = await fs.readFile(certificate, "utf8")
  const listeners: Awaited<ReturnType<typeof Server.listen>>[] = []
  const facts = () => AppRuntime.runPromise(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    return yield* db.all(`SELECT (SELECT count(*) FROM im_task_source) sources,(SELECT count(*) FROM im_task_request) requests,
      (SELECT count(*) FROM im_task_grant) grants,(SELECT count(*) FROM session) sessions,(SELECT count(*) FROM session_input) inputs,
      (SELECT count(*) FROM work_execution) work,(SELECT count(*) FROM session_provider_attempt) providers,
      (SELECT count(*) FROM work_count_acquisition) counts,(SELECT count(*) FROM work_dispatch_reservation) dispatches,
      (SELECT count(*) FROM session_v2_tool_effect_admission) admissions,(SELECT count(*) FROM session_v2_tool_effect) terminals`)
  }))
  const result: Record<string, unknown> = {}
  try {
    await AppRuntime.runPromise(Database.Service)
    const before = await facts()
    assert.deepEqual(before, [{ sources: 0, requests: 0, grants: 0, sessions: 0, inputs: 0, work: 0,
      providers: 0, counts: 0, dispatches: 0, admissions: 0, terminals: 0 }])
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0, tls, cors: ["https://explicit-client.example"] })
    listeners.push(listener)
    assert.equal(listener.url.protocol, "https:")
    const cleartext = new URL(listener.url)
    cleartext.protocol = "http:"
    const cleartextStatus = await fetch(cleartext, { signal: AbortSignal.timeout(10_000) })
      .then((response) => response.status, () => 0)
    assert(cleartextStatus === 0 || cleartextStatus === 400 || cleartextStatus === 426)
    result.cleartextRejected = true
    const request = async (owner: typeof listener, pathname: string, input: { origin?: string; password?: string; queryCredential?: boolean; directory?: string } = {}) => {
      const url = new URL(pathname, owner.url)
      url.searchParams.set("directory", input.directory ?? directory)
      if (input.queryCredential) url.searchParams.set("auth_token", "private-tls-password-before")
      const response = await fetch(url, { headers: { authorization: ServerAuth.header({ username: "private-tls-operator",
        password: input.password ?? "private-tls-password-before" })!, ...(input.origin === undefined ? {} : { origin: input.origin }) },
      tls: { ca, rejectUnauthorized: true }, signal: AbortSignal.timeout(10_000) })
      const body: unknown = await response.json()
      await fs.writeFile(path.join(root, "last-response.json"), JSON.stringify({ pathname, status: response.status, body }), { mode: 0o600 })
      return { status: response.status, body }
    }
    result.capability = (await request(listener, "/api/v1/im/tasks/capability")).status
    assert.equal(result.capability, 200)
    const targets = await request(listener, "/api/v1/im/tasks/targets")
    result.targets = targets.status
    assert.equal(targets.status, 200)
    assert(targets.body && typeof targets.body === "object" && "targets" in targets.body && Array.isArray(targets.body.targets))
    assert.equal(targets.body.targets.length, 1)
    assert.equal(targets.body.targets[0].targetID, "review")
    assert.equal(targets.body.targets[0].directory, directory)
    const outside = await request(listener, "/api/v1/im/tasks/targets", { directory: path.join(root, "other") })
    assert.equal(outside.status, 200)
    assert(outside.body && typeof outside.body === "object" && "targets" in outside.body)
    assert.deepEqual(outside.body.targets, [])
    result.nativeOrigins = await Promise.all(["oc://renderer", "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]
      .map(async (origin) => (await request(listener, "/api/v1/im/tasks/capability", { origin })).status))
    assert.deepEqual(result.nativeOrigins, [200, 200, 200, 200])
    result.explicitHTTPSOrigin = (await request(listener, "/api/v1/im/tasks/capability", { origin: "https://explicit-client.example" })).status
    const wrongOrigins: number[] = []
    for (const origin of ["oc://renderer-evil", "tauri://localhost.evil", "http://tauri.localhost.evil",
      `${listener.url.origin}/path`, "https://explicit-client.example/path"])
      wrongOrigins.push((await request(listener, "/api/v1/im/tasks/capability", { origin })).status)
    result.wrongOrigins = wrongOrigins
    assert.deepEqual(result.wrongOrigins, [403, 403, 403, 403, 403])
    result.queryCredential = (await request(listener, "/api/v1/im/tasks/capability", { queryCredential: true })).status
    result.wrongPassword = (await request(listener, "/api/v1/im/tasks/capability", { password: "incorrect" })).status
    assert.equal(result.queryCredential, 401)
    assert.equal(result.wrongPassword, 401)
    await listener.stop(true)
    const invalid = await Server.listen({ hostname: "127.0.0.1", port: 0, tls: { ...tls, origin: "https://127.0.0.1:1" } })
    listeners.push(invalid)
    result.wrongListenerOrigin = (await request(invalid, "/api/v1/im/tasks/capability")).status
    assert.equal(result.wrongListenerOrigin, 403)
    await invalid.stop(true)
    const live = await Server.listen({ hostname: "127.0.0.1", port: 0, tls })
    listeners.push(live)
    const prior = await AppRuntime.runPromise(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const configured = yield* LocalTaskAuthority.configured({ username: "private-tls-operator", password: Option.some("private-tls-password-before") })
      const witness = yield* LocalTaskAuthority.authenticatePassword(db, configured.runtime, "private-tls-operator", configured.password)
      const installation = yield* LocalTaskAuthority.readInstallation
      const runtime = LocalTaskAuthority.binding(installation, "private-tls-operator", "private-tls-password-after")
      yield* LocalOperator.rotate(db, { operationID: "private-tls-rotate", expectedRevision: 1, username: "private-tls-operator",
        credentialVerifier: yield* Effect.promise(() => AuthRuntime.hash("private-tls-password-after")) }).pipe(
        Effect.provideService(LocalOperator.Runtime, runtime), Effect.provideService(LocalOperator.Mutation, witness))
      const stale = yield* db.transaction((tx) => RemoteTaskScope.targets(tx)).pipe(
        Effect.provideService(LocalOperator.Runtime, runtime), Effect.provideService(LocalOperator.Mutation, witness), Effect.exit)
      assert(Exit.isFailure(stale))
      return { runtime }
    }))
    result.oldListenerAfterRotate = (await request(live, "/api/v1/im/tasks/capability")).status
    assert.equal(result.oldListenerAfterRotate, 503)
    await live.stop(true)
    process.env.DEEPAGENT_CODE_SERVER_PASSWORD = "private-tls-password-after"
    const current = await Server.listen({ hostname: "127.0.0.1", port: 0, tls })
    listeners.push(current)
    result.oldPasswordAfterRestart = (await request(current, "/api/v1/im/tasks/capability")).status
    result.newCredential = (await request(current, "/api/v1/im/tasks/targets", { password: "private-tls-password-after" })).status
    assert.equal(result.oldPasswordAfterRestart, 401)
    assert.equal(result.newCredential, 200)
    const operator = await AppRuntime.runPromise(Effect.gen(function* () {
      return yield* (yield* Database.Service).db.transaction((tx) => LocalOperator.requireCurrent(tx))
        .pipe(Effect.provideService(LocalOperator.Runtime, prior.runtime))
    }))
    result.operatorRevision = operator.revision
    result.credentialGeneration = operator.credential_generation
    result.policyRevision = operator.policy_revision
    assert.deepEqual(await facts(), before)
    Object.assign(result, { protectedDrift: 0, newInputs: 0, newWork: 0, newProviders: 0, newCounts: 0 })
    const legacyTLS = Bun.spawn([await Bun.file("/opt/homebrew/opt/openssl@3/bin/openssl").exists()
      ? "/opt/homebrew/opt/openssl@3/bin/openssl" : "openssl", "s_client", "-connect", `127.0.0.1:${current.port}`, "-tls1_1",
      "-cipher", "ALL:@SECLEVEL=0", "-CAfile", certificate, "-state", "-brief"],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const legacyDeadline = setTimeout(() => legacyTLS.kill("SIGKILL"), 10_000)
    try {
      const [code, stdout, stderr] = await Promise.all([legacyTLS.exited, new Response(legacyTLS.stdout).text(), new Response(legacyTLS.stderr).text()])
      await fs.writeFile(path.join(root, "tls11-handshake.log"), stdout + stderr, { mode: 0o600 })
      assert.notEqual(code, 0)
      assert.match(stdout + stderr, /write client hello/i)
      assert.match(stdout + stderr, /alert|protocol version|handshake failure/i)
      result.tls11Rejected = true
    } finally {
      clearTimeout(legacyDeadline)
      legacyTLS.kill()
    }
  } finally {
    await Promise.all(listeners.map((listener) => listener.stop(true)))
    await AppRuntime.dispose()
  }
  await fs.writeFile(path.join(root, "result.json"), JSON.stringify({ ...result, closed: true }), { mode: 0o600 })
}
