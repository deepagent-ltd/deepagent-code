import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { Effect, Exit, Schema } from "effect"
import { EventValidationSchema } from "@deepagent-code/core/deepagent/event-validation.schema"
import { EventValidationLinux } from "../../src/installation/event-validation-linux"
import { EventValidationPlatform } from "../../src/installation/event-validation-platform"
import { EventValidationMac } from "../../src/installation/event-validation-mac"
import { NativeWorkProcessSupervisor } from "../../src/installation/work-process-supervisor"
import { WorkCommandRuntime } from "../../src/installation/work-command-runtime"
import { EventValidationStoreFixture } from "../../../core/test/fixture/event-validation-store"

const linux = Schema.decodeUnknownSync(EventValidationSchema.LinuxRecipe)({
  ...EventValidationStoreFixture.configuration().recipe,
  schemaVersion: "work-command-recipe.v2",
  executable: { assetPath: "packages/work-file-helper/bin/linux-x64/bun-command-runtime", sha256: "c".repeat(64),
    bytes: 10, platform: "linux-x64", identity: { kind: "posix", device: "1", inode: "4" } },
  sandbox: { id: "linux-cgroup2-single-payload-v1", revision: 1, network: "deny", filesystem: "explicit_snapshot_closure",
    payloadProcesses: 1, payloadThreadsMax: 64, supervisorProcessesMax: 2, openFiles: 64,
    stopProof: "root_exit_stream_eof_tree_empty", threadsEnforcement: "cgroup_pids", tasksMax: 66,
    cpu: { quotaMicros: 100000, periodMicros: 100000, totalWatchdogMicros: 60000000, pollMs: 20 },
    memory: { maxBytes: 268435456, swapMaxBytes: 0 } },
})
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

test("EV platform selection describes only the matching Linux target and preserves the Mac request", () => {
  const mac = EventValidationStoreFixture.configuration().recipe
  expect(EventValidationPlatform.request(mac)).toEqual(EventValidationMac.request(mac))
  expect(EventValidationPlatform.supports(mac)).toBe(EventValidationMac.supports(mac))
  expect(EventValidationPlatform.supports(linux)).toBe(process.platform === "linux" && process.arch === "x64")
  expect(EventValidationMac.supports(linux)).toBe(false)
  expect(() => EventValidationMac.request(linux)).toThrow()
  expect(Schema.decodeUnknownSync(EventValidationSchema.LinuxRecipeRequest)(EventValidationPlatform.request(linux))).toEqual({
    ...linux, executable: "installed-bun-v2", target: "linux-x64",
  })
})

async function files(body: (workspace: Awaited<ReturnType<typeof WorkCommandRuntime.createWorkspace>>,
  source: string, bytes: Buffer, content: EventValidationSchema.Content) => Promise<void>) {
  const directory = await fs.realpath(await fs.mkdtemp("/tmp/dac-ev-linux-copy-"))
  const source = path.join(directory, "project")
  const data = path.join(directory, "data")
  await fs.mkdir(source, { mode: 0o700 })
  await fs.mkdir(data, { mode: 0o700 })
  const bytes = Buffer.from([0xff, 0, 0x80, 0xfe, 65])
  await fs.writeFile(path.join(source, "input.ts"), bytes, { mode: 0o600 })
  const stat = await fs.lstat(path.join(source, "input.ts"), { bigint: true })
  const workspace = await WorkCommandRuntime.createWorkspace(data, `cmd_${randomUUID().replaceAll("-", "")}`, source)
  try {
    await fs.writeFile(path.join(workspace.directory, "input.ts"), bytes, { mode: 0o600 })
    await body(workspace, source, bytes, { contentHash: "e".repeat(64), observedAt: Date.now(),
      files: [{ relative: "input.ts", identity: { kind: "posix", device: stat.dev.toString(), inode: stat.ino.toString() },
        bytes: bytes.length, sha256: digest(bytes), missing: false }] })
  } finally {
    await workspace.file.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
}

test("Linux snapshot mounts bind the actual copied inode, full binary bytes and empty input", () => files(async (workspace, source, bytes, content) => {
  const configuration = { ...EventValidationStoreFixture.configuration(), recipe: linux }
  const copied = await EventValidationLinux.copiedInputs(workspace, configuration, content)
  const stat = await fs.lstat(path.join(workspace.directory, "input.ts"), { bigint: true })
  expect(copied).toEqual([{ relative: "input.ts", identity: { kind: "posix", device: stat.dev.toString(), inode: stat.ino.toString() },
    bytes: bytes.length, sha256: digest(bytes) }])
  expect(copied[0]!.identity).not.toEqual(content.files[0]!.identity)
  expect(await fs.readFile(path.join(source, "input.ts"))).toEqual(Buffer.from(bytes))
  await fs.writeFile(path.join(workspace.directory, "input.ts"), Buffer.alloc(0), { mode: 0o600 })
  expect((await EventValidationLinux.copiedInputs(workspace, configuration, {
    ...content, files: [{ ...content.files[0]!, bytes: 0, sha256: digest(Buffer.alloc(0)) }],
  }))[0]).toMatchObject({ bytes: 0, sha256: digest(Buffer.alloc(0)) })
}))

test("Linux snapshot refuses missing, oversized, changed, symlinked or replaced workspace inputs", () => files(async (workspace, source, bytes, content) => {
  const configuration = { ...EventValidationStoreFixture.configuration(), recipe: linux }
  for (const file of [
    { ...content.files[0]!, missing: true },
    { ...content.files[0]!, bytes: 16777217 },
    { ...content.files[0]!, sha256: "a".repeat(64) },
  ]) await expect(EventValidationLinux.copiedInputs(workspace, configuration, { ...content, files: [file] })).rejects.toBeDefined()
  await fs.writeFile(path.join(workspace.directory, "input.ts"), Buffer.from("different"), { mode: 0o600 })
  await expect(EventValidationLinux.copiedInputs(workspace, configuration, content)).rejects.toBeDefined()
  await fs.unlink(path.join(workspace.directory, "input.ts"))
  await fs.symlink(path.join(source, "input.ts"), path.join(workspace.directory, "input.ts"))
  await expect(EventValidationLinux.copiedInputs(workspace, configuration, content)).rejects.toBeDefined()
  await fs.unlink(path.join(workspace.directory, "input.ts"))
  await fs.writeFile(path.join(workspace.directory, "input.ts"), bytes, { mode: 0o600 })
  await fs.rename(workspace.directory, `${workspace.directory}-held`)
  await fs.mkdir(workspace.directory, { mode: 0o700 })
  await fs.writeFile(path.join(workspace.directory, "input.ts"), bytes, { mode: 0o600 })
  await expect(EventValidationLinux.copiedInputs(workspace, configuration, content)).rejects.toBeDefined()
  expect(await fs.readFile(path.join(source, "input.ts"))).toEqual(Buffer.from(bytes))
}))

test("serialized supervision or installation cannot authorize Linux Ready or publish a stop proof", async () => {
  expect(NativeWorkProcessSupervisor.describeReady(Object.create(null))).toBeUndefined()
  const fake = { version: 2, target: "linux-x64", nonce: "a".repeat(64), rootPID: 42, rootExit: true,
    treeEmpty: true, stdoutEOF: true, stderrEOF: true }
  expect(NativeWorkProcessSupervisor.describeReady(fake as unknown as NativeWorkProcessSupervisor.Ready)).toBeUndefined()
  expect(Exit.isFailure(await Effect.runPromiseExit(Effect.scoped(NativeWorkProcessSupervisor.make(Object.create(null)))))).toBe(true)
})

test.skipIf(process.platform === "linux")("a non-Linux process cannot open the fixed Linux helper channel", async () => {
  await expect(EventValidationLinux.openHelper(process.execPath, "a".repeat(64))).rejects.toBeDefined()
})
