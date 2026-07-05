import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Server } from "../../src/server/server"
import * as Log from "@deepagent-code/core/util/log"
import { Effect, Fiber } from "effect"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"
import { waitGlobalBusEvent } from "./global-bus"

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
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "config.json")).json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
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
