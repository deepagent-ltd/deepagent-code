import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { RepositoryCache } from "../../src/reference/repository-cache"
import type { RemoteReference } from "../../src/util/repository"
import { tmpdir } from "../fixture/fixture"

// The clone gate lives in the deepagent-code RepositoryCache, whose runtime does NOT mount the core
// Policy service — it evaluates the injected ServerCapabilities set directly from the env. These tests
// pin that env-direct behaviour: a deny short-circuits before git clone runs; unset is fail-open.

const CAPS_KEY = "DEEPAGENT_SERVER_CAPABILITIES"
const HOME_KEY = "DEEPAGENT_CODE_HOME"
const ADMIN_MESSAGE = "disabled by the server administrator"

const cacheLayer = RepositoryCache.defaultLayer

// A fabricated remote pointing at a path that does not exist. When cloning is ALLOWED the git clone
// runs and fails with a normal CloneFailedError; when DENIED the gate fails first with the admin
// message — so the message distinguishes the two paths without needing a live remote.
const reference = (root: string): RemoteReference => ({
  host: "file",
  protocol: "file:",
  path: path.join(root, "does-not-exist.git"),
  segments: ["capability-test", "repo"],
  repo: "repo",
  owner: "capability-test",
  remote: `file://${path.join(root, "does-not-exist.git")}`,
  label: "capability-test/repo",
})

const cloneError = (root: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const cache = yield* RepositoryCache.Service
      return yield* Effect.flip(cache.ensure({ reference: reference(root) }))
    }).pipe(Effect.provide(cacheLayer)),
  )

describe("RepositoryCache clone ServerCapabilities gate", () => {
  const originalCaps = process.env[CAPS_KEY]
  const originalHome = process.env[HOME_KEY]
  let home: Awaited<ReturnType<typeof tmpdir>> | undefined

  beforeEach(async () => {
    delete process.env[CAPS_KEY]
    home = await tmpdir()
    process.env[HOME_KEY] = home.path
  })

  afterEach(async () => {
    if (originalCaps === undefined) delete process.env[CAPS_KEY]
    else process.env[CAPS_KEY] = originalCaps
    if (originalHome === undefined) delete process.env[HOME_KEY]
    else process.env[HOME_KEY] = originalHome
    await home?.[Symbol.asyncDispose]()
    home = undefined
  })

  test("blocks the clone with the admin message when allowPublicRepoClone is false", async () => {
    process.env[CAPS_KEY] = JSON.stringify({ allowPublicRepoClone: false })
    const error = await cloneError(home!.path)
    expect(error).toBeInstanceOf(RepositoryCache.CloneFailedError)
    expect((error as RepositoryCache.CloneFailedError).message).toContain(ADMIN_MESSAGE)
  })

  test("reaches the git clone (different failure) when no capability set is injected", async () => {
    // Fail-open: the gate does not fire, so we get the real clone failure (missing remote), NOT the
    // admin message.
    const error = await cloneError(home!.path)
    expect(error).toBeInstanceOf(RepositoryCache.CloneFailedError)
    expect((error as RepositoryCache.CloneFailedError).message).not.toContain(ADMIN_MESSAGE)
  })
})
