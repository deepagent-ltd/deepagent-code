export * from "./gen/types.gen.js"
export type {
  FileSystemBinaryContent as LocationFileSystemBinaryContent,
  FileSystemEntry as LocationFileSystemEntry,
  FileSystemTextContent as LocationFileSystemTextContent,
} from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { DeepAgentCodeClient as GeneratedClient } from "./gen/sdk.gen.js"
import { wrapClientError } from "../error-interceptor.js"

// ────────────────────────────────────────────────────────────────────────────
// Regeneration-proof compatibility layer.
//
// The generated SDK under `gen/` is pure `@hey-api/openapi-ts` output and is
// wiped clean on every `bun run build`. Historically the generated files were
// hand-edited to (a) add helpers the generator can never emit (e.g. an SSE URL
// *builder* rather than a fetch call) and (b) keep a flat call surface. That is
// brittle: once the backend annotated request bodies as named schemas
// (`.annotate({ identifier: "FileWriteBody" })`), OpenAPI emits `$ref` bodies,
// which `paramsStructure: "flat"` cannot hoist — so regeneration silently
// renames/re-nests methods (`createFile`→`create`, `write({path})`→
// `write({ fileWriteBody })`, lock methods move to a `lock` sub-client) and
// drops the hand-added `debug.eventsUrl`. Consumers using `as any` only crashed
// at runtime (`sdk.client.debug.eventsUrl is not a function`).
//
// Subclassing can't restore the flat surface: TS override variance rejects a
// flat-param method as an override of a nested-body one. Instead we patch the
// generated `file`/`debug` sub-client INSTANCES in-place with the historical
// methods (a NON-generated file the build never touches) and expose the result
// through a compat type. Each shim delegates to the canonical generated call,
// so it stays correct across regenerations by construction.
// ────────────────────────────────────────────────────────────────────────────

type GeneratedDebug = GeneratedClient["debug"]
type GeneratedFile = GeneratedClient["file"]

/** The `debug` sub-client's historical flat surface (delta over the generated one). */
type DebugCompatMethods = {
  /**
   * Build the `/debug/events` SSE URL for `new EventSource(url)`. The generator
   * emits `debug.events()` (a GET fetch), which cannot drive an EventSource, so
   * this URL builder must live outside generated code.
   */
  eventsUrl(parameters?: { directory?: string; workspace?: string; sessionId?: string }): string
  start(parameters: {
    directory?: string
    workspace?: string
    adapter: string
    program: string
    args?: string[]
    cwd?: string
    sessionId?: string
  }): ReturnType<GeneratedDebug["start"]>
  breakpoints(parameters: {
    directory?: string
    workspace?: string
    sessionId: string
    file: string
    breakpoints: Array<{ line: number; condition?: string }>
  }): ReturnType<GeneratedDebug["breakpoints"]>
  continue(parameters: {
    directory?: string
    workspace?: string
    sessionId: string
  }): ReturnType<GeneratedDebug["continue"]>
  step(parameters: {
    directory?: string
    workspace?: string
    sessionId: string
    kind: "next" | "stepIn" | "stepOut"
  }): ReturnType<GeneratedDebug["step"]>
  terminate(parameters: {
    directory?: string
    workspace?: string
    sessionId: string
  }): ReturnType<GeneratedDebug["terminate"]>
  evaluate(parameters: {
    directory?: string
    workspace?: string
    sessionId: string
    expression: string
    frameId?: number
  }): ReturnType<GeneratedDebug["evaluate"]>
  scopes(parameters: {
    directory?: string
    workspace?: string
    sessionId: string
    frameId: number
  }): ReturnType<GeneratedDebug["scopes"]>
  variables(parameters: {
    directory?: string
    workspace?: string
    sessionId: string
    variablesReference: number
  }): ReturnType<GeneratedDebug["variables"]>
}

/** The `file` sub-client's historical flat surface (delta over the generated one). */
type FileCompatMethods = {
  createFile(parameters: {
    directory?: string
    workspace?: string
    path: string
    content?: string
  }): ReturnType<GeneratedFile["create"]>
  deleteFile(parameters: { directory?: string; workspace?: string; path: string }): ReturnType<GeneratedFile["delete"]>
  lockAcquire(parameters: {
    directory?: string
    workspace?: string
    path: string
    kind: "human" | "agent"
  }): ReturnType<GeneratedFile["lock"]["acquire"]>
  lockRenew(parameters: {
    directory?: string
    workspace?: string
    lockId: string
  }): ReturnType<GeneratedFile["lock"]["renew"]>
  lockRelease(parameters: {
    directory?: string
    workspace?: string
    lockId: string
  }): ReturnType<GeneratedFile["lock"]["release"]>
  write(parameters: {
    directory?: string
    workspace?: string
    path: string
    content: string
    expected?: string
  }): ReturnType<GeneratedFile["write"]>
  rename(parameters: {
    directory?: string
    workspace?: string
    from: string
    to: string
  }): ReturnType<GeneratedFile["rename"]>
  mkdir(parameters: { directory?: string; workspace?: string; path: string }): ReturnType<GeneratedFile["mkdir"]>
}

type GeneratedProfile = GeneratedClient["profile"]

/** The `profile` sub-client's historical flat surface (delta over the generated one). */
type ProfileCompatMethods = {
  run(parameters: {
    directory?: string
    workspace?: string
    program: string
    profiler?: string
    args?: string[]
    cwd?: string
  }): ReturnType<GeneratedProfile["run"]>
  hotspots(parameters: {
    directory?: string
    workspace?: string
    runId: string
    limit?: number
  }): ReturnType<GeneratedProfile["hotspots"]>
}

/** `debug` with historical methods replacing the regenerated (nested-body / renamed) ones. */
type DebugCompat = Omit<GeneratedDebug, keyof DebugCompatMethods> & DebugCompatMethods
/** `file` with historical methods replacing the regenerated (nested-body / renamed) ones. */
type FileCompat = Omit<GeneratedFile, keyof FileCompatMethods> & FileCompatMethods
/** `profile` with historical methods replacing the regenerated (nested-body / string-typed) ones. */
type ProfileCompat = Omit<GeneratedProfile, keyof ProfileCompatMethods> & ProfileCompatMethods

/**
 * The client the app consumes: generated surface with the compat
 * `debug`/`file`/`profile` sub-clients. This is a TYPE only — `sdk.client` is
 * produced by `createDeepAgentCodeClient`, which patches the sub-client
 * instances in place. There is no bare-`new` class value (construct via the
 * factory), so the flat surface is always present.
 */
export type DeepAgentCodeClient = Omit<GeneratedClient, "debug" | "file" | "profile"> & {
  readonly debug: DebugCompat
  readonly file: FileCompat
  readonly profile: ProfileCompat
}
// `OpencodeClient` is the legacy alias for the same compat type. Construct via
// `createOpencodeClient()` / `createDeepAgentCodeClient()` (both apply the compat
// patch); there is no bare-`new` class value, so the flat `debug`/`file` surface
// is always present and can never silently regress.
export type { DeepAgentCodeClient as OpencodeClient }
export type DeepAgentCodeClientConfig = Config
export type OpencodeClientConfig = Config

/** Patch a generated client instance in-place with the historical flat `debug`/`file` methods. */
function applyCompat(client: GeneratedClient): DeepAgentCodeClient {
  const debug = client.debug
  const debugCompat: DebugCompatMethods = {
    eventsUrl: (parameters) => {
      const qs = new URLSearchParams()
      if (parameters?.directory) qs.set("directory", parameters.directory)
      if (parameters?.workspace) qs.set("workspace", parameters.workspace)
      if (parameters?.sessionId) qs.set("sessionId", parameters.sessionId)
      const q = qs.toString()
      return `/debug/events${q ? `?${q}` : ""}`
    },
    start: (parameters) => debug.start({ debugStartBody: parameters }),
    breakpoints: (parameters) => debug.breakpoints({ debugBreakpointsBody: parameters }),
    continue: (parameters) => debug.continue({ debugContinueBody: parameters }),
    step: (parameters) => debug.step({ debugStepBody: parameters }),
    terminate: (parameters) => debug.terminate({ debugTerminateBody: parameters }),
    evaluate: (parameters) => debug.evaluate({ debugEvaluateBody: parameters }),
    scopes: ({ frameId, ...rest }) => debug.scopes({ ...rest, frameId: String(frameId) }),
    variables: ({ variablesReference, ...rest }) =>
      debug.variables({ ...rest, variablesReference: String(variablesReference) }),
  }
  Object.assign(debug, debugCompat)

  const file = client.file
  const fileCompat: FileCompatMethods = {
    createFile: (parameters) => file.create({ fileCreateBody: parameters }),
    deleteFile: (parameters) => file.delete({ fileDeleteBody: parameters }),
    lockAcquire: (parameters) => file.lock.acquire({ lockAcquireBody: parameters }),
    lockRenew: (parameters) => file.lock.renew({ lockRenewBody: parameters }),
    lockRelease: (parameters) => file.lock.release({ lockReleaseBody: parameters }),
    write: (parameters) => file.write({ fileWriteBody: parameters }),
    rename: (parameters) => file.rename({ fileRenameBody: parameters }),
    mkdir: (parameters) => file.mkdir({ fileMkdirBody: parameters }),
  }
  Object.assign(file, fileCompat)

  const profile = client.profile
  const profileCompat: ProfileCompatMethods = {
    run: (parameters) => profile.run({ profileRunBody: parameters }),
    hotspots: ({ limit, ...rest }) =>
      profile.hotspots({ ...rest, ...(limit !== undefined ? { limit: String(limit) } : {}) }),
  }
  Object.assign(profile, profileCompat)

  return client as unknown as DeepAgentCodeClient
}

function pick(value: string | null, fallback?: string, encode?: (value: string) => string) {
  if (!value) return
  if (!fallback) return value
  if (value === fallback) return fallback
  if (encode && value === encode(fallback)) return fallback
  return value
}

function rewrite(request: Request, values: { directory?: string; workspace?: string }) {
  if (request.method !== "GET" && request.method !== "HEAD") return request

  const url = new URL(request.url)
  let changed = false

  for (const [name, key] of [
    ["x-deepagent-code-directory", "directory"],
    ["x-deepagent-code-workspace", "workspace"],
  ] as const) {
    const value = pick(
      request.headers.get(name),
      key === "directory" ? values.directory : values.workspace,
      key === "directory" ? encodeURIComponent : undefined,
    )
    if (!value) continue
    for (const query of url.pathname.startsWith("/api/") ? [key, `location[${key}]`] : [key]) {
      if (!url.searchParams.has(query)) {
        url.searchParams.set(query, value)
      }
    }
    changed = true
  }

  if (!changed) return request

  const next = new Request(url, request)
  next.headers.delete("x-deepagent-code-directory")
  next.headers.delete("x-deepagent-code-workspace")
  return next
}

export function createDeepAgentCodeClient(
  config?: Config & { directory?: string; experimental_workspaceID?: string },
): DeepAgentCodeClient {
  if (!config?.fetch) {
    const customFetch: any = (req: any) => {
      // @ts-ignore
      req.timeout = false
      return fetch(req)
    }
    config = {
      ...config,
      fetch: customFetch,
    }
  }

  if (config?.directory) {
    config.headers = {
      ...config.headers,
      "x-deepagent-code-directory": encodeURIComponent(config.directory),
    }
  }

  if (config?.experimental_workspaceID) {
    config.headers = {
      ...config.headers,
      "x-deepagent-code-workspace": config.experimental_workspaceID,
    }
  }

  const client = createClient(config)
  client.interceptors.request.use((request) =>
    rewrite(request, {
      directory: config?.directory,
      workspace: config?.experimental_workspaceID,
    }),
  )
  client.interceptors.response.use((response) => {
    const contentType = response.headers.get("content-type")
    if (contentType === "text/html")
      throw new Error(
        "Request is not supported by this version of DeepAgent Code Server (Server responded with text/html)",
      )

    return response
  })
  client.interceptors.error.use(wrapClientError)
  return applyCompat(new GeneratedClient({ client }))
}

export const createOpencodeClient = createDeepAgentCodeClient
