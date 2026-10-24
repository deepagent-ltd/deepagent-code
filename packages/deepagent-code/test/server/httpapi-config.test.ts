import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Server } from "../../src/server/server"
import * as Log from "@deepagent-code/core/util/log"
import { Effect, Fiber } from "effect"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"
import { waitGlobalBusEvent } from "./global-bus"
import { Config } from "../../src/config/config"
import { SettingsStore } from "../../src/settings/store"

void Log.init({ print: false })

function app() {
  return Server.Default().app
}

function waitDisposed(directory: string) {
  return waitGlobalBusEvent({
    message: "timed out waiting for instance disposal",
    predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
  })
}

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const CAPS_KEY = "DEEPAGENT_SERVER_CAPABILITIES"

describe("config HttpApi", () => {
  it.live(
    "round-trips native model selections through global and instance PATCH persistence and GET",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const request = (url: string, value?: unknown) =>
        Effect.promise(() =>
          Promise.resolve(
            app().request(url, {
              ...(value === undefined ? {} : { method: "PATCH", body: JSON.stringify(value) }),
              headers: { "content-type": "application/json", "x-deepagent-code-directory": tmp.path },
            }),
          ),
        )
      for (const route of ["/global/config", "/config"]) {
        const file = route === "/config" ? path.join(tmp.path, "deepagent-code.json") : Config.globalConfigFile()
        for (const disabled of [true, false]) {
          const disposed =
            route === "/config"
              ? yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))
              : undefined
          const value = { providers: { "selection-fixture": { models: { "remote-only": { disabled } } } } }
          const saved = yield* request(route, value)
          expect(saved.status).toBe(200)
          expect(yield* Effect.promise(() => saved.json())).toMatchObject(value)
          if (disposed) yield* Fiber.join(disposed)
          expect(yield* Effect.promise(() => Bun.file(file).json())).toMatchObject(value)
          const observed = yield* request(route)
          expect(observed.status).toBe(200)
          expect(yield* Effect.promise(() => observed.json())).toMatchObject(value)
        }
      }
    }),
  )

  it.live(
    "denies native and legacy provider writes in both config routes without mutating configuration stores",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const request = (url: string, value?: unknown) =>
        Effect.promise(() =>
          Promise.resolve(
            app().request(url, {
              ...(value === undefined ? {} : { method: "PATCH", body: JSON.stringify(value) }),
              headers: { "content-type": "application/json", "x-deepagent-code-directory": tmp.path },
            }),
          ),
        )
      for (const route of ["/global/config", "/config"]) expect((yield* request(route)).status).toBe(200)
      const files = [path.join(tmp.path, "deepagent-code.json"), Config.globalConfigFile(), SettingsStore.file()]
      const contents = yield* Effect.promise(() =>
        Promise.all(files.map(async (file) => ((await Bun.file(file).exists()) ? Bun.file(file).text() : null))),
      )
      const original = process.env[CAPS_KEY]
      process.env[CAPS_KEY] = JSON.stringify({ providerConfigEditable: false })
      try {
        for (const route of ["/global/config", "/config"]) {
          for (const value of [
            { provider: { anthropic: { models: {} } } },
            { providers: { anthropic: { models: { "remote-only": { disabled: false } } } } },
            { enabled_providers: ["anthropic"] },
            { disabled_providers: ["anthropic"] },
          ]) {
            const response = yield* request(route, value)
            expect(response.status).toBe(400)
            expect(
              yield* Effect.promise(() =>
                Promise.all(
                  files.map(async (file) => ((await Bun.file(file).exists()) ? Bun.file(file).text() : null)),
                ),
              ),
            ).toEqual(contents)
          }
        }
        const allowed = yield* request("/global/config", { username: "capability-non-provider" })
        expect(allowed.status).toBe(200)
        const observed = yield* request("/global/config")
        expect(yield* Effect.promise(() => observed.json())).toMatchObject({ username: "capability-non-provider" })
      } finally {
        if (original === undefined) delete process.env[CAPS_KEY]
        else process.env[CAPS_KEY] = original
      }
    }),
  )

  it.live(
    "IM service configuration uses the shared runtime, ignores project coordinates and stays disconnected until explicit retry",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const request = (url: string, value?: unknown) =>
        Effect.promise(() =>
          Promise.resolve(
            app().request(url, {
              ...(value === undefined ? {} : { method: "PATCH", body: JSON.stringify(value) }),
              headers: { "content-type": "application/json", "x-deepagent-code-directory": tmp.path },
            }),
          ),
        )
      const saved = yield* request("/global/config", { im: { url: "https://configured.invalid/platform///" } })
      expect(saved.status).toBe(200)
      expect(yield* Effect.promise(() => saved.json())).toMatchObject({
        im: { url: "https://configured.invalid/platform" },
      })
      const observed = yield* request("/api/v1/im/status")
      expect(observed.status).toBe(200)
      expect(yield* Effect.promise(() => observed.json())).toMatchObject({
        facade: "blocked",
        kernel: null,
        blocked: { code: "im_service_changed" },
        service: { url: "https://configured.invalid/platform", source: "config", reconnectRequired: true },
      })
      expect((yield* request("/config", { im: { url: "https://project.invalid" } })).status).toBe(200)
      const retained = yield* request("/api/v1/im/status")
      expect(yield* Effect.promise(() => retained.json())).toMatchObject({
        service: { url: "https://configured.invalid/platform" },
      })
      expect((yield* request("/global/config", { im: { url: "https://configured.invalid?secret=x" } })).status).toBe(
        400,
      )
      const closed = yield* request("/global/config", { im: { url: null } })
      expect(closed.status).toBe(200)
      const status = yield* request("/api/v1/im/status")
      expect(yield* Effect.promise(() => status.json())).toMatchObject({
        facade: "disabled",
        kernel: null,
        identity: null,
        service: { url: null, source: "config", reconnectRequired: false },
      })
    }),
  )

  it.live(
    "rejects a provider-touching config update when providerConfigEditable is denied",
    Effect.gen(function* () {
      const original = process.env[CAPS_KEY]
      process.env[CAPS_KEY] = JSON.stringify({ providerConfigEditable: false })
      try {
        const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
        const response = yield* Effect.promise(() =>
          Promise.resolve(
            app().request("/config", {
              method: "PATCH",
              headers: {
                "content-type": "application/json",
                "x-deepagent-code-directory": tmp.path,
              },
              body: JSON.stringify({ provider: { anthropic: { models: {} } } }),
            }),
          ),
        )
        expect(response.status).toBe(400)
      } finally {
        if (original === undefined) delete process.env[CAPS_KEY]
        else process.env[CAPS_KEY] = original
      }
    }),
  )

  it.live(
    "allows a non-provider config update even when providerConfigEditable is denied",
    Effect.gen(function* () {
      const original = process.env[CAPS_KEY]
      process.env[CAPS_KEY] = JSON.stringify({ providerConfigEditable: false })
      try {
        const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
        const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))
        const response = yield* Effect.promise(() =>
          Promise.resolve(
            app().request("/config", {
              method: "PATCH",
              headers: {
                "content-type": "application/json",
                "x-deepagent-code-directory": tmp.path,
              },
              body: JSON.stringify({ username: "patched-user", formatter: false, lsp: false }),
            }),
          ),
        )
        expect(response.status).toBe(200)
        yield* Fiber.join(disposed)
      } finally {
        if (original === undefined) delete process.env[CAPS_KEY]
        else process.env[CAPS_KEY] = original
      }
    }),
  )

  it.live(
    "serves config update through the default server app",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "x-deepagent-code-directory": tmp.path,
            },
            body: JSON.stringify({ username: "patched-user", formatter: false, lsp: false }),
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
      yield* Fiber.join(disposed)
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "deepagent-code.json")).json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
      const reloaded = yield* Effect.promise(() =>
        Promise.resolve(app().request("/config", { headers: { "x-deepagent-code-directory": tmp.path } })),
      )
      expect(reloaded.status).toBe(200)
      expect(yield* Effect.promise(() => reloaded.json())).toMatchObject({ username: "patched-user" })
    }),
  )

  it.live(
    "serves config with active provider model status",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({
        config: {
          formatter: false,
          lsp: false,
          provider: {
            omniroute: {
              models: {
                "gpt-4o": {
                  status: "active",
                },
              },
            },
          },
        },
      })

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            headers: {
              "x-deepagent-code-directory": tmp.path,
            },
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        provider: {
          omniroute: {
            models: {
              "gpt-4o": {
                status: "active",
              },
            },
          },
        },
      })
    }),
  )
})
