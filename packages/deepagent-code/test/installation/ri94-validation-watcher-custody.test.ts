import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
test("original validation Host reserves before filesystem await and retires only actual original watchers", async () => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-ri94-validation-watchers-"))
  try {
    const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/ri94-validation-watchers.ts")],
      target: "bun", outdir: path.join(root, "install"), plugins: [{ name: "readonly-original-owner-observer", setup(builder) {
        builder.onLoad({ filter: /src\/deepagent\/event-validation\.ts$/ }, async (input) => {
          const source = await fs.readFile(input.path, "utf8")
          // Test-private observation/delay hooks; real lstat/realpath/watch/close/finalizers remain.
          return { loader: "ts", contents: source.replace('try: async () => ({ stat: await fs.lstat(directory), real: await fs.realpath(directory) })',
            'try: async () => { await globalThis.__RI94WatchAwait?.(); return { stat: await fs.lstat(directory), real: await fs.realpath(directory) } }')
            .replace('  return Service.of({', '  globalThis.__RI94WatchOwner = { capture: captureParent, detach, counts: () => ({ owned: ownedParents.size, pending: pendingParents.size, named: parents.size }) };\n  return Service.of({') }
        })
      } }] })
    expect(build.success, build.logs.join("\n")).toBe(true)
    const child = Bun.spawn([process.execPath, path.join(root, "install/ri94-validation-watchers.js"), root], {
      cwd: root, env: { PATH: process.env.PATH, HOME: root, DEEPAGENT_CODE_TEST_HOME: root,
        DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1", DEEPAGENT_ENABLED: "false" }, stdout: "pipe", stderr: "pipe", timeout: 20000 })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(code, stdout + stderr).toBe(0)
    expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({ bound: 256, exactJoined: true, knownReleased: 255, unknownRetained: 1,
      unknownCloseCalls: 1, lateOriginalCloseReleased: true, final: { owned: 0, pending: 0, named: 0 }, provider: 0, nativeCommands: 0, authority: false })
  } finally { await fs.rm(root, { recursive: true, force: true }) }
}, 30000)
