export * from "./gen/types.gen.js"
export type {
  FileSystemBinaryContent as LocationFileSystemBinaryContent,
  FileSystemEntry as LocationFileSystemEntry,
  FileSystemTextContent as LocationFileSystemTextContent,
} from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Client } from "./gen/client/types.gen.js"
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
// §16.5 API-APP-PACKAGE P2 — durable session event cursor primitive. The generated session
// client cannot drive an EventSource, so the URL builder and the gap-detecting subscription live
// here in the non-generated compat layer (regeneration-proof by construction).

export type SessionEventPayload = {
  readonly id?: string
  readonly type?: string
  readonly seq?: number
  readonly data?: Record<string, unknown>
}

/** Returns true when the next event seq is NOT the expected successor (gap / reset / duplicate). */
export const detectSeqGap = (lastSeq: number | undefined, nextSeq: number | undefined) =>
  lastSeq !== undefined && nextSeq !== undefined && nextSeq !== lastSeq + 1

export type SessionEventCursor = {
  readonly close: () => void
  readonly url: string
}

type SessionCursorCompatMethods = {
  /**
   * Build the `/api/session/:id/events` SSE URL for `new EventSource(url)`. Reconnect with the
   * last seen cursor to receive exactly the tail (durable cursor replay, no gap).
   */
  sessionEventsUrl(sessionId: string, parameters?: { after?: string }): string
  /**
   * Subscribe to a session's event journal with gap/reset detection: events are delivered in
   * journal order; a non-consecutive seq (or an undefined seq after a defined one) triggers
   * `onResync` once instead of silently accepting the gap.
   */
  sessionEventCursor(
    sessionId: string,
    input: {
      readonly after?: string
      readonly onEvent: (event: SessionEventPayload) => void
      readonly onResync?: (detail: { readonly lastSeq?: number; readonly nextSeq?: number }) => void
      readonly onError?: (error: unknown) => void
    },
  ): SessionEventCursor
  /**
   * Read the session event journal high-water cursor. Snapshot-at-watermark consumers fetch
   * the message snapshot after this read and then subscribe sessionEventStream(after=cursor):
   * every journaled event at or below the cursor is already reflected in the snapshot, so the
   * drain is an exact live tail with no gap and no replay.
   */
  sessionEventWatermark(sessionId: string): Promise<number | undefined>
  /**
   * Subscribe to a session's durable event journal as a fetch-backed stream (works in
   * Bun/Node/browser environments without an EventSource): the stream drains from after
   * through the journal, then tails live journaled events. Each yielded value is the parsed
   * { id, type, seq, data } payload; frame retries are disabled so the caller owns the
   * resync policy (detectSeqGap).
   */
  sessionEventStream(
    sessionId: string,
    input?: {
      readonly after?: string
      readonly onError?: (error: unknown) => void
    },
  ): Promise<{ readonly stream: AsyncGenerator<SessionEventPayload>; readonly close: () => void }>
}

type GeneratedSession = GeneratedClient["session"]
export type SessionCursorCompat = Omit<GeneratedSession, "sessionEventsUrl" | "sessionEventCursor"> &
  SessionCursorCompatMethods

export type DeepAgentCodeClient = Omit<GeneratedClient, "debug" | "file" | "profile" | "session"> & {
  readonly debug: DebugCompat
  readonly file: FileCompat
  readonly profile: ProfileCompat
  readonly session: SessionCursorCompat
}
// `OpencodeClient` is the legacy alias for the same compat type. Construct via
// `createOpencodeClient()` / `createDeepAgentCodeClient()` (both apply the compat
// patch); there is no bare-`new` class value, so the flat `debug`/`file` surface
// is always present and can never silently regress.
export type { DeepAgentCodeClient as OpencodeClient }
export type DeepAgentCodeClientConfig = Config
export type OpencodeClientConfig = Config

/** Patch a generated client instance in-place with the historical flat `debug`/`file` methods. */
function applyCompat(client: GeneratedClient, eventSourceAuthToken?: string): DeepAgentCodeClient {
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

  // The generated sub-clients hold the raw HeyApi client as a protected member; the raw
  // surface (get / sse) is what the flat compat primitives delegate to, exactly like the
  // generated methods do through their own sub-client instances.
  const raw = (client as unknown as { readonly client: Client }).client
  const session = client.session
  const sessionCompat: SessionCursorCompatMethods = {
    sessionEventsUrl: (sessionId, parameters) => {
      const qs = new URLSearchParams()
      if (parameters?.after) qs.set("after", parameters.after)
      const q = qs.toString()
      return `/api/session/${sessionId}/events${q ? `?${q}` : ""}`
    },
    sessionEventCursor: (sessionId, input) => {
      const url = sessionCompat.sessionEventsUrl(sessionId, { after: input.after })
      // The URL builder returns a relative path; EventSource resolves it against the PAGE origin,
      // which in the desktop renderer is the oc://renderer file protocol (app/freeloader shell) —
      // the request would 404 as a file instead of reaching the sidecar. Resolve against the
      // client baseUrl so the SSE endpoint is fetched over the actual server origin.
      // buildUrl lives on the raw hey-api client (the generated DeepAgentCodeClient wrapper
      // does not expose it); it applies the client baseUrl — the same origin the REST calls use.
      const sourceUrl = new URL(raw.buildUrl({ url }))
      if (eventSourceAuthToken) sourceUrl.searchParams.set("auth_token", eventSourceAuthToken)
      const source = new EventSource(sourceUrl, { withCredentials: true })
      let lastSeq: number | undefined
      let resynced = false
      source.onmessage = (message) => {
        const event = JSON.parse(message.data) as SessionEventPayload
        if (!resynced && detectSeqGap(lastSeq, event.seq)) {
          resynced = true
          input.onResync?.({ lastSeq, nextSeq: event.seq })
        }
        if (event.seq !== undefined) lastSeq = event.seq
        input.onEvent(event)
      }
      source.onerror = (error) => input.onError?.(error)
      return { close: () => source.close(), url }
    },
    sessionEventWatermark: async (sessionId) => {
      const result = await raw.get<{ readonly cursor?: number | null }, unknown, true>({
        url: sessionCompat.sessionEventsUrl(sessionId) + "/cursor",
      })
      // The generated request type narrows the response to TData[keyof TData] but the
      // runtime body is the parsed envelope object; the cast is the compat contract.
      const body = result.data as unknown as { readonly cursor?: number | null } | undefined
      return body?.cursor ?? undefined
    },
    sessionEventStream: async (sessionId, input) => {
      const controller = new AbortController()
      const url = sessionCompat.sessionEventsUrl(sessionId, { after: input?.after })
      const result = await raw.sse.get<SessionEventPayload>({
        url,
        signal: controller.signal,
        sseMaxRetryAttempts: 0,
        onSseError: (error) => input?.onError?.(error),
      })
      return {
        stream: result.stream as AsyncGenerator<SessionEventPayload>,
        close: () => controller.abort(),
      }
    },
  }
  Object.assign(session, sessionCompat)

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
  const eventSourceAuthToken = (() => {
    if (!config?.headers) return
    const headers = config.headers instanceof Headers ? config.headers : new Headers(config.headers as HeadersInit)
    return /^Basic\s+(.+)$/i.exec(headers.get("authorization") ?? "")?.[1]
  })()
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
  return applyCompat(new GeneratedClient({ client }), eventSourceAuthToken)
}

export const createOpencodeClient = createDeepAgentCodeClient
