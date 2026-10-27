import { expect, test } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { indexWorkspace } from "../../src/code-intelligence/typescript-workspace-adapter"
import { scan } from "../../src/location-index/manifest"
import { TypeScriptIndex } from "../../src/location-index/typescript-index"
import { tmpdir } from "../fixture/fixture"

test("actual semantic worker preserves the complete synchronous adapter output", async () => {
  await using tmp = await tmpdir()
  await Bun.write(
    path.join(tmp.path, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        baseUrl: ".",
        paths: { "@source/*": ["src/*"] },
      },
    }),
  )
  await Bun.write(path.join(tmp.path, "src/alpha.ts"), "export function alpha(value: number) { return value + 1 }\n")
  await Bun.write(
    path.join(tmp.path, "src/beta.ts"),
    'import {alpha} from "@source/alpha"\nexport const beta = () => alpha(41)\n',
  )
  await Bun.write(path.join(tmp.path, "README.md"), "# Physical document\n")
  const input = { root: tmp.path, files: (await scan({ root: tmp.path })).files }
  const expected = indexWorkspace(input)
  expect(expected.edges.some((edge) => edge.relation === "calls")).toBe(true)
  expect(await Effect.runPromise(TypeScriptIndex.build(input))).toEqual(expected)
  expect(TypeScriptIndex.activity()).toEqual({ active: 0 })
})

test("semantic compilation leaves the Host timer responsive across input and result transfer", async () => {
  await using tmp = await tmpdir()
  const input = await workload(tmp.path)
  const observations: number[] = []
  const started = performance.now()
  const timer = setInterval(() => observations.push(performance.now()), 10)
  try {
    const result = await Effect.runPromise(TypeScriptIndex.build(input))
    const finished = performance.now()
    const times = [started, ...observations, finished]
    expect(result.files).toHaveLength(input.files.length)
    expect(observations.length).toBeGreaterThan(3)
    expect(Math.max(...times.slice(1).map((time, index) => time - times[index]))).toBeLessThan(500)
    expect(TypeScriptIndex.activity()).toEqual({ active: 0 })
  } finally {
    clearInterval(timer)
  }
})

test("interrupting an actual worker and its queued peer retains the shared capacity until real exit", async () => {
  await using tmp = await tmpdir()
  const input = await workload(tmp.path)
  const first = Effect.runFork(TypeScriptIndex.build(input))
  const until = performance.now() + 5_000
  while (TypeScriptIndex.activity().active === 0 && performance.now() < until) await Bun.sleep(1)
  expect(TypeScriptIndex.activity()).toEqual({ active: 1 })
  const queued = Effect.runFork(TypeScriptIndex.build(input))
  await Effect.runPromise(Fiber.interrupt(queued))
  expect(TypeScriptIndex.activity()).toEqual({ active: 1 })
  await Effect.runPromise(Fiber.interrupt(first))
  expect(TypeScriptIndex.activity()).toEqual({ active: 0 })
  const result = await Effect.runPromise(TypeScriptIndex.build(input))
  expect(result.files).toHaveLength(input.files.length)
  expect(TypeScriptIndex.activity()).toEqual({ active: 0 })
})

test("actual worker failure releases the compiler slot only after exit and permits a new independent build", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "source.ts"), "export const original = 1\n")
  const input = { root: tmp.path, files: (await scan({ root: tmp.path })).files }
  const invalid = { ...input, files: input.files.map((file) => ({ ...file, content: 42 as unknown as string })) }
  expect(Exit.isFailure(await Effect.runPromise(TypeScriptIndex.build(invalid).pipe(Effect.exit)))).toBe(true)
  expect(TypeScriptIndex.activity()).toEqual({ active: 0 })
  expect(await Effect.runPromise(TypeScriptIndex.build(input))).toEqual(indexWorkspace(input))
  expect(TypeScriptIndex.activity()).toEqual({ active: 0 })
})

test("actual Node bundle and Bun compiled binary resolve their fixed semantic worker assets", async () => {
  // Share the original 30s test budget, reserving 5s for child termination and joining.
  const deadline = performance.now() + 25_000
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, "workspace")
  await mkdir(root)
  await Bun.write(
    path.join(root, "source.ts"),
    "export function packaged(value: number) { return value + 1 }\nexport const caller = () => packaged(1)\n",
  )
  const input = { root, files: (await scan({ root })).files }
  const expected = indexWorkspace(input)
  const request = path.join(tmp.path, "input.json")
  await writeFile(request, JSON.stringify(input))
  const entry = path.join(import.meta.dir, "fixture/typescript-index-packaged.ts")
  const worker = path.resolve(import.meta.dir, "../../src/location-index/typescript-index.worker.ts")
  const node = path.join(tmp.path, "node")
  const bundled = await Bun.build({
    entrypoints: [entry, worker],
    target: "node",
    outdir: node,
    naming: "[name].[ext]",
    format: "esm",
  })
  expect(bundled.success).toBe(true)
  if (!bundled.success) throw new AggregateError(bundled.logs)
  const embeddedWorker = path.join(tmp.path, "typescript-index.worker.ts")
  const embeddedMain = path.join(tmp.path, "main.ts")
  await writeFile(embeddedWorker, `import ${JSON.stringify(worker)}\n`)
  await writeFile(embeddedMain, `import ${JSON.stringify(entry)}\n`)
  const compiledPath = path.join(tmp.path, process.platform === "win32" ? "compiled-index.exe" : "compiled-index")
  const compiled = await Bun.build({
    root: tmp.path,
    entrypoints: [embeddedMain, embeddedWorker],
    splitting: true,
    compile: { outfile: compiledPath },
    define: { DEEPAGENT_CODE_INDEX_WORKER_PATH: JSON.stringify("./typescript-index.worker.ts") },
  })
  expect(compiled.success).toBe(true)
  if (!compiled.success) throw new AggregateError(compiled.logs)
  // Prove the binary loads its embedded entry, without a source fallback.
  await rm(embeddedWorker)
  await rm(embeddedMain)
  for (const command of [
    [process.env.NODE_BINARY ?? "node", path.join(node, "typescript-index-packaged.js"), request],
    [compiledPath, request],
  ]) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new Error("Packaged semantic worker exceeded its shared execution deadline")
    const child = Bun.spawn(command, { cwd: tmp.path, stdout: "pipe", stderr: "pipe" })
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    const watchdog = setTimeout(() => child.kill("SIGKILL"), remaining)
    try {
      const result = await Promise.all([child.exited, stdout, stderr])
      expect(result[0], result[2] || "Packaged semantic worker reached its shared execution deadline").toBe(0)
      expect(JSON.parse(result[1])).toEqual(JSON.parse(JSON.stringify(expected)))
    } finally {
      clearTimeout(watchdog)
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      } finally {
        await child.exited
        await Promise.allSettled([stdout, stderr])
      }
    }
  }
}, 30_000)

async function workload(root: string) {
  await Promise.all(
    Array.from({ length: 64 }, (_, file) =>
      Bun.write(
        path.join(root, `source-${file}.ts`),
        Array.from(
          { length: 64 },
          (_, item) => `export function operation${item}(value: number) { return value + ${file + item} }`,
        ).join("\n"),
      ),
    ),
  )
  return { root, files: (await scan({ root })).files }
}
