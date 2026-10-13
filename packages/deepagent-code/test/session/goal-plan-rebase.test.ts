import { expect, test } from "bun:test"
import { Effect, Option, Scope } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { NodeHttpServer } from "@effect/platform-node"
import https from "node:https"
import http from "node:http"
import { EventInvestigationInstallation } from "../installation/fixture/event-investigation-installation"
import { ServerAuth } from "../../src/server/auth"
import { GoalPlanRebaseAccess } from "../../src/session/goal-plan-rebase-access"
import { CorsConfig } from "../../src/server/cors"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const config: ServerAuth.Info = { username: "operator", password: Option.some("isolated-test-password") }
const request = (
  origin?: string,
  authorization = ServerAuth.header({ username: "operator", password: "isolated-test-password" }),
) =>
  HttpServerRequest.fromWeb(
    new Request("http://127.0.0.1:43119/deepagent/goal/plan-rebase/begin", {
      method: "POST",
      headers: { host: "127.0.0.1:43119", ...(authorization ? { authorization } : {}), ...(origin ? { origin } : {}) },
    }),
  )

test("actual Basic credentials and exact Origin mint an opaque operator capability; JSON cloning cannot", async () => {
  const access = await Effect.runPromise(GoalPlanRebaseAccess.authenticate(config, request("http://127.0.0.1:43119")))
  await Effect.runPromise(GoalPlanRebaseAccess.current(access))
  expect(
    await Effect.runPromise(GoalPlanRebaseAccess.current(JSON.parse(JSON.stringify(access))).pipe(Effect.flip)),
  ).toMatchObject({ code: "AUTH_CHANGED" })
  expect(
    await Effect.runPromise(
      GoalPlanRebaseAccess.authenticate(config, request("http://127.0.0.1:43120")).pipe(Effect.flip),
    ),
  ).toMatchObject({ code: "AUTH_REQUIRED" })
  expect(
    await Effect.runPromise(
      GoalPlanRebaseAccess.authenticate(config, request("http://127.0.0.1.evil:43119")).pipe(Effect.flip),
    ),
  ).toMatchObject({ code: "AUTH_REQUIRED" })
})

test("empty password and wrong authenticated operator fail closed even on localhost", async () => {
  for (const password of [Option.none<string>(), Option.some("")]) {
    expect(
      await Effect.runPromise(
        GoalPlanRebaseAccess.authenticate({ username: "operator", password }, request()).pipe(Effect.flip),
      ),
    ).toMatchObject({ code: "AUTH_REQUIRED" })
  }
  expect(
    await Effect.runPromise(
      GoalPlanRebaseAccess.authenticate(config, request(undefined, "Basic b3BlcmF0b3I6d3Jvbmc=")).pipe(Effect.flip),
    ),
  ).toMatchObject({ code: "AUTH_REQUIRED" })
})

test("host operator origins accept exact Desktop and configured UI only with current Basic authority", async () => {
  const authenticate = (origin: string, authorization?: string) =>
    GoalPlanRebaseAccess.authenticateOperator(config, request(origin, authorization)).pipe(
      Effect.provideService(CorsConfig, { cors: ["https://operator.example"] }),
    )
  for (const origin of ["oc://renderer", "https://operator.example", "http://127.0.0.1:43119"]) {
    const access = await Effect.runPromise(authenticate(origin))
    await Effect.runPromise(GoalPlanRebaseAccess.current(access))
  }
  for (const origin of [
    "oc://renderer.evil",
    "oc://renderer/path",
    "http://127.0.0.1:43120",
    "https://operator.example.evil",
    "null",
  ]) {
    expect(await Effect.runPromise(authenticate(origin).pipe(Effect.flip))).toMatchObject({ code: "AUTH_REQUIRED" })
  }
  expect(
    await Effect.runPromise(authenticate("oc://renderer", "Basic b3BlcmF0b3I6d3Jvbmc=").pipe(Effect.flip)),
  ).toMatchObject({ code: "AUTH_REQUIRED" })
})

test("original Node HTTP and TLS sockets determine operator Origin without trusting forwarded scheme", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-operator-origin-tls-")))
  try {
    const certificate = await EventInvestigationInstallation.certificate(root)
    const ca = await fs.readFile(certificate.certificatePath, "utf8")
    const key = await fs.readFile(certificate.keyPath, "utf8")
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const handler = yield* NodeHttpServer.makeHandler(Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const access = yield* GoalPlanRebaseAccess.authenticateOperator(config, request)
        yield* GoalPlanRebaseAccess.current(access)
        return HttpServerResponse.empty({ status: 200 })
      }).pipe(Effect.catchTag("GoalPlanRebase.Error", () => Effect.succeed(HttpServerResponse.empty({ status: 401 })))), { scope })
      for (const secure of [true, false]) {
        const server = secure ? https.createServer({ key, cert: ca }, handler) : http.createServer(handler)
        yield* Effect.acquireRelease(Effect.promise(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))),
          () => Effect.promise(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))))
        const address = server.address()
        if (!address || typeof address === "string") throw new Error("Private operator listener unavailable")
        const origin = `${secure ? "https" : "http"}://127.0.0.1:${address.port}`
        for (const target of [origin, origin.replace(secure ? "https:" : "http:", secure ? "http:" : "https:")]) {
          const status = yield* Effect.promise(() => new Promise<number>((resolve, reject) => {
            const outgoing = (secure ? https : http).request(origin + "/operator", { ca, headers: {
              authorization: ServerAuth.header({ username: "operator", password: "isolated-test-password" })!,
              origin: target, "x-forwarded-proto": secure ? "http" : "https",
            } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode ?? 0)) })
            outgoing.on("error", reject); outgoing.end()
          }))
          expect(status).toBe(target === origin ? 200 : 401)
        }
      }
    })))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
}, 10000)

test("an existing opaque operator capability cannot survive actual configured credential replacement", async () => {
  const current = { ...config }
  const access = await Effect.runPromise(GoalPlanRebaseAccess.authenticate(current, request()))
  Reflect.set(current, "password", Option.some("replacement-test-password"))
  expect(await Effect.runPromise(GoalPlanRebaseAccess.current(access).pipe(Effect.flip))).toMatchObject({
    code: "AUTH_CHANGED",
  })
})

test("actual HTTP rebase waits an active provider boundary, preserves its first proof and executes the revised second step only after resume", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-goal-rebase-host-")))
  await Promise.all(
    ["home", "tmp", "config", "data", "cache", "state", "project"].map((name) => fs.mkdir(path.join(root, name))),
  )
  const child = spawn(root, "loop-proposal-two-rebase")
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const timeout = setTimeout(() => child.kill("SIGKILL"), 45000)
  try {
    const status = await child.exited
    const log = (await output).join("\n")
    await Bun.write(path.join(root, "output.log"), log)
    expect({ status, log, root }).toMatchObject({ status: 0 })
    const result = await Bun.file(path.join(root, "result.json")).json()
    expect(result.requests).toBe(8)
    expect(result.result.checkpoint.journal.program.planLineage.planRevision).toBe(1)
    expect(result.result.first.journal.program.planLineage.planRevision).toBe(0)
    expect(result.result.active).toEqual([])
  } finally {
    clearTimeout(timeout)
  }
}, 60000)

function spawn(root: string, scenario: string) {
  return Bun.spawn(
    [process.execPath, path.resolve(import.meta.dir, "../fixture/goal-child-c2-host.ts"), root, scenario],
    {
      cwd: path.join(root, "project"),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: path.join(root, "home"),
        TMPDIR: path.join(root, "tmp"),
        TMP: path.join(root, "tmp"),
        TEMP: path.join(root, "tmp"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
        DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"),
        DEEPAGENT_CODE_HOME: path.join(root, "data"),
        DEEPAGENT_CODE_DB: path.join(root, "authority.sqlite"),
        DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
        DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
        DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
        DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "1",
        DEEPAGENT_CODE_V2_OWNER_CAMPAIGN: "",
        DEEPAGENT_CODE_V2_OWNER_PUBLIC_KEY: "",
        DEEPAGENT_IM_AGENT_RESPONDER: "off",
        DEEPAGENT_CODE_SERVER_PASSWORD: "goal-rebase-fixture",
        NO_COLOR: "1",
      },
    },
  )
}

for (const changed of ["parent", "roster", "doc", "reject"]) {
  test(`actual pending approval ${changed === "reject" ? "returns typed operator rejection" : `rejects ${changed} mutation`} before any plan file effect`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-goal-rebase-ask-")))
    await Promise.all(
      ["home", "tmp", "config", "data", "cache", "state", "project"].map((name) => fs.mkdir(path.join(root, name))),
    )
    const child = spawn(root, `loop-proposal-two-rebase-ask-${changed}`)
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30000)
    try {
      const status = await child.exited
      const log = (await output).join("\n")
      await Bun.write(path.join(root, "output.log"), log)
      expect({ status, log, root }).toMatchObject({ status: 0 })
      const result = await Bun.file(path.join(root, "result.json")).json()
      expect(result.requests).toBe(4)
      expect(result.result.edit.journal.fileStarted).toBe(false)
      expect(result.result.edit.journal.commands).toHaveLength(1)
    } finally {
      clearTimeout(timeout)
    }
  }, 45000)
}

test("two actual HTTP clients cannot both commit from the same edit and control revisions", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-goal-rebase-clients-")))
  await Promise.all(
    ["home", "tmp", "config", "data", "cache", "state", "project"].map((name) => fs.mkdir(path.join(root, name))),
  )
  const child = spawn(root, "loop-proposal-two-rebase-clients")
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30000)
  try {
    const status = await child.exited
    const log = (await output).join("\n")
    await Bun.write(path.join(root, "output.log"), log)
    expect({ status, log, root }).toMatchObject({ status: 0 })
    const result = await Bun.file(path.join(root, "result.json")).json()
    expect(result.requests).toBe(4)
    expect(result.result.edit.journal.commands).toHaveLength(2)
    expect(result.result.edit.state).toBe("committed")
  } finally {
    clearTimeout(timeout)
  }
}, 45000)

test("actual standalone CLI reads a literal request file and applies through the authenticated live HTTP owner", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-goal-rebase-cli-")))
  await Promise.all(
    ["home", "tmp", "config", "data", "cache", "state", "project"].map((name) => fs.mkdir(path.join(root, name))),
  )
  const child = spawn(root, "loop-proposal-two-rebase-cli")
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const timeout = setTimeout(() => child.kill("SIGKILL"), 40000)
  try {
    const status = await child.exited
    const log = (await output).join("\n")
    await Bun.write(path.join(root, "output.log"), log)
    expect({ status, log, root }).toMatchObject({ status: 0 })
    const result = await Bun.file(path.join(root, "result.json")).json()
    expect(result.requests).toBe(8)
    const cli = await Bun.file(path.join(root, "cli-output.json")).json()
    expect(cli.status).toBe(0)
    expect(JSON.parse(cli.logs[0]).originalReceipt.state).toBe("committed")
  } finally {
    clearTimeout(timeout)
  }
}, 55000)

for (const window of ["prepare", "file1", "file2", "file3", "commit", "file1-stop"]) {
  test(`actual SIGKILL after rebase ${window}: cold GET writes nothing and exact reconciliation executes zero new inputs/providers`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-goal-rebase-cold-")))
    await Promise.all(
      ["home", "tmp", "config", "data", "cache", "state", "project"].map((name) => fs.mkdir(path.join(root, name))),
    )
    const child = spawn(root, `loop-proposal-two-rebase-cold-${window === "file1-stop" ? "file1" : window}`)
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    const timeout = setTimeout(() => child.kill("SIGKILL"), 45000)
    try {
      for (let n = 0; n < 2250 && !(await Bun.file(path.join(root, "cold-window.json")).exists()); n++) {
        if (child.exitCode !== null) break
        await Bun.sleep(20)
      }
      const reached = await Bun.file(path.join(root, "cold-window.json")).exists()
      child.kill("SIGKILL")
      await child.exited
      await Bun.write(path.join(root, "cold-output.log"), (await output).join("\n"))
      expect({ reached, root }).toMatchObject({ reached: true })
      const cut = await Bun.file(path.join(root, "cold-window.json")).json()
      expect(cut.window).toBe(window === "file1-stop" ? "file1" : window)
      const recovery = spawn(
        root,
        window === "file1-stop" ? "loop-proposal-two-rebase-recover-stop" : "loop-proposal-two-rebase-recover",
      )
      const recoveredOutput = Promise.all([new Response(recovery.stdout).text(), new Response(recovery.stderr).text()])
      const recoveredTimeout = setTimeout(() => recovery.kill("SIGKILL"), 30000)
      try {
        const status = await recovery.exited
        const log = (await recoveredOutput).join("\n")
        await Bun.write(path.join(root, "recovery-output.log"), log)
        expect({ status, log, root }).toMatchObject({ status: 0 })
        const result = await Bun.file(path.join(root, "result.json")).json()
        expect(result.requests).toBe(0)
        expect(result.result.receipt.current.state).toBe("committed")
        expect(result.result.active).toEqual([])
      } finally {
        clearTimeout(recoveredTimeout)
      }
    } finally {
      clearTimeout(timeout)
    }
  }, 90000)
}

for (const action of ["stop", "cancel"]) {
  test(`actual HTTP ${action} overrides a waiting rebase and revokes the running tick without another provider`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-goal-rebase-stop-")))
    await Promise.all(
      ["home", "tmp", "config", "data", "cache", "state", "project"].map((name) => fs.mkdir(path.join(root, name))),
    )
    const child = spawn(root, `loop-proposal-two-rebase-${action}-boundary`)
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30000)
    try {
      const status = await child.exited
      const log = (await output).join("\n")
      await Bun.write(path.join(root, "output.log"), log)
      expect({ status, log, root }).toMatchObject({ status: 0 })
      const result = await Bun.file(path.join(root, "result.json")).json()
      expect(result.requests).toBe(1)
      expect(result.result.control.requested_phase).toBe(action === "cancel" ? "paused" : "stopped")
      expect(result.result.receipt.current.execution).toBe("blocked")
      expect(result.result.active).toEqual([])
    } finally {
      clearTimeout(timeout)
    }
  }, 45000)
}
