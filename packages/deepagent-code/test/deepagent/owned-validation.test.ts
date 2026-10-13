import { afterAll, beforeAll, describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OwnedValidation } from "../../src/deepagent/owned-validation"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const profile = "darwin-single-process-v1" as const
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-owned-validation-tests-"))
const executable = path.join(directory, "process-fixture")
const command = (args: string[]) => ({
  id: "owned-fixture",
  source: "user" as const,
  transport: "argv" as const,
  executable,
  args,
  display: "private synthetic process",
})
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const marker = (name: string) => path.join(directory, name)
const exists = (file: string) => Effect.promise(() => Bun.file(file).exists())
const pid = (file: string) =>
  pollWithTimeout(
    Effect.promise(async () => {
      if (!(await Bun.file(file).exists())) return undefined
      const value = Number(await Bun.file(file).text())
      return Number.isInteger(value) && value > 0 ? value : undefined
    }),
    "native process did not publish readiness",
  )
function gone(value: number) {
  try {
    process.kill(value, 0)
    return false
  } catch (error) {
    return !!error && typeof error === "object" && "code" in error && error.code === "ESRCH"
  }
}

beforeAll(async () => {
  if (process.platform !== "darwin") return
  const compiled = Bun.spawn(
    ["/usr/bin/clang", new URL("./fixture/owned-validation-process.c", import.meta.url).pathname, "-o", executable],
    { stdout: "pipe", stderr: "pipe" },
  )
  const error = await new Response(compiled.stderr).text()
  expect(await compiled.exited, error).toBe(0)
})
afterAll(() => fs.rm(directory, { recursive: true, force: true }))

describe.skipIf(process.platform !== "darwin")("OwnedValidation native macOS evidence", () => {
  it.live("runs a real bun test through the non-fork profile; only native handles expose receipts", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        Bun.write(
          marker("sample.test.ts"),
          'import { expect, test } from "bun:test"; test("actual test", () => expect(3 + 4).toBe(7))',
        ),
      )
      const handle = yield* OwnedValidation.prepare({
        cwd: directory,
        profile,
        command: {
          id: "actual-bun",
          source: "package_script",
          transport: "argv",
          executable: process.execPath,
          args: ["test", marker("sample.test.ts")],
          display: "bun test",
        },
      })
      const snap = OwnedValidation.snapshot(handle)!
      expect(Object.isFrozen(snap)).toBe(true)
      expect(snap).toMatchObject({ profile, stdoutLimit: 1_048_576, stderrLimit: 1_048_576, timeoutMs: 120_000 })
      expect(snap.commandHash).toHaveLength(64)
      expect(snap.cwdHash).toBe(digest(yield* Effect.promise(() => fs.realpath(directory))))
      expect(OwnedValidation.inspect(handle)).toBeUndefined()
      const receipt = yield* OwnedValidation.run(handle)
      const view = OwnedValidation.inspect(receipt)!
      expect(view).toMatchObject({
        state: "exited",
        outcome: "passed",
        stopProof: "not_requested",
        exitCode: 0,
        containment: "single-process",
        reason: "command_exit",
      })
      expect(view.stderr.text + view.stdout.text).toContain("1 pass")
      expect(view.stdout.complete && view.stderr.complete).toBe(true)
      expect(OwnedValidation.inspect(handle)).toBe(view)
      expect(OwnedValidation.inspect({ ...receipt })).toBeUndefined()
      expect(OwnedValidation.inspect(JSON.parse(JSON.stringify(view)))).toBeUndefined()
      const again = yield* OwnedValidation.run(handle).pipe(Effect.exit)
      expect(Exit.isFailure(again) && Cause.squash(again.cause)).toMatchObject({ code: "HANDLE_UNAVAILABLE" })
    }),
  )

  it.live("actual sandbox refuses both fork and posix_spawn", () =>
    Effect.gen(function* () {
      const handle = yield* OwnedValidation.prepare({ cwd: directory, command: command(["fork-check"]), profile })
      const view = OwnedValidation.inspect(yield* OwnedValidation.run(handle))!
      expect(view.outcome).toBe("passed")
      expect(view.stdout.text).toBe("fork=-1 errno=1 spawn=1\n")
      expect(view.stopProof).toBe("not_requested")
    }),
  )

  it.live("nonzero command exit is a business failure without inventing cancellation", () =>
    Effect.gen(function* () {
      const handle = yield* OwnedValidation.prepare({ cwd: directory, command: command(["failed"]), profile })
      expect(OwnedValidation.inspect(yield* OwnedValidation.run(handle))).toMatchObject({
        state: "exited",
        outcome: "failed",
        exitCode: 7,
        signal: null,
        stopProof: "not_requested",
      })
    }),
  )

  it.live("hashes all output while retaining at most one MiB per stream", () =>
    Effect.gen(function* () {
      const handle = yield* OwnedValidation.prepare({ cwd: directory, command: command(["output"]), profile })
      const view = OwnedValidation.inspect(yield* OwnedValidation.run(handle))!
      expect(view.outcome).toBe("passed")
      for (const [output, value] of [
        [view.stdout, "x"],
        [view.stderr, "y"],
      ] as const) {
        expect(output).toMatchObject({ bytes: 130 * 8192, capturedBytes: 1_048_576, truncated: true, complete: true })
        expect(output.text).toBe(value.repeat(1_048_576))
        expect(output.hash).toBe(digest(Buffer.alloc(130 * 8192, value)))
      }
    }),
  )

  it.live("invalid UTF-8 cannot expand the bounded display output", () =>
    Effect.gen(function* () {
      const handle = yield* OwnedValidation.prepare({ cwd: directory, command: command(["binary"]), profile })
      const view = OwnedValidation.inspect(yield* OwnedValidation.run(handle))!
      expect(view.stdout).toMatchObject({ bytes: 1_048_576, capturedBytes: 1_048_576, truncated: true, complete: true })
      expect(Buffer.byteLength(view.stdout.text)).toBeLessThanOrEqual(1_048_576)
      expect(view.stdout.hash).toBe(digest(Buffer.alloc(1_048_576, 255)))
      expect(view.outcome).toBe("passed")
    }),
  )

  it.live("the literal native profile denies an actual loopback connection", () =>
    Effect.gen(function* () {
      const requests: string[] = []
      const sink = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
          requests.push(request.url)
          return new Response("ok")
        },
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => sink.stop(true)))
      const handle = yield* OwnedValidation.prepare({
        cwd: directory,
        command: command(["network", String(sink.port)]),
        profile,
      })
      const view = OwnedValidation.inspect(yield* OwnedValidation.run(handle))!
      expect(view.outcome).toBe("passed")
      expect(view.stdout.text).toBe("connect=-1 errno=1\n")
      expect(requests).toHaveLength(0)
    }),
  )

  it.live("timeout TERM then KILL waits exact native exit before a later command starts", () =>
    Effect.gen(function* () {
      const file = marker("timeout.pid")
      const handle = yield* OwnedValidation.prepare({
        cwd: directory,
        command: command(["hold", file]),
        profile,
        timeoutMs: 300,
      })
      const running = yield* OwnedValidation.run(handle).pipe(Effect.forkScoped)
      const ownedPID = yield* pid(file)
      const receipt = yield* Fiber.join(running)
      expect(OwnedValidation.inspect(receipt)).toMatchObject({
        state: "stop_confirmed",
        outcome: "cancelled",
        stopProof: "owned_process_exit",
        signal: "SIGKILL",
        reason: "timeout",
      })
      expect(gone(ownedPID)).toBe(true)
      const previous = yield* Effect.promise(() => fs.stat(`${file}.heartbeat`))
      const next = yield* OwnedValidation.prepare({
        cwd: directory,
        command: command(["marker", marker("after-timeout")]),
        profile,
      })
      expect(OwnedValidation.inspect(yield* OwnedValidation.run(next))?.outcome).toBe("passed")
      expect((yield* Effect.promise(() => fs.stat(`${file}.heartbeat`))).size).toBe(previous.size)
      expect(yield* exists(marker("after-timeout"))).toBe(true)
    }),
  )

  it.live("fiber cancellation is preserved after TERM/KILL/wait and cannot run the continuation", () =>
    Effect.gen(function* () {
      const file = marker("interrupt.pid")
      const handle = yield* OwnedValidation.prepare({ cwd: directory, command: command(["hold", file]), profile })
      const running = yield* OwnedValidation.run(handle).pipe(
        Effect.andThen(Effect.promise(() => Bun.write(marker("bad-continuation"), "ran"))),
        Effect.forkScoped,
      )
      const ownedPID = yield* pid(file)
      yield* Fiber.interrupt(running)
      const result = yield* Fiber.await(running)
      expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true)
      expect(OwnedValidation.inspect(handle)).toMatchObject({
        state: "stop_confirmed",
        outcome: "cancelled",
        stopProof: "owned_process_exit",
        reason: "cancelled",
        signal: "SIGKILL",
      })
      expect(gone(ownedPID)).toBe(true)
      expect(yield* exists(marker("bad-continuation"))).toBe(false)
    }),
  )

  it.live("scope closure awaits its exact process; a closed preparation cannot dispatch", () =>
    Effect.gen(function* () {
      const owner = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void))
      const file = marker("scope.pid")
      const handle = yield* OwnedValidation.prepare({ cwd: directory, command: command(["hold", file]), profile }).pipe(
        Effect.provideService(Scope.Scope, owner),
      )
      const running = yield* OwnedValidation.run(handle).pipe(Effect.forkScoped)
      const ownedPID = yield* pid(file)
      yield* Scope.close(owner, Exit.void)
      expect(gone(ownedPID)).toBe(true)
      expect(OwnedValidation.inspect(handle)).toMatchObject({
        state: "stop_confirmed",
        stopProof: "owned_process_exit",
      })
      yield* Fiber.await(running)
      const closed = yield* Scope.make()
      const idle = yield* OwnedValidation.prepare({
        cwd: directory,
        command: command(["marker", marker("closed-no-spawn")]),
        profile,
      }).pipe(Effect.provideService(Scope.Scope, closed))
      yield* Scope.close(closed, Exit.void)
      expect(Exit.isFailure(yield* OwnedValidation.run(idle).pipe(Effect.exit))).toBe(true)
      expect(yield* exists(marker("closed-no-spawn"))).toBe(false)
    }),
  )

  it.live("journal failure and final control refusal preserve their typed causes without dispatch", () =>
    Effect.gen(function* () {
      const first = yield* OwnedValidation.prepare({
        cwd: directory,
        command: command(["marker", marker("prepare-refused")]),
        profile,
      })
      const failed = yield* OwnedValidation.run(first, { onPrepared: () => Effect.fail("JOURNAL_FAILED") }).pipe(
        Effect.exit,
      )
      expect(Exit.isFailure(failed) && Cause.pretty(failed.cause)).toContain("JOURNAL_FAILED")
      expect(OwnedValidation.inspect(first)).toBeUndefined()
      const second = yield* OwnedValidation.prepare({
        cwd: directory,
        command: command(["marker", marker("dispatch-refused")]),
        profile,
      })
      const result = yield* OwnedValidation.run(second, {
        onDispatch: () => Effect.fail("CURRENT_CONTROL_REVOKED"),
      }).pipe(Effect.exit)
      expect(Exit.isFailure(result) && Cause.pretty(result.cause)).toContain("CURRENT_CONTROL_REVOKED")
      expect(OwnedValidation.inspect(second)).toMatchObject({
        state: "cancelled_before_dispatch",
        startedAt: null,
        stopProof: "not_started",
      })
      expect(yield* exists(marker("prepare-refused"))).toBe(false)
      expect(yield* exists(marker("dispatch-refused"))).toBe(false)
    }),
  )

  it.live("interrupting the last dispatch gate records not-started and preserves interruption", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const handle = yield* OwnedValidation.prepare({
        cwd: directory,
        command: command(["marker", marker("gate-no-spawn")]),
        profile,
      })
      const running = yield* OwnedValidation.run(handle, {
        onDispatch: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(running)
      const result = yield* Fiber.await(running)
      expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true)
      expect(OwnedValidation.inspect(handle)).toMatchObject({
        state: "cancelled_before_dispatch",
        stopProof: "not_started",
        startedAt: null,
      })
      expect(yield* exists(marker("gate-no-spawn"))).toBe(false)
    }),
  )

  it.live("scope closure during a pending final gate prevents a late dispatch", () =>
    Effect.gen(function* () {
      const owner = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void))
      const entered = yield* Deferred.make<void>()
      const released = yield* Deferred.make<void>()
      const handle = yield* OwnedValidation.prepare({
        cwd: directory,
        command: command(["marker", marker("late-gate-no-spawn")]),
        profile,
      }).pipe(Effect.provideService(Scope.Scope, owner))
      const running = yield* OwnedValidation.run(handle, {
        onDispatch: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(released))),
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      yield* Scope.close(owner, Exit.void)
      yield* Deferred.succeed(released, undefined)
      const result = yield* Fiber.await(running)
      expect(Exit.isFailure(result) && Cause.squash(result.cause)).toMatchObject({ code: "HANDLE_UNAVAILABLE" })
      expect(OwnedValidation.inspect(handle)).toMatchObject({
        state: "cancelled_before_dispatch",
        stopProof: "not_started",
        startedAt: null,
      })
      expect(yield* exists(marker("late-gate-no-spawn"))).toBe(false)
    }),
  )

  it.live("a vanished captured executable yields a typed failure, never a successful stop receipt", () =>
    Effect.gen(function* () {
      const vanished = marker("vanished-command")
      yield* Effect.promise(() => fs.copyFile(executable, vanished))
      const handle = yield* OwnedValidation.prepare({
        cwd: directory,
        command: { ...command(["failed"]), executable: vanished },
        profile: "posix-process-group-v1",
      })
      const result = yield* OwnedValidation.run(handle, {
        onDispatch: () => Effect.promise(() => fs.unlink(vanished)),
      }).pipe(Effect.exit)
      expect(Exit.isFailure(result) && Cause.squash(result.cause)).toMatchObject({ code: "SPAWN_FAILED" })
      expect(OwnedValidation.inspect(handle)).toMatchObject({
        state: "unknown",
        outcome: null,
        stopProof: "unconfirmed",
        reason: "spawn_failed",
      })
    }),
  )

  it.live("parent credentials and runtime injection variables never enter a validation process", () =>
    Effect.gen(function* () {
      const keys = [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "IM_API_KEY",
        "DEEPAGENT_CODE_SERVER_PASSWORD",
        "HTTPS_PROXY",
        "DYLD_INSERT_LIBRARIES",
        "NODE_OPTIONS",
        "BUN_OPTIONS",
        "MCP_OAUTH_SECRET",
      ]
      const prior = keys.map((key) => [key, process.env[key]] as const)
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          keys.forEach((key) => {
            process.env[key] = "private-synthetic-secret"
          })
        }),
        () =>
          Effect.sync(() =>
            prior.forEach(([key, value]) => {
              if (value === undefined) {
                delete process.env[key]
                return
              }
              process.env[key] = value
            }),
          ),
      )
      const owner = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void))
      const handle = yield* OwnedValidation.prepare({
        cwd: directory,
        command: command(["environment"]),
        profile,
      }).pipe(Effect.provideService(Scope.Scope, owner))
      const view = OwnedValidation.inspect(yield* OwnedValidation.run(handle))!
      expect(view.outcome).toBe("passed")
      keys.forEach((key) => expect(view.stdout.text).toContain(`${key}=0\n`))
      const home = view.stdout.text
        .split("\n")
        .find((line) => line.startsWith("HOME="))
        ?.slice(5)
      const temp = view.stdout.text
        .split("\n")
        .find((line) => line.startsWith("TMPDIR="))
        ?.slice(7)
      expect(home).toBeDefined()
      expect(home).not.toBe(process.env.HOME)
      expect(temp).not.toBe(process.env.TMPDIR)
      const stat = yield* Effect.promise(() => fs.stat(home!))
      expect(stat.mode & 0o777).toBe(0o700)
      expect(stat.uid).toBe(process.getuid!())
      expect((yield* Effect.promise(() => fs.stat(temp!))).mode & 0o777).toBe(0o700)
      yield* Scope.close(owner, Exit.void)
      const removed = yield* Effect.promise(() =>
        fs.lstat(home!).then(
          () => false,
          (error: unknown) => {
            if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return true
            throw error
          },
        ),
      )
      expect(removed).toBe(true)
    }),
  )

  it.live("a zero-exit POSIX parent with a live setsid descendant cannot sign tests_pass", () =>
    Effect.gen(function* () {
      const file = marker("normal-exit-escaped.pid")
      const handle = yield* OwnedValidation.prepare({
        cwd: directory,
        command: command(["escape-exit", file]),
        profile: "posix-process-group-v1",
      })
      const receipt = yield* OwnedValidation.run(handle)
      const escapedPID = yield* pid(file)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            process.kill(escapedPID, "SIGKILL")
          } catch {
            /* Owned synthetic child exited. */
          }
        }),
      )
      const initial = (yield* Effect.promise(() => fs.stat(`${file}.heartbeat`))).size
      yield* pollWithTimeout(
        Effect.promise(async () => ((await fs.stat(`${file}.heartbeat`)).size > initial ? true : undefined)),
        "normal-exit descendant did not stay live",
      )
      expect(OwnedValidation.inspect(receipt)).toMatchObject({
        state: "unknown",
        outcome: null,
        exitCode: 0,
        containment: "posix-group",
        stopProof: "unconfirmed",
      })
    }),
  )

  it.live("a replaced working-directory identity is refused after the final gate before spawn", () =>
    Effect.gen(function* () {
      const cwd = marker("replaceable-cwd")
      yield* Effect.promise(() => fs.mkdir(cwd))
      const handle = yield* OwnedValidation.prepare({
        cwd,
        command: command(["marker", path.join(cwd, "must-not-exist")]),
        profile,
      })
      const result = yield* OwnedValidation.run(handle, {
        onDispatch: () =>
          Effect.promise(async () => {
            await fs.rename(cwd, `${cwd}-original`)
            await fs.mkdir(cwd)
          }),
      }).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(OwnedValidation.inspect(handle)).toMatchObject({
        state: "cancelled_before_dispatch",
        stopProof: "not_started",
      })
      expect(yield* exists(path.join(cwd, "must-not-exist"))).toBe(false)
    }),
  )

  it.live("ordinary process-group cancellation with a real setsid escape remains unknown", () =>
    Effect.gen(function* () {
      const file = marker("escaped.pid")
      const handle = yield* OwnedValidation.prepare({
        cwd: directory,
        command: command(["escape", file]),
        profile: "posix-process-group-v1",
      })
      const running = yield* OwnedValidation.run(handle).pipe(Effect.forkScoped)
      const escapedPID = yield* pid(file)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            process.kill(escapedPID, "SIGKILL")
          } catch {
            /* Synthetic owned child already exited. */
          }
        }),
      )
      yield* Fiber.interrupt(running)
      expect(OwnedValidation.inspect(handle)).toMatchObject({
        state: "unknown",
        outcome: null,
        containment: "posix-group",
        stopProof: "unconfirmed",
        reason: "cancelled",
      })
      expect(gone(escapedPID)).toBe(false)
      const initial = (yield* Effect.promise(() => fs.stat(`${file}.heartbeat`))).size
      yield* pollWithTimeout(
        Effect.promise(async () => ((await fs.stat(`${file}.heartbeat`)).size > initial ? true : undefined)),
        "escaped process was not actually live",
      )
    }),
  )

  it.live("captured command cannot be changed after prepare and receipt copies cannot authorize replay", () =>
    Effect.gen(function* () {
      const args = ["marker", marker("captured-original")]
      const handle = yield* OwnedValidation.prepare({ cwd: directory, command: command(args), profile })
      args[1] = marker("captured-mutated")
      const receipt = yield* OwnedValidation.run(handle)
      expect(yield* exists(marker("captured-original"))).toBe(true)
      expect(yield* exists(marker("captured-mutated"))).toBe(false)
      expect(Exit.isFailure(yield* OwnedValidation.run({ ...handle }).pipe(Effect.exit))).toBe(true)
      expect(OwnedValidation.inspect({ ...receipt })).toBeUndefined()
    }),
  )

  it.live("a cold process cannot turn a persisted receipt view into a new execution handle", () =>
    Effect.gen(function* () {
      const handle = yield* OwnedValidation.prepare({
        cwd: directory,
        command: command(["marker", marker("cold-original")]),
        profile,
      })
      const view = OwnedValidation.inspect(yield* OwnedValidation.run(handle))!
      yield* Effect.promise(() => Bun.write(marker("persisted.json"), JSON.stringify(view)))
      const before = yield* Effect.promise(() => fs.stat(marker("cold-original")))
      const child = Bun.spawn(
        [
          process.execPath,
          new URL("./fixture/owned-validation-cold.ts", import.meta.url).pathname,
          marker("persisted.json"),
        ],
        { stdout: "pipe", stderr: "pipe" },
      )
      const output = yield* Effect.promise(() => new Response(child.stdout).text())
      expect(yield* Effect.promise(() => child.exited)).toBe(0)
      expect(JSON.parse(output)).toEqual({ inspectMissing: true, unavailable: true })
      expect((yield* Effect.promise(() => fs.stat(marker("cold-original")))).mtimeMs).toBe(before.mtimeMs)
    }),
  )

  it.live("preparation capacity is bounded and scope close releases unused handles", () =>
    Effect.gen(function* () {
      const owner = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void))
      const custody = OwnedValidation.inspectCustody()
      for (let index = 0; index < custody.limit - custody.live - custody.quarantine; index++) {
        yield* OwnedValidation.prepare({ cwd: directory, command: command(["failed"]), profile }).pipe(
          Effect.provideService(Scope.Scope, owner),
        )
      }
      const full = yield* OwnedValidation.prepare({ cwd: directory, command: command(["failed"]), profile }).pipe(
        Effect.exit,
      )
      expect(Exit.isFailure(full) && Cause.squash(full.cause)).toMatchObject({ code: "CAPACITY" })
      yield* Scope.close(owner, Exit.void)
      const available = yield* OwnedValidation.prepare({ cwd: directory, command: command(["failed"]), profile })
      expect(OwnedValidation.snapshot(available)).toBeDefined()
    }),
  )

  it.live("rejects timeout and command resource overages before a handle can run", () =>
    Effect.gen(function* () {
      for (const timeoutMs of [0, -1, 120_001, Number.NaN, Number.POSITIVE_INFINITY]) {
        const result = yield* OwnedValidation.prepare({
          cwd: directory,
          command: command(["marker", marker("invalid")]),
          profile,
          timeoutMs,
        }).pipe(Effect.exit)
        expect(Exit.isFailure(result) && Cause.squash(result.cause)).toMatchObject({ code: "INVALID_INPUT" })
      }
      const tooLarge = yield* OwnedValidation.prepare({ cwd: directory, command: "x".repeat(65_537), profile }).pipe(
        Effect.exit,
      )
      expect(Exit.isFailure(tooLarge) && Cause.squash(tooLarge.cause)).toMatchObject({ code: "INVALID_INPUT" })
      expect(yield* exists(marker("invalid"))).toBe(false)
    }),
  )
})
