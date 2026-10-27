import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { AuthRuntime } from "../../../src/im/auth-runtime"

const input = JSON.parse(await fs.readFile(process.argv[3]!, "utf8")) as {
  cases?: { password: string; verifier: string }[]
  password: string
  verifier: string
  action?: "enroll" | "rotate" | "revoke"
  operationID?: string
  policyPath?: string
  expectedRevision?: number
  previousCredentialPath?: string
  artifact?: string
  workerSource?: string
}
const outcome = async (body: Promise<unknown>) =>
  body.then(
    (value) => ({ value }),
    (error: unknown) => ({
      error: typeof error === "object" && error !== null && "code" in error ? error.code : "UNEXPECTED",
      ...(error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND"
        ? { missingModule: error.message.slice(0, 1024) }
        : {}),
    }),
  )
const result = await (async () => {
  if (process.argv[2] === "verify") {
    const results = []
    for (const item of input.cases!) results.push(await outcome(AuthRuntime.verify(item.password, item.verifier)))
    return { results }
  }
  if (process.argv[2] === "hash") return { verifier: await AuthRuntime.hash(input.password) }
  if (process.argv[2] === "worker-source") {
    const { pathToFileURL } = await import("node:url")
    const { timingSafeEqual } = await import("node:crypto")
    assert(input.workerSource)
    const source = await import(pathToFileURL(input.workerSource).href)
    const fields = input.verifier.split("$")
    const tag = Buffer.from(fields[5]!, "base64")
    const key = await source.PasswordWorker.derive(Buffer.from(input.password), {
      memory: 65_536,
      passes: 3,
      parallelism: 1,
      nonce: Buffer.from(fields[4]!, "base64"),
      tag,
    })
    return { matches: timingSafeEqual(key, tag) }
  }
  if (process.argv[2] === "worker-timeout") {
    // Fault only this test's private copied asset. The real parent's fixed 30 s deadline,
    // Worker termination, exit confirmation and shared admission logic remain unchanged.
    const worker = new URL("./auth-password-worker.node.js", import.meta.url)
    const original = await fs.readFile(worker)
    await fs.writeFile(worker, 'import {parentPort} from "node:worker_threads"; parentPort.on("message", () => {});')
    const started = Date.now()
    const first = AuthRuntime.verify(input.password, input.verifier)
    const second = AuthRuntime.verify(input.password, input.verifier)
    const excess = await outcome(AuthRuntime.verify(input.password, input.verifier))
    try {
      const results = await Promise.all([outcome(first), outcome(second)])
      await fs.writeFile(worker, original)
      return {
        excess,
        results,
        elapsed: Date.now() - started,
        recovered: await AuthRuntime.verify(input.password, input.verifier),
        maxRSSKiB: process.resourceUsage().maxRSS,
      }
    } finally {
      await fs.writeFile(worker, original)
    }
  }
  if (process.argv[2] === "forced-worker") {
    const { default: crypto } = await import("node:crypto")
    const { syncBuiltinESMExports } = await import("node:module")
    const original = crypto.argon2
    // Inject only the native unsupported result. All fallback derivation runs in real Node workers.
    Object.defineProperty(crypto, "argon2", {
      value: () => {
        throw Object.assign(new Error("Synthetic unsupported native implementation"), {
          code: "ERR_CRYPTO_ARGON2_NOT_SUPPORTED",
        })
      },
      configurable: true,
    })
    syncBuiltinESMExports()
    try {
      const results = []
      for (const item of input.cases!) results.push(await outcome(AuthRuntime.verify(item.password, item.verifier)))
      return { results }
    } finally {
      Object.defineProperty(crypto, "argon2", { value: original, configurable: true })
      syncBuiltinESMExports()
    }
  }
  if (process.argv[2] === "worker-lifecycle") {
    const { PasswordWorker } = await import("../../../src/im/auth-password-worker-client.node")
    const parameters = { memory: 65_536, passes: 3, parallelism: 1, nonce: Buffer.alloc(32, 7), tag: Buffer.alloc(32) }
    const controller = new AbortController()
    const pending = PasswordWorker.derive(Buffer.from("synthetic-worker"), parameters, controller.signal)
    controller.abort()
    const cancelled = await pending.then(
      () => false,
      () => true,
    )
    const invalid = await PasswordWorker.derive(Buffer.from("synthetic-worker"), { ...parameters, memory: 1 }).then(
      () => false,
      () => true,
    )
    const asset = new URL("./auth-password-worker.node.js", import.meta.url)
    const saved = new URL("./auth-password-worker.saved.js", import.meta.url)
    await fs.rename(asset, saved)
    const missing = await PasswordWorker.derive(Buffer.from("synthetic-worker"), parameters)
      .then(
        () => false,
        () => true,
      )
      .finally(() => fs.rename(saved, asset))
    const recovered = await PasswordWorker.derive(Buffer.from("synthetic-worker"), parameters)
    return { cancelled, invalid, missing, recovered: recovered.length }
  }
  if (process.argv[2] === "crypto-probe") {
    const { argon2 } = await import("node:crypto")
    return await new Promise((resolve) => {
      try {
        argon2(
          "argon2id",
          {
            message: Buffer.from("synthetic-probe"),
            nonce: Buffer.alloc(32, 7),
            memory: 65_536,
            passes: 3,
            parallelism: 1,
            tagLength: 32,
          },
          (error, key) =>
            resolve(
              error
                ? { name: error.name, message: error.message, code: "code" in error ? error.code : null }
                : { length: key.length },
            ),
        )
      } catch (error) {
        resolve({
          name: error instanceof Error ? error.name : "unknown",
          message: error instanceof Error ? error.message : "unknown",
          code: typeof error === "object" && error !== null && "code" in error ? error.code : null,
        })
      }
    })
  }
  if (process.argv[2] === "desktop") {
    await import("../../../src/im/kernel/shims")
    return {
      hashed: await outcome(AuthRuntime.hash(input.password)),
      matched: await outcome(AuthRuntime.verify(input.password, input.verifier)),
      wrong: await outcome(AuthRuntime.verify(input.password + "wrong", input.verifier)),
      appVersion: (globalThis.navigator as Navigator & { appVersion: string }).appVersion,
    }
  }
  if (process.argv[2] === "vectors") {
    const { argon2 } = await import("node:crypto")
    const vectors = []
    for (const sizes of [
      { salt: 8, tag: 16, memory: 32, passes: 1 },
      { salt: 64, tag: 64, memory: 32, passes: 1 },
      { salt: 32, tag: 32, memory: 131_072, passes: 3 },
    ]) {
      const nonce = Buffer.alloc(sizes.salt, 7)
      const key = await new Promise<Buffer>((resolve, reject) =>
        argon2(
          "argon2id",
          {
            message: Buffer.from(input.password, "utf8"),
            nonce,
            memory: sizes.memory,
            passes: sizes.passes,
            parallelism: 4,
            tagLength: sizes.tag,
          },
          (error, value) => (error ? reject(error) : resolve(value)),
        ),
      )
      const verifier = `$argon2id$v=19$m=${sizes.memory},t=${sizes.passes},p=4$${nonce.toString("base64").replace(/=+$/, "")}$${key.toString("base64").replace(/=+$/, "")}`
      vectors.push({ verifier, matched: await AuthRuntime.verify(input.password, verifier) })
    }
    return { vectors }
  }
  if (process.argv[2] === "bounded") {
    const progress = { ticks: 0 }
    const timer = setInterval(() => progress.ticks++, 5)
    try {
      const first = AuthRuntime.verify(input.password, input.verifier)
      const second = AuthRuntime.verify(input.password, input.verifier)
      const excess = outcome(AuthRuntime.verify(input.password, input.verifier))
      const timeout = await Promise.race([
        first.then(() => "completed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 1)),
      ])
      const during = outcome(AuthRuntime.verify(input.password, input.verifier))
      const completed = await Promise.all([first, second])
      const released = await AuthRuntime.verify(input.password, input.verifier)
      return { excess: await excess, timeout, during: await during, completed, released, ticks: progress.ticks }
    } finally {
      clearInterval(timer)
    }
  }
  if (process.argv[2] === "queue-cancel") {
    const running = [AuthRuntime.verify(input.password, input.verifier), AuthRuntime.verify(input.password, input.verifier)]
    const controllers = Array.from({ length: 32 }, () => new AbortController())
    const progress = { settled: 0 }
    const queued = controllers.map((controller) => outcome(AuthRuntime.verify(input.password, input.verifier, controller.signal))
      .then((result) => { progress.settled++; return result }))
    const excess = await outcome(AuthRuntime.verify(input.password, input.verifier))
    const settledBeforeAbort = progress.settled
    controllers.forEach((controller) => controller.abort())
    const cancelled = await Promise.all(queued)
    const completed = await Promise.all(running)
    return { excess, settledBeforeAbort, cancelled, completed, released: await AuthRuntime.verify(input.password, input.verifier) }
  }
  if (process.argv[2] === "crypto-failure") {
    const { setFips, getFips } = await import("node:crypto")
    setFips(true)
    assert.equal(getFips(), 1)
    const refused = await outcome(AuthRuntime.verify(input.password, input.verifier))
    // This Node/OpenSSL build reports an error while successfully restoring its non-FIPS property state.
    try {
      setFips(false)
    } catch {
      assert.equal(getFips(), 0)
    }
    return { refused, recovered: await AuthRuntime.verify(input.password, input.verifier) }
  }
  if (process.argv[2] === "operator" || process.argv[2] === "prepare-credentials") {
    const { Effect, Layer } = await import("effect")
    const { command } = await import("../../../src/cli/cmd/operator")
    const { Database } = await import("@deepagent-code/core/database/database")
    const { LocationIdentity } = await import("@deepagent-code/core/context-federation/identity")
    const { FSUtil } = await import("@deepagent-code/core/fs-util")
    const { ServerAuth } = await import("../../../src/server/auth")
    const credentials = await import("./operator-credentials")
    assert(input.action && input.operationID)
    const database = Database.defaultLayer
    return await outcome(
      Effect.runPromise(
        (process.argv[2] === "prepare-credentials"
          ? credentials.prepare(input.operationID).pipe(Effect.provide(credentials.layer.pipe(Layer.provide(database))))
          : command({
              action: input.action,
              operationID: input.operationID,
              policyPath: input.policyPath,
              expectedRevision: input.expectedRevision,
              previousCredentialPath: input.previousCredentialPath,
            })).pipe(
          Effect.provide(LocationIdentity.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer))),
          Effect.provide(database),
          Effect.provide(ServerAuth.Config.defaultLayer),
          Effect.scoped,
        ),
      ),
    )
  }
  if (process.argv[2] === "http") {
    const { Effect } = await import("effect")
    const { Database } = await import("@deepagent-code/core/database/database")
    const { AppRuntime } = await import("../../../src/effect/app-runtime")
    const { pathToFileURL } = await import("node:url")
    const service = input.artifact
      ? await import(pathToFileURL(input.artifact).href)
      : await import("../../../src/server/server")
    const { createServer } = await import("node:net")
    if (!input.artifact) await AppRuntime.runPromise(Database.Service)
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
    const address = probe.address()
    assert(address && typeof address !== "string")
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    const listener = await service.Server.listen({
      hostname: "127.0.0.1",
      port: address.port,
      cors: ["http://127.0.0.1:45123"],
    })
    const auth = `Basic ${Buffer.from(`${process.env.DEEPAGENT_CODE_SERVER_USERNAME}:${process.env.DEEPAGENT_CODE_SERVER_PASSWORD}`, "utf8").toString("base64")}`
    async function request(authorization = auth, origin?: string, pathname = "/api/v1/event-validation/rules") {
      const response = await fetch(new URL(pathname, listener.url), {
        headers: {
          authorization,
          "x-deepagent-code-directory": process.cwd(),
          ...(origin ? { origin } : {}),
        },
        signal: AbortSignal.timeout(20_000),
      })
      await response.arrayBuffer()
      return response.status
    }
    try {
      const valid = await request()
      const wrong = await request(`Basic ${Buffer.from("node-operator:wrong").toString("base64")}`)
      const malformed = await request(
        `Basic ${Buffer.concat([Buffer.from("node-operator:"), Buffer.from([0xff])]).toString("base64")}`,
      )
      const crossOrigin = await request(auth, "http://127.0.0.1:45124")
      const concurrent = await Promise.all([request(), request(), request()])
      const parallelRules = await Promise.all(Array.from({ length: 3 }, () => request(auth, undefined, "/api/v1/event-validation/rules")))
      const { LocalAuthority } = await import("../../../src/installation/local-authority")
      const installation = LocalAuthority.installationPath()
      await fs.rename(installation, installation + ".temporarily-unavailable")
      const unavailableReads = await (async () => {
        try {
          return await Promise.all([
            "/api/v1/event-validation/rules", "/api/v1/event-investigation/rules/absent/candidates",
            "/api/v1/event-investigation/rules/absent/reports",
          ].map(async (pathname) => {
            const response = await fetch(new URL(pathname, listener.url), { headers: { authorization: auth } })
            const body: unknown = await response.json()
            return { status: response.status, code: typeof body === "object" && body !== null && "code" in body ? body.code : null }
          }))
        } finally {
          await fs.rename(installation + ".temporarily-unavailable", installation)
        }
      })()
      const final = await request()
      const noWork = input.artifact
        ? null
        : await AppRuntime.runPromise(
            Effect.gen(function* () {
              return (yield* (yield* Database.Service).db.all(
                "SELECT (SELECT count(*) FROM session) sessions,(SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM session_provider_attempt) providers,(SELECT count(*) FROM work_execution) work,(SELECT count(*) FROM im_task_grant) grants",
              ))[0]
            }),
          )
      return { valid, wrong, malformed, crossOrigin, concurrent, parallelRules, unavailableReads, final, noWork }
    } finally {
      await listener.stop(true)
    }
  }
  if (process.argv[2] === "owned") {
    const { Effect } = await import("effect")
    const { OwnedValidation } = await import("../../../src/deepagent/owned-validation")
    return await Effect.runPromise(
      Effect.gen(function* () {
        const handle = yield* OwnedValidation.prepare({
          cwd: process.cwd(),
          profile: "darwin-single-process-v1",
          command: {
            id: "node-fixed-path",
            source: "user",
            transport: "argv",
            executable: "printf",
            args: ["native-node-owned"],
            display: "printf",
          },
        })
        const receipt = yield* OwnedValidation.run(handle)
        const observed = OwnedValidation.inspect(receipt)!
        assert.equal(observed.outcome, "passed")
        return { state: observed.state, outcome: observed.outcome, output: observed.stdout.text }
      }).pipe(Effect.scoped),
    )
  }
  throw new Error("Unsupported isolated fixture mode")
})()
await fs.writeFile(
  process.argv[4]!,
  JSON.stringify({
    runtime: {
      node: process.versions.node,
      bun: process.versions.bun ?? null,
      electron: process.versions.electron ?? null,
    },
    result,
  }),
)
if (process.argv[2] === "http" || process.versions.electron) process.exit(0)
