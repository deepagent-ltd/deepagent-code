import assert from "node:assert/strict"
import http from "node:http"
import https from "node:https"
import tls from "node:tls"
import diagnostics from "node:diagnostics_channel"
import { syncBuiltinESMExports } from "node:module"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Effect, Layer, Stream } from "effect"
import { LLM } from "../../src"
import { LLMClient } from "../../src/route/client"
import { RequestExecutor } from "../../src/route/executor"
import { BuiltinNode } from "../../src/route/builtin-node"
import { Auth } from "../../src/route/auth"
import { OpenAIResponses } from "../../src/protocols/openai-responses"

const group = process.env.DAC_NODE_FIXTURE_GROUP!
const body = 'data: {"type":"response.completed","response":{"id":"fixture"}}\n\n'
const factory = LLMClient.nativeManagedLayer.pipe(
  Layer.provide(RequestExecutor.defaultLayer),
  Layer.provide(Layer.succeed(LLMClient.Middleware, () => ({ prepare: (next) => next, stream: (next) => next }))),
)
const facts = { runtime: process.versions.node, group, ordinary: 0, count: 0, generation: 0, forbidden: 0, closed: 0, tlsRejected: 0, checks: 0 }
const check = (actual: unknown, expected: unknown, message?: string) => { assert.deepEqual(actual, expected, message ?? "Fixture invariant"); facts.checks++ }
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const listen = (server: http.Server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const close = (server: http.Server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })
const requestFor = (origin: string) => LLM.request({
  model: OpenAIResponses.route.with({ endpoint: { baseURL: `${origin}/v1` }, auth: Auth.value("private-fixture-key").bearer() }).model({ id: "fixture" }),
  system: "fixed", prompt: "有界输入", generation: { maxTokens: 16 }, providerOptions: { openai: { store: false } },
})
const policy = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
  Effect.provideService(RequestExecutor.CurrentRetryLimit, 0),
  Effect.provideService(RequestExecutor.CurrentRedirectPolicy, "manual"),
  Effect.provide(factory), Effect.scoped,
)

async function run() {
  // A plain library import is usable but has no executable-prefix construction evidence.
  check(BuiltinNode.describe(), undefined)
  check(await Effect.runPromise(Effect.gen(function* () {
    return LLMClient.nativeDescription(yield* LLMClient.Service)
  }).pipe(policy)), undefined)
  const seen: { path: string; bodyHash: string; authHash: string }[] = []
  const mode = { value: "success" }
  const sockets = new Set<import("node:net").Socket>()
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      const pathname = new URL(request.url!, "http://local").pathname
      seen.push({ path: pathname, bodyHash: hash(Buffer.concat(chunks).toString()), authHash: hash(request.headers.authorization ?? "") })
      if (pathname.endsWith("/input_tokens")) {
        facts.count++
        if (mode.value === "redirect" || mode.value === "304") { response.writeHead(mode.value === "304" ? 304 : 307, { location: "/forbidden" }); response.end(); return }
        if (mode.value === "503") { response.writeHead(503); response.end(); return }
        response.writeHead(200, { "content-type": "application/json" })
        if (mode.value === "cancel") { response.write('{"object":'); return }
        response.end(JSON.stringify({ object: "response.input_tokens", input_tokens: 41 })); return
      }
      if (pathname === "/forbidden") { facts.forbidden++; response.end(); return }
      if (pathname.startsWith("/ordinary/")) { facts.ordinary++; response.writeHead(200, { "content-type": "text/event-stream" }); response.end(body); return }
      facts.generation++
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (mode.value === "stream") { response.write(": partial\n\n"); return }
      response.end(body)
    })
  })
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => { sockets.delete(socket); facts.closed++ }) })
  await listen(server)
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Fixture listener unavailable")
  const origin = `http://127.0.0.1:${address.port}`
  try {
    if (group === "identity") {
      await Effect.runPromise(Effect.gen(function* () {
        const client = yield* LLMClient.Service
        check(LLMClient.nativeDescription(client), undefined)
        yield* client.generate(requestFor(`${origin}/ordinary`))
      }).pipe(policy))
      check(facts.ordinary, 1)
      seen.length = 0
    }
    check(BuiltinNode.install(), true)
    if (group === "identity") {
      await Effect.runPromise(Effect.gen(function* () {
        const client = yield* LLMClient.Service
        const request = requestFor(origin)
        check(LLMClient.nativeDescription(client)?.runtime, `node:${process.versions.node}`)
        check(LLMClient.nativeDescription({ ...client }), undefined)
        yield* LLMClient.bindNativeRequest(client, request)
        const observations: RequestExecutor.RequestSealInput[] = []
        yield* client.generate(request).pipe(Effect.provideService(RequestExecutor.CurrentRequestSeal, {
          seal: (observation) => Effect.gen(function* () {
            observations.push(observation)
            check(LLMClient.observesNative(client, request, observation), true)
            check(LLMClient.observesNative(client, { ...request }, observation), false)
            check(LLMClient.observesNative(client, request, { ...observation }), false)
            check((yield* LLMClient.countNativeInput(client, request, { ...observation }, Date.now() + 5000).pipe(Effect.exit))._tag, "Failure")
            const count = yield* LLMClient.countNativeInput(client, request, observation, Date.now() + 5000)
            check(count.inputTokens, 41)
            check((yield* LLMClient.countNativeInput(client, request, observation, Date.now() + 5000).pipe(Effect.exit))._tag, "Failure")
          }).pipe(Effect.orDie),
        }))
        check((yield* client.generate(request).pipe(Effect.exit))._tag, "Failure")
        check(observations.length, 1)
        check(seen.map((item) => item.path), ["/v1/responses/input_tokens", "/v1/responses"])
        check(seen[1].bodyHash, observations[0].bodyHash)
        check(seen[0].authHash, seen[1].authHash)
      }).pipe(policy))
      check(facts.count, 1); check(facts.generation, 1)
      // Startup ALL_PROXY is projected into the original Node Agent. NO_PROXY above allowed
      // the original local listener; this target must physically arrive at the private proxy.
      if (process.env.DAC_NODE_PROXY_ORIGIN) await Effect.runPromise(Effect.gen(function* () {
        const client = yield* LLMClient.Service
        const request = requestFor("http://fixture.invalid")
        yield* LLMClient.bindNativeRequest(client, request)
        yield* client.generate(request).pipe(Effect.provideService(RequestExecutor.CurrentRequestSeal, {
          seal: (observation) => LLMClient.countNativeInput(client, request, observation, Date.now() + 5000).pipe(Effect.asVoid, Effect.orDie),
        }))
      }).pipe(policy))
    }
    if (group === "mutation") {
      const originalRequest = http.request
      const originalWrite = http.OutgoingMessage.prototype.write
      const originalProxy = process.env.HTTPS_PROXY
      const originalRoots = tls.getCACertificates("default")
      const originalResponse = globalThis.Response
      const callback = () => {}
      const mutations = [
        { change: () => { http.request = (() => { throw new Error("Patched request") }) as typeof http.request }, restore: () => { http.request = originalRequest } },
        { change: () => { http.OutgoingMessage.prototype.write = (() => false) as typeof originalWrite }, restore: () => { http.OutgoingMessage.prototype.write = originalWrite } },
        { change: () => { http.request = (() => { throw new Error("Patched ESM") }) as typeof http.request; syncBuiltinESMExports(); http.request = originalRequest }, restore: () => syncBuiltinESMExports() },
        { change: () => { process.env.HTTPS_PROXY = "http://127.0.0.1:1" }, restore: () => { if (originalProxy === undefined) delete process.env.HTTPS_PROXY; if (originalProxy !== undefined) process.env.HTTPS_PROXY = originalProxy } },
        { change: () => diagnostics.subscribe("http.client.request.created", callback), restore: () => diagnostics.unsubscribe("http.client.request.created", callback) },
        { change: () => { globalThis.Response = class extends originalResponse {} }, restore: () => { globalThis.Response = originalResponse } },
      ]
      for (const [index, mutation] of mutations.entries()) {
        try {
          await Effect.runPromise(Effect.gen(function* () {
            const client = yield* LLMClient.Service
            const request = requestFor(origin)
            yield* LLMClient.bindNativeRequest(client, request)
            const exit = yield* client.generate(request).pipe(Effect.provideService(RequestExecutor.CurrentRequestSeal, {
              seal: () => Effect.sync(mutation.change),
            }), Effect.exit)
            check(exit._tag, "Failure")
            check(seen.length, 0)
          }).pipe(policy))
        } finally { mutation.restore() }
        check(BuiltinNode.current(), true, `Restored mutation ${index}`)
      }
      const secure = https.createServer({ key: await fs.readFile(process.env.DAC_NODE_TLS_KEY!), cert: await fs.readFile(process.env.DAC_NODE_TLS_CERT!) }, () => { facts.forbidden++ })
      secure.on("tlsClientError", () => { facts.tlsRejected++ })
      await listen(secure)
      try {
        const secureAddress = secure.address()
        if (!secureAddress || typeof secureAddress === "string") throw new Error("TLS fixture unavailable")
        await Effect.runPromise(Effect.gen(function* () {
          const client = yield* LLMClient.Service
          const request = requestFor(`https://127.0.0.1:${secureAddress.port}`)
          yield* LLMClient.bindNativeRequest(client, request)
          check((yield* client.generate(request).pipe(Effect.provideService(RequestExecutor.CurrentRequestSeal, { seal: () => Effect.void }), Effect.exit))._tag, "Failure")
        }).pipe(policy))
        await new Promise((resolve) => setTimeout(resolve, 30))
        check(facts.forbidden, 0)
        check(facts.tlsRejected, 1)
      } finally { await close(secure) }
      // setDefaultCACertificates normalizes certificates, so restoring its input need not
      // restore byte-identical default roots. Only the actual original digest may be current.
      try {
        await Effect.runPromise(Effect.gen(function* () {
          const client = yield* LLMClient.Service
          const request = requestFor(origin)
          yield* LLMClient.bindNativeRequest(client, request)
          check((yield* client.generate(request).pipe(Effect.provideService(RequestExecutor.CurrentRequestSeal, {
            seal: () => Effect.sync(() => tls.setDefaultCACertificates([])),
          }), Effect.exit))._tag, "Failure")
          check(seen.length, 0)
        }).pipe(policy))
      } finally { tls.setDefaultCACertificates(originalRoots) }
      check(BuiltinNode.current(), false)
    }
    if (group === "cleanup") {
      for (const selected of ["redirect", "304", "503", "cancel", "stream"]) {
        mode.value = selected
        const before = { count: facts.count, generation: facts.generation }
        await Effect.runPromise(Effect.gen(function* () {
          const client = yield* LLMClient.Service
          const request = requestFor(origin)
          yield* LLMClient.bindNativeRequest(client, request)
          const sealed = client.stream(request).pipe(Stream.runDrain,
            Effect.provideService(RequestExecutor.CurrentRequestSeal, {
              seal: (observation) => LLMClient.countNativeInput(client, request, observation, Date.now() + (selected === "cancel" ? 100 : 5000)).pipe(Effect.asVoid, Effect.orDie),
            }),
          )
          const exit = yield* (selected === "stream" ? sealed.pipe(Effect.timeout("300 millis")) : sealed).pipe(Effect.exit)
          check(exit._tag, "Failure")
        }).pipe(policy))
        await new Promise((resolve) => setTimeout(resolve, 30))
        check(facts.count - before.count, 1)
        check(facts.generation - before.generation, selected === "stream" ? 1 : 0)
        check(sockets.size, 0)
      }
      check(facts.forbidden, 0)
    }
    if (!["identity", "mutation", "cleanup"].includes(group)) throw new Error("Unknown fixture group")
  } finally { await close(server) }
  await new Promise((resolve) => setTimeout(resolve, 30))
  check(sockets.size, 0)
  return facts
}

async function electronMain() {
  const { app, utilityProcess } = await import("electron")
  const directory = process.env.DAC_NODE_FIXTURE_ROOT!
  app.setPath("userData", path.join(directory, "electron-user"))
  app.setPath("sessionData", path.join(directory, "electron-session"))
  app.commandLine.appendSwitch("disable-background-networking")
  app.on("window-all-closed", () => {})
  await app.whenReady()
  const child = utilityProcess.fork(process.env.DAC_NODE_FIXTURE_ENTRY!, [], { env: { ...process.env, DAC_NODE_FIXTURE_ELECTRON_MAIN: "0" }, stdio: "pipe" })
  const output = { stdout: "", stderr: "" }
  const timeout = setTimeout(() => { child.kill(); app.exit(3) }, 20000)
  child.stdout?.on("data", (bytes: Buffer) => { output.stdout += bytes.toString(); if (Buffer.byteLength(output.stdout) > 32768) { child.kill(); app.exit(4) } })
  child.stderr?.on("data", (bytes: Buffer) => { output.stderr += bytes.toString(); if (Buffer.byteLength(output.stderr) > 32768) { child.kill(); app.exit(4) } })
  child.on("exit", (code) => {
    clearTimeout(timeout)
    // Electron utility pipes do not promise EOF at process exit. The child writes its safe
    // facts after its real resource checks, before exiting; never infer success from a pipe.
    void fs.readFile(path.join(directory, "utility-facts.json"), "utf8")
      .then((facts) => fs.writeFile(path.join(directory, "electron-result.json"), JSON.stringify({ code, facts: JSON.parse(facts), ...output })))
      .then(() => app.exit(code ?? 1)).catch(() => app.exit(1))
  })
}

if (process.env.DAC_NODE_FIXTURE_ELECTRON_MAIN === "1") void electronMain().catch(() => process.exit(1))
if (process.env.DAC_NODE_FIXTURE_ELECTRON_MAIN !== "1") {
  try {
    const facts = await run()
    if (process.versions.electron) await fs.writeFile(path.join(process.env.DAC_NODE_FIXTURE_ROOT!, "utility-facts.json"), JSON.stringify(facts))
    process.stdout.write(`${JSON.stringify(facts)}\n`, () => process.exit(0))
  }
  catch (error) { console.error(error); process.exitCode = 1 }
}
