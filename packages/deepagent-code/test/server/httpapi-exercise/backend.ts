import { ConfigProvider, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { parse } from "./assertions"
import { runtime, type Runtime } from "./runtime"
import type { ActiveScenario, BackendApp, CallResult, CaptureMode, SeededContext } from "./types"

type CallOptions = {
  auth?: {
    password?: string
    username?: string
  }
}

export function call(scenario: ActiveScenario, ctx: SeededContext<unknown>, options: CallOptions = {}) {
  return Effect.promise(async () => {
    const auth = options.auth ?? (scenario.serverAuth ? { username: "deepagent-code", password: "secret" } : undefined)
    return capture(await app(await runtime(), { auth }).request(toRequest(scenario, ctx)), scenario.capture)
  })
}

export function callAuthProbe(scenario: ActiveScenario, credentials: "missing" | "valid" = "missing") {
  return Effect.promise(async () => {
    const current = app(await runtime(), { auth: { password: "secret" } })
    await current.ready
    const controller = new AbortController()
    return Promise.race([
      Promise.resolve(current.request(toAuthProbeRequest(scenario, credentials, controller.signal))).then((response) =>
        capture(response, scenario.capture),
      ),
      Bun.sleep(1_000).then(() => {
        controller.abort("auth probe timed out")
        return {
          status: 0,
          contentType: "",
          text: "auth probe timed out",
          body: undefined,
          timedOut: true,
        }
      }),
    ])
  })
}

type CachedApp = BackendApp & { readonly ready: Promise<void>; readonly dispose: () => Promise<void> }

const appCache: Partial<Record<string, CachedApp>> = {}

export async function disposeApps() {
  const apps = Object.values(appCache)
  for (const key of Object.keys(appCache)) delete appCache[key]
  await Promise.all(apps.flatMap((app) => (app === undefined ? [] : [app.dispose()])))
}

function app(modules: Runtime, options: CallOptions) {
  const username = options.auth?.username
  const password = options.auth?.password
  const cacheKey = `${username ?? ""}:${password ?? ""}`
  if (appCache[cacheKey]) return appCache[cacheKey]

  const web = HttpRouter.toWebHandler(
    modules.HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            DEEPAGENT_CODE_SERVER_PASSWORD: password,
            DEEPAGENT_CODE_SERVER_USERNAME: username,
          }),
        ),
      ),
    ),
    { disableLogger: true, memoMap: modules.memoMap },
  )
  // Database migration is application setup. Keep the original one-second
  // authentication deadline on a ready app, rather than aborting its cold migration.
  const controller = new AbortController()
  const startup = Promise.withResolvers<void>()
  const timer = setTimeout(() => {
    controller.abort("HTTP exerciser application startup timed out")
    startup.reject(new Error("HTTP exerciser application startup timed out after 30 seconds"))
  }, 30_000)
  const ready = Promise.race([
    web
      .handler(
        new Request("http://localhost/global/health", {
          signal: controller.signal,
          headers: password ? { authorization: basic(username ?? "deepagent-code", password) } : {},
        }),
        modules.HttpApiApp.context,
      )
      .then(async (response) => {
        const body: unknown = await response.json()
        if (
          response.status !== 200 ||
          !body ||
          typeof body !== "object" ||
          !("healthy" in body) ||
          body.healthy !== true
        )
          throw new Error(`HTTP exerciser application health failed: ${response.status}`)
      }),
    startup.promise,
  ]).finally(() => clearTimeout(timer))
  return (appCache[cacheKey] = {
    ready,
    dispose: web.dispose,
    async request(input: string | URL | Request, init?: RequestInit) {
      await ready
      return web.handler(
        input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
        modules.HttpApiApp.context,
      )
    },
  })
}

function toRequest(scenario: ActiveScenario, ctx: SeededContext<unknown>) {
  const spec = scenario.request(ctx, ctx.state)
  return new Request(new URL(spec.path, "http://localhost"), {
    method: scenario.method,
    headers: {
      ...(scenario.serverAuth ? { authorization: basic("deepagent-code", "secret") } : {}),
      ...(spec.body === undefined ? {} : { "content-type": "application/json" }),
      ...spec.headers,
    },
    body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
  })
}

function toAuthProbeRequest(scenario: ActiveScenario, credentials: "missing" | "valid", signal: AbortSignal) {
  const spec = scenario.authProbe ?? {
    path: authProbePath(scenario.path),
    body: scenario.method === "GET" ? undefined : {},
  }
  const headers = {
    ...(spec.body === undefined ? {} : { "content-type": "application/json" }),
    ...spec.headers,
    ...(credentials === "valid" ? { authorization: basic("deepagent-code", "secret") } : {}),
  }
  return new Request(new URL(spec.path, "http://localhost"), {
    method: scenario.method,
    headers,
    body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
    signal,
  })
}

function basic(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

function authProbePath(path: string) {
  return path
    .replace(/\{([^}]+)\}/g, (_match, key: string) => `auth_${key}`)
    .replace(/:([^/]+)/g, (_match, key: string) => `auth_${key}`)
}

async function capture(response: Response, mode: CaptureMode): Promise<CallResult> {
  const text =
    mode === "stream" || mode === "finite-stream"
      ? await captureStream(response, mode === "finite-stream")
      : mode === "headers"
        ? response.body
          ? await response.body.cancel().then(
              () => "",
              () => "",
            )
          : ""
        : await response.text()
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    text,
    body: parse(text),
    timedOut: false,
  }
}

async function captureStream(response: Response, finite = false) {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const deadline = performance.now() + 1_000
  const decoder = new TextDecoder()
  const chunks: string[] = []
  try {
    while (true) {
      const read = reader.read().then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      )
      const winner = await Promise.race([
        read,
        Bun.sleep(Math.max(0, deadline - performance.now())).then(() => ({ timeout: true })),
      ])
      if ("timeout" in winner) throw new Error("timed out waiting for stream chunk")
      if ("error" in winner) throw winner.error
      if (winner.result.done) return chunks.join("") + decoder.decode()
      chunks.push(decoder.decode(winner.result.value, { stream: finite }))
      if (!finite) return chunks.join("")
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}
