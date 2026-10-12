#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"

const deepagentCode = path.resolve(dir, "../../deepagent-code")

await $`bun dev generate > ${dir}/openapi.json`.cwd(deepagentCode)

const sdkPlugins = [
  {
    name: "@hey-api/typescript" as const,
    exportFromIndex: false,
  },
  {
    name: "@hey-api/sdk" as const,
    instance: "DeepAgentCodeClient",
    exportFromIndex: false,
    auth: false,
    paramsStructure: "flat" as const,
  },
  {
    name: "@hey-api/client-fetch" as const,
    exportFromIndex: false,
    baseUrl: "http://localhost:4096",
  },
]

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: sdkPlugins,
})

// Patch a @hey-api/openapi-ts codegen bug: SseFn incorrectly passes the
// endpoint's TError into the second generic of ServerSentEventsResult, which
// is the AsyncGenerator's TReturn slot. Iterator return values have nothing
// to do with HTTP errors, and any consumer that calls `.return()` or returns
// from a mock generator gets type-checked against the wrong shape. Drop the
// arg so TReturn defaults to void.
const sseTypesPath = "./src/gen/client/types.gen.ts"
const sseTypesFile = Bun.file(sseTypesPath)
const sseTypesSource = await sseTypesFile.text()
const sseTypesPatched = sseTypesSource.replace(
  "=> Promise<ServerSentEventsResult<TData, TError>>",
  "=> Promise<ServerSentEventsResult<TData>>",
)
if (sseTypesPatched === sseTypesSource && !sseTypesSource.includes("=> Promise<ServerSentEventsResult<TData>>")) {
  throw new Error(`SseFn patch did not apply; @hey-api/openapi-ts output may have changed (${sseTypesPath})`)
}
if (sseTypesPatched !== sseTypesSource) await Bun.write(sseTypesPath, sseTypesPatched)

// Cancellation is asynchronous. A pending native fetch read can make cancel()
// reject after the synchronous try/catch, crashing a TUI that correctly aborted.
const ssePath = "./src/gen/core/serverSentEvents.gen.ts"
const sseSource = await Bun.file(ssePath).text()
const ssePatched = sseSource.replace("reader.cancel()", "void reader.cancel().catch(() => undefined)")
if (ssePatched === sseSource) throw new Error("SSE cancel patch did not apply; generator output changed")
await Bun.write(ssePath, ssePatched)

// The flat-parameter generator removes an empty body even when the API requires
// an object whose fields are all optional. Session creation with defaults is a
// valid request; retain {} without changing GETs or optional request bodies.
const { patchRequiredObjectBodies } = await import("./patch-required-object-bodies")
const sdkPath = "./src/gen/sdk.gen.ts"
await Bun.write(sdkPath, patchRequiredObjectBodies(await Bun.file(sdkPath).text(), await Bun.file("./openapi.json").json()))

// Error interceptors receive the original per-call options from hey-api, so a
// client-level `throwOnError: true` is otherwise invisible to them. Pass the
// resolved value to keep decoded server errors as real Error instances.
for (const clientPath of ["./src/gen/client/client.gen.ts"]) {
  const file = Bun.file(clientPath)
  const source = await file.text()
  const patched = source.replace(
    "finalError = await fn(finalError, response, request, options as ResolvedRequestOptions)",
    "finalError = await fn(finalError, response, request, { ...options, throwOnError } as ResolvedRequestOptions)",
  )
  if (patched === source && !source.includes("{ ...options, throwOnError } as ResolvedRequestOptions")) {
    throw new Error(
      `Error interceptor patch did not apply; @hey-api/openapi-ts output may have changed (${clientPath})`,
    )
  }
  if (patched !== source) await Bun.write(clientPath, patched)
}

await $`bun prettier --write src/gen`
await $`rm -rf dist`
await $`bun typecheck`
await $`bun tsgo`
await $`rm openapi.json`
