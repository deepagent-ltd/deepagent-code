import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect, Exit } from "effect"
import { NativeWorkProcessSupervisor } from "../../src/installation/work-process-supervisor"
import { NativeInstallation } from "../../src/installation/native-installation"

const binding = {
  workID: "work-original",
  commandID: "command-original",
  recipeHash: "a".repeat(64),
  controlRevision: 2,
}
const nonce = "b".repeat(64)
const containment = "linux-cgroup2-single-payload-v1"
const limits = { stdoutBytes: 8, stderrBytes: 8 }
const ready = {
  kind: "ready",
  version: 2,
  nonce,
  work_id: binding.workID,
  command_id: binding.commandID,
  recipe_hash: binding.recipeHash,
  control_revision: binding.controlRevision,
  root_pid: 42,
  containment,
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex")
const stream = (text: string) => ({
  sha256: digest(text),
  captured_sha256: digest(text),
  bytes: Buffer.byteLength(text),
  captured_bytes: Buffer.byteLength(text),
  eof: true as const,
})
const stopped = {
  kind: "stopped",
  version: 2,
  nonce,
  root_exit: true,
  tree_empty: true,
  stdout: stream("actual"),
  stderr: stream(""),
  cancelled: false,
  exit_code: 0,
  elapsed_ms: 10,
  watchdog: {
    poll_ms: 10,
    cpu_micros: 123,
    observed_threads_max: null,
    observed_output_bytes_max: null,
    triggered: [],
  },
} as const
function frame(value: unknown) {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

test("private protocol checks original binding and both EOF/captured bytes; projection grants no Ready", () => {
  const observe = NativeWorkProcessSupervisor.projection(binding, nonce, containment, limits)
  const bytes = Buffer.concat([
    frame(ready),
    frame({ kind: "data", version: 2, nonce, stream: "stdout", hex: Buffer.from("actual").toString("hex") }),
    frame(stopped),
  ])
  expect(observe.feed(bytes.subarray(0, 3))).toHaveLength(0)
  expect(observe.feed(bytes.subarray(3))).toHaveLength(3)
  expect(observe.finish()).toEqual(stopped)
  expect(NativeWorkProcessSupervisor.describeReady(Object.create(null))).toBeUndefined()
  expect(
    NativeWorkProcessSupervisor.describeReady({ ...ready } as unknown as NativeWorkProcessSupervisor.Ready),
  ).toBeUndefined()
})

test("no stop proof from root exit alone, stale/copy/extra binding, false tree/EOF, or mismatched captured stream", () => {
  const partial = NativeWorkProcessSupervisor.projection(binding, nonce, containment, limits)
  partial.feed(frame(ready))
  expect(() => partial.finish()).toThrow()
  for (const changed of [
    { ...ready, nonce: "c".repeat(64) },
    { ...ready, control_revision: 1 },
    { ...ready, actor: true },
  ]) {
    const observe = NativeWorkProcessSupervisor.projection(binding, nonce, containment, limits)
    expect(() => observe.feed(frame(changed))).toThrow()
  }
  for (const changed of [
    { ...stopped, tree_empty: false },
    { ...stopped, stderr: { ...stream(""), eof: false } },
    stopped,
  ]) {
    const observe = NativeWorkProcessSupervisor.projection(binding, nonce, containment, limits)
    observe.feed(frame(ready))
    expect(() => observe.feed(frame(changed))).toThrow()
  }
  const oversized = NativeWorkProcessSupervisor.projection(binding, nonce, containment, limits)
  const header = Buffer.alloc(4)
  header.writeUInt32BE(65_537)
  expect(() => oversized.feed(header)).toThrow()
})

test("factory never turns a source invocation or serialized installation into signed execution", async () => {
  const source = await Effect.runPromiseExit(NativeInstallation.current())
  expect(Exit.isFailure(source)).toBe(true)
  const unavailable = await Effect.runPromiseExit(Effect.scoped(NativeWorkProcessSupervisor.make(Object.create(null))))
  expect(Exit.isFailure(unavailable)).toBe(true)
})
