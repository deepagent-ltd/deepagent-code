import { eventLayer } from "../fixture/event-layer"
import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ConfigProvider, Deferred, Duration, Effect, Fiber, Layer, Option, Stream } from "effect"
import { Config } from "@deepagent-code/core/config"
import { EventV2 } from "@deepagent-code/core/event"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Watcher } from "@deepagent-code/core/filesystem/watcher"
import { Git } from "@deepagent-code/core/git"
import { Location } from "@deepagent-code/core/location"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { watcherDelivers } from "./watcher-delivery-probe"

// The suite needs a host that DELIVERS filesystem events; liveness alone is not enough (see the
// probe module for the measured failure and for the false negative an in-file probe once produced).
const forceWatcher = process.env.DEEPAGENT_CODE_WATCHER_TESTS === "force"
const watcherUsable = Watcher.hasNativeBinding() && !process.env.CI && (forceWatcher || (await watcherDelivers()))
const describeWatcher = watcherUsable ? describe : describe.skip
if (!watcherUsable && Watcher.hasNativeBinding() && !process.env.CI)
  console.warn(
    "[watcher] skipped: this host is not delivering filesystem events " +
      "(re-run on an idle machine, or set DEEPAGENT_CODE_WATCHER_TESTS=force to run anyway).",
  )

type WatcherEvent = { file: string; event: "add" | "change" | "unlink" }

const it = testEffect(Layer.mergeAll(FSUtil.defaultLayer, eventLayer()))

const configLayer = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed([]),
  }),
)

const flagsLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    DEEPAGENT_CODE_EXPERIMENTAL_FILEWATCHER: "true",
    DEEPAGENT_CODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "false",
  }),
)

function provide(directory: string, vcs?: Location.Interface["vcs"]) {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) }, { vcs })),
  )
  return Effect.provide(
    Watcher.layer.pipe(
      Layer.provide(configLayer),
      Layer.provide(Git.defaultLayer),
      Layer.provide(locationLayer),
      Layer.provide(flagsLayer),
    ),
  )
}

function withTmp<A, E, R>(
  f: (directory: string, vcs?: Location.Interface["vcs"]) => Effect.Effect<A, E, R>,
  options?: { git?: boolean; init?: (directory: string) => Promise<void> },
) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const tmp = await tmpdir()
      if (!options?.git) return { tmp, vcs: undefined }
      await $`git init`.cwd(tmp.path).quiet()
      await $`git config core.fsmonitor false`.cwd(tmp.path).quiet()
      await $`git config commit.gpgsign false`.cwd(tmp.path).quiet()
      await $`git config user.email test@deepagent-code.test`.cwd(tmp.path).quiet()
      await $`git config user.name Test`.cwd(tmp.path).quiet()
      await $`git commit --allow-empty -m root`.cwd(tmp.path).quiet()
      await options.init?.(tmp.path)
      return { tmp, vcs: { type: "git" as const, store: AbsolutePath.make(path.join(tmp.path, ".git")) } }
    }),
    ({ tmp }) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap(({ tmp, vcs }) => f(tmp.path, vcs).pipe(provide(tmp.path, vcs))))
}

function wait(check: (event: WatcherEvent) => boolean) {
  return Effect.gen(function* () {
    const events = yield* EventV2.Service
    const deferred = yield* Deferred.make<WatcherEvent>()
    const fiber = yield* events.subscribe(Watcher.Event.Updated).pipe(
      Stream.runForEach((event) => {
        if (!check(event.data)) return Effect.void
        return Deferred.succeed(deferred, event.data).pipe(Effect.asVoid)
      }),
      Effect.forkScoped,
    )
    yield* Effect.yieldNow
    return { deferred, fiber }
  })
}

function maybeNextUpdate<E>(
  check: (event: WatcherEvent) => boolean,
  trigger: Effect.Effect<void, E>,
  // Delivery latency, not liveness: `ready()` already established that the subscription exists, so a
  // larger window only tolerates a busy host (fs-events under load delivered the first callback
  // seconds late, which is what made this suite fail in bulk runs).
  timeout: Duration.Input = "20 seconds",
) {
  return Effect.acquireUseRelease(
    wait(check),
    ({ deferred }) => trigger.pipe(Effect.andThen(Deferred.await(deferred)), Effect.timeoutOption(timeout)),
    ({ fiber }) => Fiber.interrupt(fiber),
  )
}

function nextUpdate<E>(check: (event: WatcherEvent) => boolean, trigger: Effect.Effect<void, E>) {
  return Effect.gen(function* () {
    const result = yield* maybeNextUpdate(check, trigger)
    if (Option.isSome(result)) return result.value
    return yield* Effect.fail(new Error("timed out waiting for file watcher update"))
  })
}

function eventuallyUpdate<E>(check: (event: WatcherEvent) => boolean, trigger: () => Effect.Effect<void, E>) {
  return Effect.gen(function* () {
    while (true) {
      const result = yield* maybeNextUpdate(check, trigger(), "250 millis")
      if (Option.isSome(result)) return result.value
    }
  }).pipe(
    // The probe loop tolerates a cold backend, and its budget is a FRACTION of the per-test budget:
    // this used to wait up to 20s while several tests also budget 30s, so on a loaded machine
    // readiness alone consumed the test and the real assertions never ran (the watcher suite failed
    // in bulk runs, 5 of 6, while passing alone).
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new Error("timed out waiting for file watcher readiness")),
    }),
  )
}

function noUpdate<E>(check: (event: WatcherEvent) => boolean, trigger: Effect.Effect<void, E>, timeout = 500) {
  return Effect.acquireUseRelease(
    wait(check),
    ({ deferred }) =>
      trigger.pipe(
        Effect.andThen(Deferred.await(deferred)),
        Effect.timeoutOption(`${timeout} millis`),
        Effect.tap((result) => Effect.sync(() => expect(result).toEqual(Option.none()))),
      ),
    ({ fiber }) => Fiber.interrupt(fiber),
  )
}

/**
 * Wait until the watcher is LIVE **and delivering**.
 *
 * Two distinct facts, and the suite needs both: `Watcher.Service.ready` completes when the backend
 * has established the subscriptions (a fact the service owns, replacing the old "is it live?" probe
 * loop), and a single probe write then confirms the host actually DELIVERS events. They are not the
 * same thing — a saturated host (load ~5) accepted subscriptions while delivering no callbacks at
 * all, so a signal-only readiness gate moved the failure into the assertions instead of removing it.
 *
 * The two failure modes stay distinguishable: a readiness timeout means the backend never started; a
 * probe timeout means this host is not delivering, which is an environment condition the assertions
 * cannot fix and this message says so. The module-level `watcherDelivers()` gate runs the same probe
 * once so the suite can skip that environment instead of failing in it.
 */
function ready(directory: string) {
  const file = path.join(directory, `.watcher-${Math.random().toString(36).slice(2)}`)
  return Effect.gen(function* () {
    const watcher = yield* Watcher.Service
    yield* watcher.ready.pipe(
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () => Effect.fail(new Error("file watcher backend never reported readiness")),
      }),
    )
    const fs = yield* FSUtil.Service
    yield* nextUpdate((event) => event.file === file, fs.writeFileString(file, `ready-${Math.random()}`)).pipe(
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () =>
          Effect.fail(
            new Error(
              "file watcher is ready but delivered no probe event in 30s: this host is not delivering " +
                "filesystem events (heavy load starves the native backend)",
            ),
          ),
      }),
      Effect.ensuring(fs.remove(file, { force: true }).pipe(Effect.ignore)),
      Effect.asVoid,
    )
  })
}

describeWatcher("Watcher", () => {
  it.live(
    "publishes root create, update, and delete events",
    () =>
      withTmp(
        (directory) =>
          Effect.gen(function* () {
            const fs = yield* FSUtil.Service
            const file = path.join(directory, "watch.txt")
            yield* ready(directory)
            for (const item of [
              { event: "add" as const, trigger: fs.writeFileString(file, "a") },
              { event: "change" as const, trigger: fs.writeFileString(file, "b") },
              { event: "unlink" as const, trigger: fs.remove(file) },
            ]) {
              expect(
                yield* nextUpdate((event) => event.file === file && event.event === item.event, item.trigger),
              ).toEqual({
                file,
                event: item.event,
              })
            }
          }),
        { git: true },
      ),
    90_000,
  )

  it.live(
    "watches non-git roots",
    () =>
      withTmp((directory) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const file = path.join(directory, "plain.txt")
          yield* ready(directory)
          expect(yield* nextUpdate((event) => event.file === file, fs.writeFileString(file, "plain"))).toEqual({
            file,
            event: "add",
          })
        }),
      ),
    90_000,
  )

  it.live(
    "cleanup stops publishing events",
    () =>
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const fs = yield* FSUtil.Service
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        yield* ready(tmp.path).pipe(provide(tmp.path), Effect.scoped)
        const file = path.join(tmp.path, "after-dispose.txt")
        yield* noUpdate((event) => event.file === file, fs.writeFileString(file, "gone")).pipe(
          Effect.provideService(EventV2.Service, events),
        )
      }).pipe(Effect.provide(Layer.mergeAll(FSUtil.defaultLayer, eventLayer()))),
    90_000,
  )

  it.live(
    "ignores .git/index changes",
    () =>
      withTmp(
        (directory) =>
          Effect.gen(function* () {
            const fs = yield* FSUtil.Service
            const index = path.join(directory, ".git", "index")
            yield* ready(directory)
            yield* noUpdate(
              (event) => event.file === index,
              fs
                .writeFileString(path.join(directory, "tracked.txt"), "a")
                .pipe(Effect.andThen(Effect.promise(() => $`git add .`.cwd(directory).quiet())), Effect.asVoid),
            )
          }),
        { git: true },
      ),
    90_000,
  )

  it.live("publishes .git/HEAD events", () =>
    withTmp(
      (directory) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const head = path.join(directory, ".git", "HEAD")
          const branch = `watch-${Math.random().toString(36).slice(2)}`
          yield* ready(directory)
          yield* Effect.promise(() => $`git branch ${branch}`.cwd(directory).quiet())
          expect(
            yield* nextUpdate((event) => event.file === head, fs.writeFileString(head, `ref: refs/heads/${branch}\n`)),
          ).toEqual({
            file: head,
            event: "change",
          })
        }),
      { git: true },
    ),
    90_000,
  )

  const describeSymlink = process.platform !== "win32" ? describe : describe.skip
  describeSymlink("symlinked .git", () => {
    it.live(
      "publishes .git/HEAD events through a symlinked .git directory",
      () =>
        withTmp(
          (directory) =>
            Effect.gen(function* () {
              const afs = yield* FSUtil.Service
              const actual = path.join(directory, "..", `actual_${path.basename(directory)}`)
              yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(actual, { recursive: true, force: true })))
              yield* ready(directory)
              const head = path.join(directory, ".git", "HEAD")
              const branch = `watch-${Math.random().toString(36).slice(2)}`
              yield* Effect.promise(() => $`git branch ${branch}`.cwd(directory).quiet())
              expect(
                yield* nextUpdate(
                  (event) => event.file === path.join(actual, "HEAD"),
                  afs.writeFileString(head, `ref: refs/heads/${branch}\n`),
                ),
              ).toEqual({ file: path.join(actual, "HEAD"), event: "change" })
            }),
          {
            git: true,
            init: async (directory) => {
              const actual = path.join(directory, "..", `actual_${path.basename(directory)}`)
              await fs.rename(path.join(directory, ".git"), actual)
              await fs.symlink(actual, path.join(directory, ".git"))
            },
          },
        ),
      90_000,
    )
  })
})
