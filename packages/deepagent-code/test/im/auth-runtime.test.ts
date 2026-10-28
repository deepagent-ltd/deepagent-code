import { beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { Database, constants } from "bun:sqlite"
import { pathToFileURL } from "node:url"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { AuthRuntime } from "../../src/im/auth-runtime"
import { ownedSecretBuild } from "../fixture/owned-secret-build"
import { managedBrowserInputRuntime } from "../../../desktop/scripts/managed-browser-input-runtime"
import {
  managedBrowserInputFixtureEnvironment,
  managedBrowserInputFixtureExecutable,
} from "../../../desktop/src/main/fixture/managed-browser-input-runtime"

const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-auth-runtime-")))
const fixture = path.resolve(import.meta.dir, "fixture/auth-runtime.ts")
const node = Bun.which("node")!
const password = "synthetic-é-é-🔒-\0-password"
const hash = await Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 65_536, timeCost: 3 })
beforeAll(async () => {
  const built = await Bun.build({
    entrypoints: [fixture],
    outdir: directory,
    naming: "fixture.mjs",
    target: "node",
    format: "esm",
    external: ["@lydell/node-pty", "jsonc-parser", "bun"],
    plugins: [ownedSecretBuild],
  })
  expect(built.success, built.logs.map((item) => item.message).join("\n")).toBe(true)
  const source = await fs.readFile(path.join(directory, "fixture.mjs"), "utf8")
  expect(source.includes("Bun.password")).toBe(false)
  const worker = await Bun.build({
    entrypoints: [path.resolve(import.meta.dir, "../../src/im/auth-password-worker.node.ts")],
    outdir: directory,
    naming: "auth-password-worker.node.js",
    target: "node",
    format: "esm",
  })
  expect(worker.success, worker.logs.map((item) => item.message).join("\n")).toBe(true)
  const indexWorker = await Bun.build({
    entrypoints: [path.resolve(import.meta.dir, "../../src/location-index/typescript-index.worker.ts")],
    outdir: directory,
    naming: "typescript-index.worker.js",
    target: "node",
    format: "esm",
  })
  expect(indexWorker.success, indexWorker.logs.map((item) => item.message).join("\n")).toBe(true)
  await fs.mkdir(path.join(directory, "node_modules/@lydell"), { recursive: true })
  await fs.symlink(
    await fs.realpath(
      path.dirname(
        createRequire(path.resolve(import.meta.dir, "../../../desktop/package.json")).resolve("@lydell/node-pty/package.json"),
      ),
    ),
    path.join(directory, "node_modules/@lydell/node-pty"),
    process.platform === "win32" ? "junction" : "dir",
  )
  // Match the actual Node build's external UMD dependency and its relative impl files.
  await fs.symlink(
    await fs.realpath(
      path.dirname(createRequire(path.resolve(import.meta.dir, "../../package.json")).resolve("jsonc-parser/package.json")),
    ),
    path.join(directory, "node_modules/jsonc-parser"),
    process.platform === "win32" ? "junction" : "dir",
  )
})

async function run(
  mode: string,
  input: object,
  desktop = false,
  environment: Record<string, string | undefined> = {},
  cwd = directory,
) {
  const id = crypto.randomUUID()
  const request = path.join(directory, `${id}.input.json`)
  const result = path.join(directory, `${id}.result.json`)
  await fs.writeFile(request, JSON.stringify(input), { mode: 0o600 })
  const main = path.join(directory, `${id}.electron.mjs`)
  if (desktop)
    await fs.writeFile(
      main,
      `import { app, utilityProcess } from "electron";
import path from "node:path";
app.setPath("userData", path.join(process.env.HOME, "electron-user-${id}"));
app.setPath("sessionData", path.join(process.env.HOME, "electron-session-${id}"));
app.commandLine.appendSwitch("disable-background-networking");
app.on("window-all-closed", () => {});
async function main() {
await app.whenReady();
const child = utilityProcess.fork(${JSON.stringify(path.join(directory, "fixture.mjs"))}, ${JSON.stringify([mode, request, result])}, {env:process.env,stdio:"pipe"});
child.stdout?.on("data", data => process.stdout.write(data));
child.stderr?.on("data", data => process.stderr.write(data));
const timer = setTimeout(() => { child.kill(); app.exit(2) }, ${mode === "worker-timeout" ? 40_000 : 25_000});
child.on("exit", code => { clearTimeout(timer); app.exit(code ?? 1) });
}
void main().catch(() => app.exit(1));
`,
    )
  const child = Bun.spawn(
    desktop
      ? [managedBrowserInputFixtureExecutable, main]
      : [node, path.join(directory, "fixture.mjs"), mode, request, result],
    {
      cwd,
      env: {
        ...managedBrowserInputFixtureEnvironment,
        PATH: path.dirname(node),
        HOME: directory,
        TMPDIR: directory,
        TEMP: directory,
        TMP: directory,
        NO_COLOR: "1",
        ...environment,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const timer = setTimeout(() => child.kill("SIGKILL"), mode === "worker-timeout" ? 45_000 : 30_000)
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(timer))
  await fs.writeFile(path.join(directory, `${id}.log`), stdout + stderr)
  expect(stdout + stderr).not.toContain(hash)
  expect(stdout + stderr).not.toContain(password)
  if (environment.DEEPAGENT_CODE_SERVER_PASSWORD)
    expect(stdout + stderr).not.toContain(environment.DEEPAGENT_CODE_SERVER_PASSWORD)
  expect({ status, diagnostic: status === 0 ? "ok" : stderr }).toEqual({ status: 0, diagnostic: "ok" })
  return JSON.parse(await fs.readFile(result, "utf8"))
}

test("Bun-produced PHC verifies asynchronously in real Node with exact Unicode and NUL bytes", async () => {
  const defaultHash = await Bun.password.hash(password)
  const result = await run("verify", {
    cases: [
      { password, verifier: hash },
      { password, verifier: defaultHash },
      { password: password + "wrong", verifier: hash },
      { password: password.normalize("NFC"), verifier: hash },
      { password: password.replace("\0", ""), verifier: hash },
    ],
  })
  expect(result.runtime.bun).toBeNull()
  expect(result.result.results).toEqual([
    { value: true },
    { value: true },
    { value: false },
    { value: false },
    { value: false },
  ])
  expect(await AuthRuntime.verify(password, hash)).toBe(true)
  const nodeHash = (await run("hash", { password })).result.verifier
  expect(await Bun.password.verify(password, nodeHash, "argon2id")).toBe(true)
  expect(await Bun.password.verify(password + "wrong", nodeHash, "argon2id")).toBe(false)
}, 40_000)

test("strict PHC and UTF-8 resource limits reject before expensive work in Bun and Node", async () => {
  const variants = [
    hash.replace("v=19", "v=16"),
    hash.replace("m=65536", "m=065536"),
    hash.replace("m=65536", "m=131073"),
    hash.replace("t=3", "t=7"),
    hash.replace("p=1", "p=5"),
    hash.replace("m=65536,t=3", "m=131072,t=4"),
    hash.replace("m=65536,t=3,p=1", "m=8,t=3,p=4"),
    hash + "=",
    hash + "\n",
    hash.replace("m=65536,t=3", "t=3,m=65536"),
    "$argon2id$" + "x".repeat(513),
    hash.replace("argon2id", "argon2i"),
  ]
  const cases = variants
    .map((verifier) => ({ password, verifier }))
    .concat([
      { password: "\ud800", verifier: hash },
      { password: "x".repeat(65_537), verifier: hash },
    ])
  for (const item of cases)
    await expect(AuthRuntime.verify(item.password, item.verifier)).rejects.toMatchObject({
      code: "LOCAL_OPERATOR_UNAVAILABLE",
    })
  expect((await run("verify", { cases })).result.results).toEqual(
    cases.map(() => ({ error: "LOCAL_OPERATOR_UNAVAILABLE" })),
  )
})

test("normal parallel credential reads wait for bounded verification capacity in Bun and Node", async () => {
  expect(await Promise.all([AuthRuntime.verify(password, hash), AuthRuntime.verify(password, hash), AuthRuntime.verify(password, hash)]))
    .toEqual([true, true, true])
  const result = (await run("bounded", { password, verifier: hash })).result
  expect(result).toMatchObject({ excess: { value: true }, during: { value: true }, completed: [true, true], released: true })
  expect(result.ticks).toBeGreaterThan(1)
})

test("queued credential cancellation and capacity overflow do not leak verification slots", async () => {
  const result = (await run("queue-cancel", { password, verifier: hash })).result
  expect(result).toMatchObject({ excess: { error: "LOCAL_OPERATOR_UNAVAILABLE" }, settledBeforeAbort: 0,
    completed: [true, true], released: true })
  expect(result.cancelled).toHaveLength(32)
  expect(result.cancelled.every((item: { error: string }) => item.error === "LOCAL_OPERATOR_UNAVAILABLE")).toBe(true)
})

test("real dedicated workers terminate on cancellation, fail invalid parameters and recover independently", async () => {
  expect((await run("worker-lifecycle", {})).result).toEqual({
    cancelled: true,
    invalid: true,
    missing: true,
    recovered: 32,
  })
  expect((await run("worker-lifecycle", {}, true)).result).toEqual({
    cancelled: true,
    invalid: true,
    missing: true,
    recovered: 32,
  })
})

test("source-mode worker resolves the same fixed module under real Node and Electron", async () => {
  const input = {
    password,
    verifier: hash,
    workerSource: path.resolve(import.meta.dir, "../../src/im/auth-password-worker-client.node.ts"),
  }
  expect((await run("worker-source", input)).result).toEqual({ matches: true })
  expect((await run("worker-source", input, true)).result).toEqual({ matches: true })
})

test("real Electron worker hard deadlines terminate stalled workers before admission recovers", async () => {
  const result = (await run("worker-timeout", { password, verifier: hash }, true)).result
  expect(result).toMatchObject({
    excess: { error: "LOCAL_OPERATOR_UNAVAILABLE" },
    results: [{ error: "LOCAL_OPERATOR_UNAVAILABLE" }, { error: "LOCAL_OPERATOR_UNAVAILABLE" }],
    recovered: true,
  })
  expect(result.elapsed).toBeGreaterThanOrEqual(29_000)
  expect(result.elapsed).toBeLessThan(40_000)
  expect(result.maxRSSKiB).toBeGreaterThan(0)
}, 50_000)

test("actual Node refuses retired enrollment and verifies Core-prepared operator credentials through the bounded backend", async () => {
  const root = await fs.mkdtemp(path.join(directory, "operator-"))
  await Promise.all(
    ["home", "tmp", "config", "data", "cache", "state", "project"].map((name) => fs.mkdir(path.join(root, name))),
  )
  const project = path.join(root, "project")
  const filename = path.join(root, "authority.sqlite")
  await fs.writeFile(
    path.join(project, "deepagent-code.json"),
    JSON.stringify({
      formatter: false,
      lsp: false,
      im: { url: null },
      providers: {
        fixture: {
          api: {
            type: "native",
            url: "https://example.invalid/v1/responses",
            settings: {},
            protocol: "openai.responses",
          },
          models: { probe: { api: { id: "probe" } } },
        },
      },
    }),
  )
  const policyPath = path.join(root, "policy.json")
  await fs.writeFile(
    policyPath,
    JSON.stringify({
      version: 1,
      targets: [
        {
          id: "review",
          directory: project,
          agentID: "auto",
          providerID: "fixture",
          modelID: "probe",
          budget: { ...WorkAuthorityPolicy.TEXT_ONLY_PROFILE.budget, maxTotalTokens: 8_000 },
        },
      ],
    }),
  )
  const previousCredentialPath = path.join(root, "previous.txt")
  const firstPassword = "\ufeffsynthetic-é-é-🔒-operator"
  const secondPassword = "second-synthetic-operator"
  await fs.writeFile(previousCredentialPath, firstPassword, { mode: 0o600 })
  const environment = {
    PATH: process.env.PATH,
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
    DEEPAGENT_CODE_DB: filename,
    DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
    DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
    DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
    DEEPAGENT_CODE_SERVER_USERNAME: "node-operator",
  }
  const operator = async (input: object, credential = firstPassword) =>
    (await run("operator", input, false, { ...environment, DEEPAGENT_CODE_SERVER_PASSWORD: credential }, project))
      .result
  const enroll = { action: "enroll", operationID: "node-enroll", policyPath }
  const refused = await operator(enroll)
  expect(refused).toEqual({ error: "LOCAL_TASK_EXECUTION_UNAVAILABLE" })
  expect((await fs.stat(filename)).isFile()).toBe(true)
  const rejected = new Database(`${pathToFileURL(filename).href}?immutable=1`,
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI)
  try {
    expect(rejected.query("SELECT count(*) count FROM local_operator_authority").get()).toEqual({ count: 0 })
    expect(() => rejected.run("CREATE TABLE forbidden_observer_write (id INTEGER)")).toThrow(/readonly|read-only/i)
  } finally {
    rejected.close()
  }
  const prepare = async () =>
    (
      await run("prepare-credentials", enroll, false,
        { ...environment, DEEPAGENT_CODE_SERVER_PASSWORD: firstPassword }, project)
    ).result
  const enrolled = await prepare()
  expect(enrolled.value.state).toBe("active")
  expect(await prepare()).toEqual(enrolled)
  const http = (
    await run("http", {}, false, { ...environment, DEEPAGENT_CODE_SERVER_PASSWORD: firstPassword }, project)
  ).result
  expect(http).toMatchObject({
    valid: 200,
    wrong: 401,
    malformed: 401,
    crossOrigin: 403,
    final: 200,
    noWork: { sessions: 0, inputs: 0, providers: 0, work: 0, grants: 0 },
  })
  expect(http.concurrent).toEqual([200, 200, 200])
  expect(http.parallelRules).toEqual([200, 200, 200])
  expect(http.unavailableReads).toEqual([
    { status: 503, code: "VALIDATION_UNAVAILABLE" },
    { status: 503, code: "INVESTIGATION_UNAVAILABLE" },
    { status: 503, code: "INVESTIGATION_UNAVAILABLE" },
  ])
  if (process.env.DAC_AUTH_OFFICIAL_ARTIFACT) {
    const packaged = (
      await run(
        "http",
        { artifact: process.env.DAC_AUTH_OFFICIAL_ARTIFACT },
        true,
        { ...environment, DEEPAGENT_CODE_SERVER_PASSWORD: firstPassword },
        project,
      )
    ).result
    expect(packaged).toMatchObject({ valid: 200, wrong: 401, malformed: 401, crossOrigin: 403, final: 200 })
    expect(packaged.concurrent).toEqual([200, 200, 200])
    expect(packaged.parallelRules).toEqual([200, 200, 200])
    expect(packaged.unavailableReads).toEqual(http.unavailableReads)
  }
  const rotate = { action: "rotate", operationID: "node-rotate", expectedRevision: 1 }
  const wrong = path.join(root, "wrong.txt")
  await fs.writeFile(wrong, "incorrect", { mode: 0o600 })
  expect((await operator({ ...rotate, previousCredentialPath: wrong }, secondPassword)).error).toBe(
    "LOCAL_OPERATOR_AUTH_REQUIRED",
  )
  await fs.writeFile(wrong, Buffer.from([0xff]))
  expect((await operator({ ...rotate, previousCredentialPath: wrong }, secondPassword)).error).toBe(
    "LOCAL_OPERATOR_AUTH_REQUIRED",
  )
  const rotated = await operator({ ...rotate, previousCredentialPath }, secondPassword)
  expect(rotated.value.revision).toBe(2)
  expect(await operator(rotate, secondPassword)).toEqual(rotated)
  const revoke = { action: "revoke", operationID: "node-revoke", expectedRevision: 2 }
  const revoked = await operator(revoke, secondPassword)
  expect(revoked.value.state).toBe("revoked")
  expect(await operator(revoke, secondPassword)).toEqual(revoked)
  // Every writer process has exited and checkpointed its WAL. Read this cold file without
  // asking Bun's independent SQLite library to recreate Node's closed WAL sidecars.
  expect(
    await fs.stat(`${filename}-wal`).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
  const database = new Database(`${pathToFileURL(filename).href}?immutable=1`,
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI)
  try {
    expect(() => database.run("CREATE TABLE forbidden_observer_write (id INTEGER)")).toThrow(/readonly|read-only/i)
    expect(database.query("SELECT revision,credential_generation,state FROM local_operator_authority").get()).toEqual({
      revision: 3,
      credential_generation: 3,
      state: "revoked",
    })
    expect(
      database
        .query(
          "SELECT (SELECT count(*) FROM session) sessions,(SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM session_provider_attempt) providers,(SELECT count(*) FROM work_execution) work,(SELECT count(*) FROM im_task_grant) grants",
        )
        .get(),
    ).toEqual(http.noWork)
  } finally {
    database.close()
  }
}, 100_000)

test("real Node Argon2 waits within bounded capacity and retains slots until actual work completes", async () => {
  const result = (await run("bounded", { password, verifier: hash })).result
  expect(result).toMatchObject({
    excess: { value: true },
    timeout: "timeout",
    during: { value: true },
    completed: [true, true],
    released: true,
  })
  expect(result.ticks).toBeGreaterThan(1)
})

test("Bun native verification shares the same bounded admission and releases slots after real work", async () => {
  const first = AuthRuntime.verify(password, hash)
  const second = AuthRuntime.verify(password, hash)
  const queuedHash = AuthRuntime.hash(password)
  const queuedVerify = AuthRuntime.verify(password, hash)
  expect(await Promise.all([first, second])).toEqual([true, true])
  expect(await Bun.password.verify(password, await queuedHash, "argon2id")).toBe(true)
  expect(await queuedVerify).toBe(true)
  expect(await AuthRuntime.verify(password + "wrong", hash)).toBe(false)
})

test("actual Node crypto FIPS failure is typed, does not leak inputs and releases the work slot", async () => {
  expect((await run("crypto-failure", { password, verifier: hash })).result).toEqual({
    refused: { error: "LOCAL_OPERATOR_UNAVAILABLE" },
    recovered: true,
  })
})

test("actual Node OwnedValidation resolves its executable from the fixed PATH and preserves native containment", async () => {
  expect((await run("owned", {})).result).toEqual(process.platform === "darwin"
    ? { state: "exited", outcome: "passed", output: "native-node-owned" }
    : process.platform === "linux"
      ? { state: "unknown", outcome: null, output: "native-node-owned", containment: "posix-group",
          stopProof: "unconfirmed", reason: "containment_unconfirmed", exitCode: 0, quarantined: 1,
          unsupportedProfile: "PROFILE_UNAVAILABLE" }
      : { error: "PROFILE_UNAVAILABLE", dispatched: false })
})

test("actual Electron utility uses the bounded WASM worker for unsupported native Argon2", async () => {
  expect((await run("crypto-probe", {}, true)).result).toMatchObject({ code: "ERR_CRYPTO_ARGON2_NOT_SUPPORTED" })
  const result = await run("desktop", { password, verifier: hash }, true)
  expect(result.runtime).toEqual({
    node: managedBrowserInputRuntime.nodeVersion,
    electron: managedBrowserInputRuntime.electronVersion,
    bun: null,
  })
  expect(result.result).toMatchObject({
    matched: { value: true },
    wrong: { value: false },
    appVersion: `Electron/${managedBrowserInputRuntime.electronVersion} Node/${managedBrowserInputRuntime.nodeVersion}`,
  })
  expect(await Bun.password.verify(password, result.result.hashed.value)).toBe(true)
  const concurrent = (await run("bounded", { password, verifier: hash }, true)).result
  expect(concurrent).toMatchObject({
    excess: { value: true },
    timeout: "timeout",
    during: { value: true },
    completed: [true, true],
    released: true,
  })
  expect(concurrent.ticks).toBeGreaterThan(1)
}, 40_000)

test("canonical salt/tag extremes, parallelism and exact maximum UTF-8 bytes interoperate", async () => {
  const maximum = "é".repeat(32_768)
  const vectors = (await run("vectors", { password: maximum })).result.vectors as {
    verifier: string
    matched: boolean
  }[]
  for (const vector of vectors) {
    expect(vector.matched).toBe(true)
    expect(await AuthRuntime.verify(maximum, vector.verifier)).toBe(true)
    await expect(AuthRuntime.verify(maximum + "x", vector.verifier)).rejects.toMatchObject({
      code: "LOCAL_OPERATOR_UNAVAILABLE",
    })
  }
  const canonical = vectors[0]!.verifier
  const parts = canonical.split("$")
  const variants = [
    canonical.replace(parts[4]!, Buffer.alloc(7).toString("base64").replace(/=+$/, "")),
    canonical.replace(parts[5]!, Buffer.alloc(15).toString("base64").replace(/=+$/, "")),
    canonical.replace(parts[4]!, parts[4]!.slice(0, -1) + "d"),
  ]
  const cases = variants.map((verifier) => ({ password, verifier }))
  expect((await run("verify", { cases })).result.results).toEqual(
    cases.map(() => ({ error: "LOCAL_OPERATOR_UNAVAILABLE" })),
  )
  const supported = vectors.flatMap((vector) => [
    { password: maximum, verifier: vector.verifier },
    { password: maximum.slice(1), verifier: vector.verifier },
  ])
  expect((await run("forced-worker", { cases: supported })).result.results).toEqual([
    { value: true },
    { value: false },
    { value: true },
    { value: false },
    { value: true },
    { value: false },
  ])
  expect((await run("verify", { cases: supported }, true)).result.results).toEqual([
    { value: true },
    { value: false },
    { value: true },
    { value: false },
    { value: true },
    { value: false },
  ])
}, 40_000)
