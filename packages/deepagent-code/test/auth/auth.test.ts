import { describe, expect } from "bun:test"
import { Effect, Layer, Result } from "effect"
import { Auth } from "../../src/auth"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(Auth.defaultLayer, node))

describe("Auth", () => {
  it.instance("set normalizes trailing slashes in keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeDefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set cleans up pre-existing trailing-slash entry", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "old",
      })
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "new",
      })
      const data = yield* auth.all()
      const keys = Object.keys(data).filter((key) => key.includes("example.com"))
      expect(keys).toEqual(["https://example.com"])
      const entry = data["https://example.com"]!
      expect(entry.type).toBe("wellknown")
      if (entry.type === "wellknown") expect(entry.token).toBe("new")
    }),
  )

  it.instance("remove deletes both trailing-slash and normalized keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      yield* auth.remove("https://example.com/")
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeUndefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set and remove are no-ops on keys without trailing slashes", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("anthropic", {
        type: "api",
        key: "sk-test",
      })
      const data = yield* auth.all()
      expect(data["anthropic"]).toBeDefined()
      yield* auth.remove("anthropic")
      const after = yield* auth.all()
      expect(after["anthropic"]).toBeUndefined()
    }),
  )
})

describe("Auth server mode (DEEPAGENT_SERVER_MODE, server-v1 §20.4)", () => {
  it.instance("set/remove fail closed while the flag is on, and recover when off", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      process.env.DEEPAGENT_SERVER_MODE = "true"
      try {
        const set = yield* auth.set("openai", { type: "api", key: "sk-test" }).pipe(Effect.result)
        expect(Result.isFailure(set)).toBe(true)
        if (Result.isFailure(set)) {
          expect(set.failure._tag).toBe("AuthError")
          expect(set.failure.message).toContain("server mode")
        }
        const remove = yield* auth.remove("openai").pipe(Effect.result)
        expect(Result.isFailure(remove)).toBe(true)
        // Blocked writes must not have persisted anything
        const data = yield* auth.all()
        expect(data["openai"]).toBeUndefined()
      } finally {
        delete process.env.DEEPAGENT_SERVER_MODE
      }
      // Flag off again: writes work (guards against process-global flag leakage)
      yield* auth.set("openai", { type: "api", key: "sk-test" })
      const data = yield* auth.all()
      expect(data["openai"]).toBeDefined()
      yield* auth.remove("openai")
    }),
  )
})
