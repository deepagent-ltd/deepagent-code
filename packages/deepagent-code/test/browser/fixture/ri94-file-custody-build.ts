import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { nativeNodeDefines } from "../../../script/build-native-node"
const repository = path.resolve(import.meta.dir, "../../../../..")
const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-ri94-browser-files-"))
await fs.chmod(root, 0o700)
await fs.writeFile("/tmp/dac-ri94-browser-files-root.txt", root, { mode: 0o600 })
const install = path.join(root, "install")
await fs.mkdir(install, { mode: 0o700 })
const old = "/private/tmp/dac-browser-file-batch-canonical-KGUWJ8"
await fs.cp(path.join(old, "File Exchange QA.app"), path.join(root, "File Custody QA.app"), { recursive: true, verbatimSymlinks: true })
await fs.cp(path.join(old, "install/node_modules"), path.join(install, "node_modules"), { recursive: true })
await fs.cp(path.join(old, "install/managed-browser-input"), path.join(install, "managed-browser-input"), { recursive: true })
for (const name of ["deepagent-work-file-helper", "deepagent-work-storage-cleanup", "bun-command-runtime"]) {
  await fs.copyFile(path.join(old, "install", name), path.join(install, name))
  await fs.chmod(path.join(install, name), 0o755)
}
const helper = await fs.readFile(path.join(install, "deepagent-work-file-helper"))
process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY = "/private/tmp/dac-desktop-node-sealed-JaFi97/public.pem"
const define = await nativeNodeDefines({ repository, destination: install, helper: { path: "packages/work-file-helper/bin/darwin-arm64/deepagent-work-file-helper",
  bytes: helper.length, sha256: createHash("sha256").update(helper).digest("hex") } })
const manifest = JSON.parse(JSON.parse(define.DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST!))
for (const relative of ["packages/deepagent-code/test/browser/fixture/ri94-file-custody-child.ts", "packages/desktop/src/main/fixture/ri94-file-custody.ts"]) {
  const bytes = await fs.readFile(path.join(repository, relative))
  if (!manifest.components.some((entry: { path: string }) => entry.path === relative)) manifest.components.push({ path: relative, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") })
}
manifest.components.sort((a: { path: string }, b: { path: string }) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
const text = CanonicalJson.stringify(manifest)
define.DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST = JSON.stringify(text)
await fs.writeFile(path.join(install, "node.js.native-components.json"), text)
const child = await Bun.build({ entrypoints: [path.join(import.meta.dir, "ri94-file-custody-child.ts")], outdir: install,
  naming: "node.js", target: "node", format: "esm", sourcemap: "external", external: ["@lydell/node-pty", "jsonc-parser", "bun"],
  define: { ...define, DEEPAGENT_CODE_VERSION: '"2.0.3"', DEEPAGENT_CODE_CHANNEL: '"dev"' },
  plugins: [{ name: "original-owner-observation-only-hooks", setup(build) {
    build.onLoad({ filter: /src\/browser\/file-exchange\.ts$/ }, async (input) => {
      const source = await fs.readFile(input.path, "utf8")
      return { loader: "ts", contents: source
        .replace('    try {\n      await Effect.runPromise(currentControl(control))', '    try {\n      await globalThis.__RI94ObserveAwait?.();\n      await Effect.runPromise(currentControl(control))')
        .replace('        const capture = yield* BrowserFileExchange.preview(database.db, input)', '        yield* Effect.promise(() => Promise.resolve(globalThis.__RI94PreviewAwait?.()));\n        const capture = yield* BrowserFileExchange.preview(database.db, input)')
        .replace('        const capture = captures.get(input.command.previewID)', '        yield* Effect.promise(() => Promise.resolve(globalThis.__RI94OperationAwait?.()));\n        const capture = captures.get(input.command.previewID)')
        .replace('  const entry: Native = { child,', '  const emit = child.emit.bind(child); child.emit = (event, ...args) => event === "close" && globalThis.__RI94ChildClose ? globalThis.__RI94ChildClose(emit, [event, ...args]) : emit(event, ...args);\n  const entry: Native = { child,')
        .replace('  return Layer.mergeAll(Layer.succeed(BrowserFileCapability.Service, native)', '  globalThis.__RI94Files = { api, native, counts: () => ({ observing: observing.size, opening: state.opening, active: active.size, captures: captures.size, previewing: state.previewing, operations: operations.size }) };\n  return Layer.mergeAll(Layer.succeed(BrowserFileCapability.Service, native)') }
    })
  } }] })
if (!child.success) throw new AggregateError(child.logs, "Original browser child failed to build")
const main = await Bun.build({ entrypoints: [path.join(repository, "packages/desktop/src/main/fixture/ri94-file-custody.ts")], outdir: install,
  naming: "main.mjs", target: "node", format: "esm", external: ["electron"], define: { __DAC_MANAGED_BROWSER_INPUT_ASSET__: JSON.stringify(JSON.parse(await fs.readFile(path.join(install, "managed-browser-input/managed-browser-input.asset.json"), "utf8"))) } })
if (!main.success) throw new AggregateError(main.logs, "Original browser Main failed to build")
for (const name of ["project", "home", "tmp", "config", "data", "cache", "state"]) await fs.mkdir(path.join(root, name), { mode: 0o700 })
await fs.writeFile(path.join(root, "project/source.bin"), Buffer.alloc(37, 73), { mode: 0o600 })
await fs.writeFile(path.join(root, "project/deepagent-code.json"), JSON.stringify({ formatter: false, lsp: false }), { mode: 0o600 })
const drift = (await Promise.all(manifest.components.filter((entry: { path: string }) => !entry.path.startsWith("packages/work-file-helper/bin/")).map(async (entry: { path: string; sha256: string }) =>
  createHash("sha256").update(await fs.readFile(path.join(repository, entry.path))).digest("hex") === entry.sha256 ? undefined : entry.path))).filter(Boolean)
const module = path.join(install, "node.js")
const runtime = path.join(root, "File Custody QA.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper")
const safe = { root, module, runtime, moduleHash: createHash("sha256").update(await fs.readFile(module)).digest("hex"), runtimeHash: createHash("sha256").update(await fs.readFile(runtime)).digest("hex"),
  selectedSources: manifest.components.length, sourceDrift: drift, sourceCohort: path.join(install, "node.js.native-components.json"), testOnlyObservationHooks: true, replacesAuthority: false,
  launch: { executable: path.join(root, "File Custody QA.app/Contents/MacOS/Electron"), args: [path.join(install, "main.mjs")], env: { DAC_BROWSER_TEST_ROOT: root, DAC_BROWSER_CHILD: module } } }
await fs.writeFile(path.join(root, "candidate-safe.json"), JSON.stringify(safe), { mode: 0o600 })
if (drift.length) throw new Error("Build source drift")
console.log(JSON.stringify(safe))
