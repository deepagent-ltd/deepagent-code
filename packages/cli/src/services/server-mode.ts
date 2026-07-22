import { Global } from "@deepagent-code/core/global"
import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect"
import path from "path"

export interface Transport {
  readonly url: string
  readonly headers: Record<string, string>
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

export interface Workspace {
  readonly id: string
  readonly name?: string
  readonly status?: string
}

export interface Interface {
  readonly status: () => Effect.Effect<Option.Option<State>>
  readonly login: (gatewayUrl: string, email: string, password: string) => Effect.Effect<State, Error>
  readonly logout: () => Effect.Effect<void>
  readonly workspaces: () => Effect.Effect<readonly Workspace[], Error>
  readonly useWorkspace: (id: string) => Effect.Effect<Workspace, Error>
  readonly transport: () => Effect.Effect<Option.Option<Transport>, Error>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/cli/ServerMode") {}

const State = Schema.Struct({
  gatewayUrl: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.Number),
  workspaceId: Schema.optional(Schema.String),
})
type State = typeof State.Type

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = Global.Path.state
    const file = path.join(directory, "server-mode.json")

    const read = Effect.fnUntraced(function* () {
      const text = yield* fs.readFileString(file)
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(State))(text)
    })

    const write = Effect.fnUntraced(function* (state: State) {
      const temp = file + ".tmp"
      yield* fs.makeDirectory(directory, { recursive: true })
      yield* fs.writeFileString(temp, JSON.stringify(state), { mode: 0o600 })
      yield* fs.rename(temp, file)
    })

    // DEEPAGENT_GATEWAY_URL pins the gateway (server-v1 §20.3 auto-switch). When
    // set it takes precedence over the stored gateway; a mismatch means the user
    // must log in against the pinned gateway first.
    const resolve = Effect.fnUntraced(function* () {
      const stored = yield* read().pipe(Effect.option)
      const pinned = process.env.DEEPAGENT_GATEWAY_URL
      const gatewayUrl = pinned ?? (Option.isSome(stored) ? stored.value.gatewayUrl : undefined)
      if (gatewayUrl === undefined) return Option.none<{ gatewayUrl: string; state: State }>()
      if (Option.isNone(stored) || stored.value.gatewayUrl !== gatewayUrl) {
        return yield* Effect.fail(
          new Error(`Not logged in to ${gatewayUrl}. Run \`dacode login ${gatewayUrl}\` first.`),
        )
      }
      return Option.some({ gatewayUrl, state: stored.value })
    })

    const gatewayError = (response: Response) =>
      Effect.tryPromise(() => response.json()).pipe(
        Effect.map((body): string => {
          const error = (body as { error?: { message?: unknown } })?.error
          return typeof error?.message === "string" ? error.message : `${response.status} ${response.statusText}`
        }),
        Effect.catch(() => Effect.succeed(`${response.status} ${response.statusText}`)),
      )

    const post = (url: string, init: RequestInit) =>
      Effect.tryPromise({
        try: () => fetch(url, init),
        catch: () => new Error(`Gateway ${url} is unreachable`),
      })

    let refreshing: Promise<State> | undefined
    const refresh = Effect.fn("cli.server-mode.refresh")(function* () {
      const current = yield* read().pipe(
        Effect.mapError(() => new Error("Session expired. Run `dacode login` again.")),
      )
      if (!current.refreshToken)
        return yield* Effect.fail(new Error("Session expired. Run `dacode login` again."))
      const response = yield* post(`${current.gatewayUrl}/control/v1/auth/refresh`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${current.refreshToken}`,
          cookie: `refresh_token=${current.refreshToken}`,
        },
      })
      if (!response.ok)
        return yield* Effect.fail(new Error("Session expired. Run `dacode login` again."))
      const body = yield* Effect.tryPromise({
        try: () => response.json() as Promise<Record<string, unknown>>,
        catch: () => new Error("Gateway returned an invalid refresh response"),
      })
      if (typeof body.access_token !== "string")
        return yield* Effect.fail(new Error("Gateway returned an invalid refresh response"))
      const next: State = {
        ...current,
        accessToken: body.access_token,
        refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : current.refreshToken,
        expiresAt:
          typeof body.expires_in === "number" ? Date.now() + body.expires_in * 1000 : current.expiresAt,
      }
      yield* write(next)
      return next
    })

    // Single-flight refresh shared by the Effect world (workspace commands) and
    // the plain-fetch world (TUI transport), so concurrent 401s trigger one
    // refresh round.
    const refreshOnce = () =>
      (refreshing ??= Effect.runPromise(refresh()).finally(() => (refreshing = undefined)))

    const accessToken = Effect.fnUntraced(function* () {
      const state = yield* read().pipe(Effect.mapError(() => new Error("Not logged in")))
      if (state.expiresAt !== undefined && state.expiresAt < Date.now() + 30_000) {
        return yield* Effect.tryPromise({
          try: () => refreshOnce(),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        }).pipe(Effect.map((state) => state.accessToken))
      }
      return state.accessToken
    })

    const authed = Effect.fnUntraced(function* (url: string, init: RequestInit = {}) {
      const token = yield* accessToken()
      const send = (token: string) =>
        Effect.tryPromise({
          try: () => fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } }),
          catch: () => new Error(`Gateway ${url} is unreachable`),
        })
      const first = yield* send(token)
      if (first.status !== 401) return first
      const refreshed = yield* Effect.tryPromise({
        try: () => refreshOnce(),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      })
      return yield* send(refreshed.accessToken)
    })

    const login = Effect.fn("cli.server-mode.login")(function* (
      gatewayUrl: string,
      email: string,
      password: string,
    ) {
      const response = yield* post(`${gatewayUrl}/control/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      })
      if (!response.ok) {
        const message = yield* gatewayError(response)
        return yield* Effect.fail(new Error(`Login failed: ${message}`))
      }
      const body = yield* Effect.tryPromise({
        try: () => response.json() as Promise<Record<string, unknown>>,
        catch: () => new Error("Gateway returned an invalid login response"),
      })
      if (typeof body.access_token !== "string")
        return yield* Effect.fail(new Error("Gateway returned an invalid login response"))
      const cookie = response.headers.get("set-cookie") ?? undefined
      const refreshToken =
        typeof body.refresh_token === "string"
          ? body.refresh_token
          : cookie?.match(/(?:^|;\s*)refresh_token=([^;]+)/)?.[1]
      const state: State = {
        gatewayUrl,
        accessToken: body.access_token,
        refreshToken,
        expiresAt: typeof body.expires_in === "number" ? Date.now() + body.expires_in * 1000 : undefined,
      }
      yield* write(state)
      return state
    })

    const logout = Effect.fn("cli.server-mode.logout")(function* () {
      const current = yield* read().pipe(Effect.option)
      if (Option.isSome(current)) {
        yield* Effect.tryPromise(() =>
          fetch(`${current.value.gatewayUrl}/control/v1/auth/logout`, {
            method: "POST",
            headers: { authorization: `Bearer ${current.value.accessToken}` },
          }),
        ).pipe(Effect.ignore)
      }
      yield* fs.remove(file).pipe(Effect.ignore)
    })

    const workspaces = Effect.fn("cli.server-mode.workspaces")(function* () {
      const resolved = yield* resolve()
      if (Option.isNone(resolved)) return yield* Effect.fail(new Error("Not logged in"))
      const response = yield* authed(`${resolved.value.gatewayUrl}/control/v1/workspaces`)
      if (!response.ok) {
        const message = yield* gatewayError(response)
        return yield* Effect.fail(new Error(`Failed to list workspaces: ${message}`))
      }
      const body = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () => new Error("Gateway returned an invalid workspaces response"),
      })
      const list = Array.isArray(body)
        ? body
        : Array.isArray((body as { workspaces?: unknown })?.workspaces)
          ? (body as { workspaces: unknown[] }).workspaces
          : undefined
      if (!list) return yield* Effect.fail(new Error("Gateway returned an invalid workspaces response"))
      return list.map(
        (entry): Workspace => ({
          id: String((entry as { id?: unknown }).id ?? ""),
          name: typeof (entry as { name?: unknown }).name === "string" ? (entry as { name: string }).name : undefined,
          status:
            typeof (entry as { status?: unknown }).status === "string"
              ? (entry as { status: string }).status
              : undefined,
        }),
      )
    })

    const useWorkspace = Effect.fn("cli.server-mode.useWorkspace")(function* (id: string) {
      const list = yield* workspaces()
      const found = list.find((workspace) => workspace.id === id)
      if (!found)
        return yield* Effect.fail(
          new Error(`Workspace ${id} not found. Run \`dacode workspace list\` to see available workspaces.`),
        )
      const current = yield* read().pipe(Effect.mapError(() => new Error("Not logged in")))
      yield* write({ ...current, workspaceId: id })
      return found
    })

    const transport = Effect.fn("cli.server-mode.transport")(function* () {
      const resolved = yield* resolve()
      if (Option.isNone(resolved)) return Option.none()
      const { gatewayUrl, state } = resolved.value
      if (!state.workspaceId)
        return yield* Effect.fail(
          new Error(
            "No workspace selected. Run `dacode workspace list` and `dacode workspace use <id>` first.",
          ),
        )
      const remote = async (input: RequestInfo | URL, init?: RequestInit) => {
        const send = (token: string) => {
          const headers = new Headers(input instanceof Request ? input.headers : undefined)
          new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
          headers.set("authorization", `Bearer ${token}`)
          return fetch(input as RequestInfo | URL, { ...init, headers })
        }
        const first = await send(await Effect.runPromise(accessToken()))
        if (first.status !== 401) return first
        const refreshed = await refreshOnce()
        return send(refreshed.accessToken)
      }
      return Option.some({
        url: `${gatewayUrl}/w/${state.workspaceId}`,
        headers: {},
        fetch: remote,
      })
    })

    const status = Effect.fn("cli.server-mode.status")(function* () {
      return yield* read().pipe(Effect.option)
    })

    return Service.of({ status, login, logout, workspaces, useWorkspace, transport })
  }),
)

export const defaultLayer = layer

export * as ServerMode from "./server-mode"
