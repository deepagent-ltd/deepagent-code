import { expect, test } from "bun:test"
import { Schema } from "effect"
import { WorkCommandSchema } from "@deepagent-code/core/session/work-command.schema"
import fs from "node:fs/promises"
import path from "node:path"
import { createServer } from "node:net"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { NativeInstallationSchema } from "../../src/installation/native-installation.schema"

const repository = path.resolve(import.meta.dir, "../../../..")
const host = path.join(repository, "packages/deepagent-code")
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const commandRecipe = Schema.decodeUnknownSync(WorkCommandSchema.RecipeRequest)({ schemaVersion: "work-command-recipe.v1", logicalID: "build", revision: 1,
            executable: "installed-bun-v1", argv: ["build", "input.ts", "--outfile", "output.js", "--target", "bun"].map((value) => ({ kind: "literal", value })),
            parameters: [], cwd: null, inputs: ["input.ts"], outputs: ["output.js"], environment: [{ name: "CI", value: "1" }],
            workspace: "private_explicit_files.v1", sandbox: { id: "darwin-single-process-workspace-v1", revision: 1, network: "deny", processes: 1,
              openFiles: 64, maxInputFiles: 256, maxInputFileBytes: 16777216, maxInputBytes: 67108864, maxDepth: 16,
              maxOutputFiles: 32, maxOutputFileBytes: 1048576, maxOutputBytes: 33554432 }, timeoutMs: 120000, stdoutBytes: 1048576, stderrBytes: 1048576,
          })

test("signed CLI production source/approval/count/canonical execution and cold non-replay with pinned test transport", async () => {
  const deepseek = process.env.DAC_WORK_DEEPSEEK_PROFILE === "1"
  if (deepseek && !process.env.DAC_WORK_CASES?.split(",").every((mode) =>
    ["project-command-build", "project-write-flag-observed", "project-write-flag-changed", "project-write-flag-missing-read"].includes(mode)))
    throw new Error("Context-bound Native regression requires the selected command/write boundary cases")
  // Project cases require the actual approved asset in the signed installation. Refuse
  // before compiling if the harness omitted it, rather than wasting a candidate on enrollment.
  if (!process.env.DAC_WORK_REUSE_CANDIDATE && (!process.env.DAC_WORK_CASES || process.env.DAC_WORK_CASES.includes("project-"))) {
    const helper = process.env.DAC_WORK_NATIVE_HELPER
    if (!helper) throw new Error("Project cases require the fixed native helper asset")
    const stat = await fs.stat(helper)
    if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error("Native helper must be an executable regular file")
    const expected = process.env.DAC_WORK_EXPECTED_HELPER_SHA
    if (!expected || hash(await fs.readFile(helper)) !== expected) throw new Error("Exact approved native helper hash is required")
  }
  if (process.env.DAC_WORK_CASES?.includes("project-command-")) {
    const runtime = process.env.DAC_WORK_COMMAND_RUNTIME
    if (!runtime) throw new Error("Command case requires the fixed approved runtime asset")
    const before = await fs.lstat(runtime, { bigint: true })
    const bytes = await fs.readFile(runtime)
    const after = await fs.lstat(runtime, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o111n) === 0n || (before.mode & 0o022n) !== 0n ||
      await fs.realpath(runtime) !== runtime || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
      bytes.byteLength !== Number(before.size) || hash(bytes) !== process.env.DAC_WORK_EXPECTED_RUNTIME_SHA)
      throw new Error("Exact approved command runtime changed")
  }
  const storageCleanup = process.env.DAC_WORK_STORAGE_CLEANUP_ASSET
  if (!process.env.DAC_WORK_REUSE_CANDIDATE && /project-(write|command)-/.test(process.env.DAC_WORK_CASES ?? "project-write-")) {
    if (!storageCleanup) throw new Error("Write/command cases require the independent storage cleanup asset")
    const before = await fs.lstat(storageCleanup, { bigint: true })
    const bytes = await fs.readFile(storageCleanup)
    const after = await fs.lstat(storageCleanup, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o111n) === 0n || (before.mode & 0o022n) !== 0n ||
      await fs.realpath(storageCleanup) !== storageCleanup || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
      bytes.byteLength !== Number(before.size) || hash(bytes) !== process.env.DAC_WORK_EXPECTED_STORAGE_CLEANUP_SHA)
      throw new Error("Exact approved storage cleanup asset changed")
  }
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-work-production-"))
  await fs.writeFile("/tmp/dac-work-production-current", root)
  const prior = process.env.DAC_WORK_SOURCE_SNAPSHOT
  const inputs = prior ? JSON.parse(await fs.readFile(path.join(prior, "../source-cohort.json"), "utf8")) as { originals: Record<string, string> } : undefined
  const readInput = async (file: string) => {
    if (!prior || !inputs || !(file in inputs.originals)) return fs.readFile(path.join(repository, file))
    const raw = await fs.readFile(path.join(prior, file))
    if (hash(raw) !== inputs.originals[file]) throw new Error(`Snapshot identity changed: ${file}`)
    return raw
  }
  const scenario = { mode: "happy", project: "", generations: 0, kill: () => {} }
  const observed: { path: string; body: unknown; authenticated: boolean }[] = []
  const provider = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.DAC_WORK_TEST_PORT ?? 0), async fetch(request) {
    const pathname = new URL(request.url).pathname
    const body: unknown = await request.json()
    observed.push({ path: pathname, body, authenticated: request.headers.get("authorization") === "Bearer fixture-native-key" })
    if (pathname === "/v1/responses/input_tokens") {
      if (scenario.mode === "count-killed") {
        scenario.kill()
        return new Response("interrupted", { status: 503 })
      }
      if ((scenario.mode === "count-revoked" || (scenario.mode === "project-count-revoked" && scenario.generations === 1))) {
        await fs.writeFile(path.join(scenario.project, "count-observed"), "received")
        const started = Date.now()
        while (!(await Bun.file(path.join(scenario.project, "count-release")).exists())) {
          if (Date.now() - started > 8_000) return new Response("release timeout", { status: 503 })
          await Bun.sleep(10)
        }
      }
      if (scenario.mode === "count-unknown") return new Response('{"object":"response.input_tokens",', { headers: { "content-type": "application/json" } })
      if (scenario.mode === "count-late") await Bun.sleep(11_000)
      return Response.json({ object: "response.input_tokens", input_tokens: scenario.mode === "count-over" ? 9000 : 41 })
    }
    if (pathname !== "/v1/responses") return new Response("unavailable", { status: 404 })
    scenario.generations++
    if (scenario.mode.startsWith("project-") && scenario.generations === 1) {
      const call = scenario.mode === "project-write-flag-missing-read"
        ? { type: "function_call", id: "item_write", call_id: "call_write", name: "write", arguments: JSON.stringify({ path: "approved.txt", content: "Unobserved replacement must be refused.\n", overwrite: true }) }
        : scenario.mode.startsWith("project-command-")
        ? { type: "function_call", id: "item_command", call_id: "call_command", name: "managed_command", arguments: JSON.stringify({ commandID: "build", parameters: [] }) }
        : { type: "function_call", id: "item_read", call_id: "call_read", name: "read", arguments: JSON.stringify({ path: "approved.txt", byteOffset: 0, pageBytes: 51200 }) }
      return new Response([
        { type: "response.output_item.added", item: { ...call, arguments: "" } },
        { type: "response.function_call_arguments.delta", item_id: call.id, delta: call.arguments },
        { type: "response.output_item.done", item: call },
        { type: "response.completed", response: { id: "resp_read", usage: { input_tokens: 41, output_tokens: 12, total_tokens: 53 } } },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
    }
    if ((scenario.mode.startsWith("project-write-") && scenario.mode !== "project-write-flag-missing-read" || ["project-command-build", "project-command-multi", "project-command-im-task", "project-command-cold-wake"].includes(scenario.mode)) && scenario.generations === 2) {
      if (scenario.mode === "project-write-refused" || scenario.mode === "project-write-flag-changed") await fs.writeFile(path.join(scenario.project, "approved.txt"), "User's newer version.\n")
      const call = { type: "function_call", id: "item_write", call_id: "call_write", name: "write",
        arguments: JSON.stringify(["project-command-build", "project-command-multi", "project-command-im-task", "project-command-cold-wake"].includes(scenario.mode)
          ? { path: "built.js", content: commandOutput(body) }
          : { path: scenario.mode === "project-write-create" ? "created.txt" : "approved.txt", content: "已验证的原子写入 Native published bytes.\n",
            ...(scenario.mode.startsWith("project-write-flag-") ? { overwrite: true } : {}) }) }
      return new Response([
        { type: "response.output_item.added", item: { ...call, arguments: "" } },
        { type: "response.function_call_arguments.delta", item_id: call.id, delta: call.arguments },
        { type: "response.output_item.done", item: call },
        { type: "response.completed", response: { id: "resp_write", usage: { input_tokens: 41, output_tokens: 12, total_tokens: 53 } } },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
    }
    if (scenario.mode === "project-command-multi" && scenario.generations === 3) {
      const { Database } = await import("bun:sqlite")
      const caseRoot = path.dirname(scenario.project)
      const db = new Database(path.join(caseRoot, "file.sqlite"), { readonly: true })
      try {
        const actual = db.query<{ record: string }, []>("SELECT record FROM work_command_intent").get()
        if (!actual) throw new Error("Command custody is missing")
        const command = Schema.decodeUnknownSync(Schema.fromJsonString(WorkCommandSchema.Record))(actual.record)
        const retained = await fs.readFile(path.join(caseRoot, "data/work-command-stage", command.workspaceBasename, "output.js.map")).catch(() => undefined)
        await fs.writeFile(path.join(caseRoot, "retained-at-final-provider.json"), JSON.stringify({ state: command.state,
          releasedAt: command.releasedAt, reservedBytes: command.reservedBytes, outputs: command.outputs,
          sourceMapHash: retained ? hash(retained) : null,
          meter: db.query("SELECT custody_count,retained_bytes,audit_count FROM work_command_meter").get() }))
      } finally { db.close() }
    }
    if (scenario.mode === "generation-invalid") return new Response("data: invalid JSON\n\n", { headers: { "content-type": "text/event-stream" } })
    if (scenario.mode === "generation-partial" || scenario.mode === "generation-cancel" || scenario.mode === "project-generation-partial") {
      const partial = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","item_id":"msg_partial","delta":"Unconfirmed partial text"}\n\n'))
          if (scenario.mode === "generation-partial" || scenario.mode === "project-generation-partial") setTimeout(() => controller.error(new Error("Fixture body disconnected")), 50)
        },
      })
      if (scenario.mode === "generation-cancel") await fs.writeFile(path.join(scenario.project, "generation-observed"), "received")
      return new Response(partial, { headers: { "content-type": "text/event-stream" } })
    }
    if (scenario.mode === "generation-usage-missing") return new Response('data: {"type":"response.completed","response":{"id":"fixture-missing-usage"}}\n\n', { headers: { "content-type": "text/event-stream" } })
    if (scenario.mode === "generation-usage-over") return new Response('data: {"type":"response.completed","response":{"id":"fixture-over-usage","usage":{"input_tokens":41,"output_tokens":5000,"total_tokens":5041}}}\n\n', { headers: { "content-type": "text/event-stream" } })
    return new Response('data: {"type":"response.output_text.delta","item_id":"msg_fixture","delta":"Reviewed fixed text."}\n\n' +
      'data: {"type":"response.completed","response":{"id":"resp_fixture","usage":{"input_tokens":41,"output_tokens":12,"output_tokens_details":{"reasoning_tokens":5},"total_tokens":53}}}\n\n',
    { headers: { "content-type": "text/event-stream" } })
  } })
  await fs.mkdir(path.join(root, "install"))
  const reuse = process.env.DAC_WORK_REUSE_CANDIDATE
  const executable = path.join(reuse ?? root, "install/deepagent-code")
  if (path.dirname(executable) === path.join(root, "cases") ||
    path.join(root, "cases").startsWith(`${path.dirname(executable)}${path.sep}`))
    throw new Error("Installation assets and cases must be separate namespaces")
  if (reuse) {
    const expected = process.env.DAC_WORK_EXPECTED_EXECUTABLE_SHA
    if (!expected || hash(await fs.readFile(executable)) !== expected) throw new Error("Exact signed candidate mismatch")
    const original = JSON.parse(await fs.readFile(path.join(reuse, "source-cohort.json"), "utf8")) as { checked: number; drift: unknown[] }
    expect(original.drift).toEqual([])
    await fs.writeFile(path.join(root, "reused-artifact.json"), JSON.stringify({ candidate: reuse, executableSHA: expected,
      sourceCohort: path.join(reuse, "source-cohort.json"), sourceInputs: original.checked,
      parentOnlyChanges: "fresh cases; canonical native providers and permissions in one project document; no product source or compiled debug replacement" }, null, 2))
  }
  const pair = generateKeyPairSync("ed25519")
  const pin = pair.publicKey.export({ type: "spki", format: "pem" }).toString()
  const fixture = path.join(import.meta.dir, "fixture/work-production-cli.ts")
  const replacements = new Map<string, string>()
  const policyPath = "packages/core/src/session/work-authority-policy.ts"
  const policyOriginal = (await readInput(policyPath)).toString()
  const policyNeedle = '    url.protocol !== "https:" &&'
  expect(policyOriginal.split(policyNeedle)).toHaveLength(2)
  replacements.set(policyPath, policyOriginal.replace(policyNeedle,
    `    url.protocol !== "https:" && url.origin !== ${JSON.stringify(provider.url.origin)} &&`))
  const contractPath = "packages/deepagent-code/src/installation/work-provider-contract.ts"
  const contractOriginal = (await readInput(contractPath)).toString()
  expect(contractOriginal.match(/https:\/\/api\.openai\.com/g)).toHaveLength(2)
  replacements.set(contractPath, contractOriginal.replaceAll("https://api.openai.com", provider.url.origin))
  if (deepseek) {
    const boundedPath = "packages/llm/src/route/vendor-context-bound.ts"
    const boundedOriginal = (await readInput(boundedPath)).toString()
    expect(boundedOriginal.split('endpoint: "https://api.deepseek.com/responses"')).toHaveLength(2)
    replacements.set(boundedPath, boundedOriginal.replace('endpoint: "https://api.deepseek.com/responses"',
      `endpoint: ${JSON.stringify(`${provider.url.origin}/v1/responses`)}`))
    const routePath = "packages/core/src/session/work-route-policy.ts"
    const routeOriginal = (await readInput(routePath)).toString()
    expect(routeOriginal.split("https://api.deepseek.com/responses")).toHaveLength(3)
    replacements.set(routePath, routeOriginal.replaceAll("https://api.deepseek.com/responses", `${provider.url.origin}/v1/responses`))
    const evidencePath = "packages/core/src/session/work-route-approval.schema.ts"
    const evidenceOriginal = (await readInput(evidencePath)).toString()
    expect(evidenceOriginal.split("https://api.deepseek.com/responses")).toHaveLength(2)
    replacements.set(evidencePath, evidenceOriginal.replace("https://api.deepseek.com/responses", `${provider.url.origin}/v1/responses`))
    expect(policyOriginal.split("https://api.deepseek.com/responses")).toHaveLength(3)
    replacements.set(policyPath, replacements.get(policyPath)!.replaceAll("https://api.deepseek.com/responses", `${provider.url.origin}/v1/responses`))
  }
  if (process.env.DAC_WORK_CASES?.includes("im-task")) {
    const routePath = "packages/core/src/session/work-route-policy.ts"
    const routeOriginal = (await readInput(routePath)).toString()
    const routeNeedle = '  if (endpoint === "https://api.openai.com/v1/responses") return true'
    expect(routeOriginal.split(routeNeedle)).toHaveLength(2)
    replacements.set(routePath, routeOriginal.replace(routeNeedle,
      `${routeNeedle}\n  if (endpoint === ${JSON.stringify(`${provider.url.origin}/v1/responses`)}) return true`))
  }
  const commandPath = "packages/deepagent-code/src/cli/cmd/debug/index.ts"
  replacements.set(commandPath, await fs.readFile(fixture, "utf8"))
  await fs.mkdir(path.join(root, "overlays"))
  const overlay = await Promise.all([...replacements].map(async ([file, contents]) => {
    const before = await readInput(file)
    await fs.writeFile(path.join(root, "overlays", file.replaceAll("/", "__") + ".before"), before)
    await fs.writeFile(path.join(root, "overlays", file.replaceAll("/", "__") + ".after"), contents)
    return { file, originalHash: hash(before), overlayHash: hash(contents), bytes: Buffer.byteLength(contents) }
  }))
  await fs.writeFile(path.join(root, "overlay-review.json"), JSON.stringify({ origin: provider.url.origin, overlay }, null, 2))
  console.info("WORK_PRODUCTION_REVIEW_READY", root)
  try {
    // External coordination of shared source inventory, never a production feature flag.
    if (!reuse && process.env.DAC_WORK_BUILD_GATE) {
      const start = Date.now()
      while (!(await Bun.file(process.env.DAC_WORK_BUILD_GATE).exists())) {
        if (Date.now() - start > 300_000) throw new Error("Build coordination gate expired")
        await Bun.sleep(100)
      }
    }
    if (!reuse) {
    const helper = path.join(root, "install/deepagent-work-file-helper")
    const compiledHelper = process.env.DAC_WORK_NATIVE_HELPER
    if (compiledHelper) { await fs.copyFile(compiledHelper, helper); await fs.chmod(helper, 0o755) }
    const runtime = path.join(root, "install/bun-command-runtime")
    const commandRuntime = process.env.DAC_WORK_COMMAND_RUNTIME
    if (commandRuntime) {
      await fs.copyFile(commandRuntime, runtime); await fs.chmod(runtime, 0o755)
      if (hash(await fs.readFile(runtime)) !== process.env.DAC_WORK_EXPECTED_RUNTIME_SHA) throw new Error("Runtime copy changed")
    }
    const cleanupAsset = path.join(root, "install/deepagent-work-storage-cleanup")
    if (storageCleanup) {
      await fs.copyFile(storageCleanup, cleanupAsset); await fs.chmod(cleanupAsset, 0o755)
      if (hash(await fs.readFile(cleanupAsset)) !== process.env.DAC_WORK_EXPECTED_STORAGE_CLEANUP_SHA)
        throw new Error("Storage cleanup copy changed")
    }
    const files = inputs ? Object.keys(inputs.originals) : Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard",
      "packages/core/src", "packages/llm/src", "packages/deepagent-code/src", "packages/deepagent-code/script/build.ts",
      "packages/tui", "packages/sdk", "packages/server", "packages/effect-drizzle-sqlite", "packages/effect-sqlite-node", "packages/plugin", "packages/im-kernel-sdk", "packages/identity", "packages/script", "packages/work-file-helper",
      "packages/core/package.json", "packages/llm/package.json", "packages/deepagent-code/package.json", "bun.lock", "patches"],
    { cwd: repository }).stdout.toString().trim().split("\n")
    const originals = new Map<string, string>()
    const components = new NativeInstallationSchema.Components({ schemaVersion: "dac.native-components.v1",
      target: `${process.platform}-${process.arch}`,
      sourceCommit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repository }).stdout.toString().trim(),
      sourceTree: Bun.spawnSync(["git", "rev-parse", "HEAD^{tree}"], { cwd: repository }).stdout.toString().trim(),
      components: [...await Promise.all([...new Set([...files.filter((file) => !file.includes("/dist/") && !file.includes("/target/") && file !== "packages/tui/src/component/prompt/cwd.ts"), path.relative(repository, fixture)])].toSorted().map(async (file) => {
        const raw = file === path.relative(repository, fixture) ? await fs.readFile(fixture) : await readInput(file)
        originals.set(file, hash(raw))
        const snapshot = path.join(root, "source-snapshot", file)
        await fs.mkdir(path.dirname(snapshot), { recursive: true })
        await fs.writeFile(snapshot, raw)
        const bytes = replacements.has(file) ? Buffer.from(replacements.get(file)!) : raw
        return new NativeInstallationSchema.Component({ path: file, bytes: bytes.byteLength, sha256: hash(bytes) })
      })), ...(compiledHelper ? [new NativeInstallationSchema.Component({
        path: `packages/work-file-helper/bin/${process.platform}-${process.arch}/deepagent-work-file-helper`,
        bytes: (await fs.stat(helper)).size, sha256: hash(await fs.readFile(helper)),
      })] : []), ...(commandRuntime ? [new NativeInstallationSchema.Component({
        path: `packages/work-file-helper/bin/${process.platform}-${process.arch}/bun-command-runtime`,
        bytes: (await fs.stat(runtime)).size, sha256: hash(await fs.readFile(runtime)),
      })] : []), ...(storageCleanup ? [new NativeInstallationSchema.Component({
        path: `packages/work-file-helper/bin/${process.platform}-${process.arch}/deepagent-work-storage-cleanup`,
        bytes: (await fs.stat(cleanupAsset)).size, sha256: hash(await fs.readFile(cleanupAsset)),
      })] : [])].toSorted((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    })
    const componentsText = CanonicalJson.stringify(components)
    const parserWorker = await fs.realpath(path.join(host, "node_modules/@opentui/core/parser.worker.js"))
    const compilerReads: { logicalPath: string; actualPath: string; sha256: string }[] = []
    const requireSnapshot = async (file: string) => {
      if (file.includes("/node_modules/") || !file.startsWith("packages/") || originals.has(file) || replacements.has(file)) return
      await fs.appendFile(path.join(root, "unexpected-source-paths.jsonl"), JSON.stringify({ file }) + "\n")
      throw new Error(`First-party source is outside the fixed compilation snapshot: ${file}`)
    }
    const solid = createSolidTransformPlugin()
    const build = await Bun.build({ entrypoints: [path.join(host, "src/index.ts"), parserWorker, path.join(host, "src/cli/tui/worker.ts")],
      tsconfig: path.join(host, "tsconfig.json"), conditions: ["node"], target: "bun", format: "esm", splitting: true, external: ["node-gyp"],
      plugins: [{ name: "snapshot-solid", setup(builder) {
        return solid.setup({ ...builder, onLoad: (options, callback) => builder.onLoad(options, async (args) => {
          const file = path.relative(repository, await fs.realpath(args.path))
          await requireSnapshot(file)
          if (!originals.has(file)) return callback(args)
          const actualPath = path.join(root, "source-snapshot", file)
          const raw = await fs.readFile(actualPath)
          compilerReads.push({ logicalPath: args.path, actualPath, sha256: hash(raw) })
          const result = await callback({ ...args, path: actualPath })
          return result ? { ...result, resolveDir: path.dirname(args.path) } : result
        }) })
      } }, { name: "signed-pinned-loopback-contract", setup(builder) {
        builder.onLoad({ filter: /\.(?:ts|js|mjs|json)$/ }, async (args) => {
          const file = path.relative(repository, await fs.realpath(args.path))
          await requireSnapshot(file)
          const content = replacements.get(file)
          if (content !== undefined) {
            compilerReads.push({ logicalPath: args.path, actualPath: path.join(root, "overlays", file.replaceAll("/", "__") + ".after"), sha256: hash(content) })
            return { contents: content, loader: "ts" }
          }
          if (!originals.has(file)) return undefined
          const actualPath = path.join(root, "source-snapshot", file)
          const raw = await fs.readFile(actualPath)
          compilerReads.push({ logicalPath: args.path, actualPath, sha256: hash(raw) })
          return { contents: raw, loader: file.endsWith(".json") ? "json" : file.endsWith(".ts") ? "ts" : "js" }
        })
      } }],
      compile: { outfile: executable, autoloadDotenv: false, autoloadBunfig: false, execArgv: ["--use-system-ca", "--"] },
      define: { DEEPAGENT_CODE_VERSION: JSON.stringify("2.0.3-dev"), DEEPAGENT_CODE_CHANNEL: JSON.stringify("dev"),
        DEEPAGENT_CODE_NATIVE_RUNTIME_PUBLIC_KEY: JSON.stringify(pin), DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST: JSON.stringify(componentsText),
        DEEPAGENT_CODE_WORKER_PATH: JSON.stringify("./src/cli/tui/worker.ts"),
        OTUI_TREE_SITTER_WORKER_PATH: JSON.stringify(`/$bunfs/root/${path.relative(host, parserWorker)}`) },
    })
    await fs.writeFile(path.join(root, "build.json"), JSON.stringify({ success: build.success, logs: build.logs.map((entry) => entry.message) }))
    const drift = (await Promise.all([...originals].map(async ([file, digest]) => hash(file === path.relative(repository, fixture) ? await fs.readFile(fixture) : await readInput(file)) === digest ? undefined : file))).filter(Boolean)
    await fs.writeFile(path.join(root, "source-cohort.json"), JSON.stringify({ checked: originals.size, drift, snapshotOf: prior ?? null, originals: Object.fromEntries(originals) }))
    await fs.writeFile(path.join(root, "compiler-source-paths.json"), JSON.stringify(compilerReads, null, 2))
    await fs.writeFile(path.join(root, "build-complete"), "complete")
    expect(drift).toEqual([])
    expect(build.success).toBe(true)
    const bytes = await fs.readFile(executable)
    const payload = new NativeInstallationSchema.Payload({ domain: NativeInstallationSchema.DOMAIN, releaseID: "r2-production-test-transport",
      target: components.target, sourceCommit: components.sourceCommit, sourceTree: components.sourceTree,
      componentsHash: hash(componentsText), executable: { bytes: bytes.byteLength, sha256: hash(bytes) } })
    await fs.writeFile(`${executable}${NativeInstallationSchema.SIDECAR_SUFFIX}`, CanonicalJson.stringify(new NativeInstallationSchema.Manifest({
      payload, signature: sign(null, Buffer.from(CanonicalJson.stringify(payload)), pair.privateKey).toString("hex"),
    })))
    await fs.writeFile(path.join(root, "components.json"), componentsText)
    }
    for (const mode of ["project-command-cold-wake", "project-command-im-task", "project-command-multi", "project-command-cancel", "project-command-killed", "project-command-build", "project-write-flag-observed", "project-write-flag-changed", "project-write-flag-missing-read", "project-write-create", "project-write-replace", "project-write-permission-revoked", "project-write-refused", "project-write-unknown", "project-two-turn", "project-cold-known", "project-recover-known", "project-generation-partial", "project-count-revoked", "project-budget", "happy", "count-unknown", "count-over", "count-late", "count-revoked", "count-killed", "credential-change", "operator-config-change", "config-change", "route-revoke", "source-revoke", "ordinary", "generation-invalid", "generation-partial", "generation-cancel", "generation-usage-missing", "generation-usage-over"] as const) {
      if (process.env.DAC_WORK_CASES && !process.env.DAC_WORK_CASES.split(",").includes(mode)) continue
      if (mode === "project-write-permission-revoked" && !process.env.DAC_WORK_PERMISSION_HOLD_MS) continue
      scenario.mode = mode
      scenario.generations = 0
      const caseRoot = path.join(root, "cases", mode)
      await fs.mkdir(caseRoot, { recursive: true })
      const project = path.join(caseRoot, "project")
      scenario.project = project
      await Promise.all(["project", "home", "tmp", "config", "data", "cache", "state", "managed"].map((name) => fs.mkdir(path.join(caseRoot, name))))
      const holdPermission = process.env.DAC_WORK_PERMISSION_HOLD_MS
      const permissionEffect = holdPermission ? "ask" : "allow"
      const providerID = deepseek ? "deepseek" : "openai"
      const modelID = deepseek ? "deepseek-flash" : "gpt-4.1-2025-04-14"
      const configuration = { formatter: false, lsp: false,
        ...(holdPermission ? { permission: { edit: "ask", bash: "ask" } } : {}),
        ...(mode.startsWith("project-command-") ? { permissions: [{ action: "bash", resource: "command:build", effect: permissionEffect }, { action: "edit", resource: "*", effect: permissionEffect }] } : {}),
        ...(mode.startsWith("project-write-") ? { permissions: [{ action: "edit", resource: "*", effect: permissionEffect }] } : {}),
        model: `${providerID}/${modelID}`, providers: { [providerID]: { env: ["DAC_FIXTURE_NATIVE_KEY"],
          api: { type: "native", settings: {}, protocol: deepseek && mode.startsWith("project-write-flag-") ? "openai-compatible.responses" : "openai.responses", url: `${provider.url.origin}/v1` },
          models: { [modelID]: { api: { id: modelID },
            capabilities: { input: ["text"], output: ["text"], tools: mode.startsWith("project-") }, limit: { context: deepseek ? 1_048_576 : 100_000, output: 4_096 } } } } } }
      await fs.writeFile(path.join(project, "deepagent-code.json"), JSON.stringify(configuration))
      const policy = path.join(caseRoot, "policy.json")
      if (mode.startsWith("project-")) await fs.writeFile(path.join(project, "approved.txt"), "实际批准的原生文件内容 Native approved bytes.\n")
      if (mode.startsWith("project-command-")) await fs.writeFile(path.join(project, "input.ts"), "export const answer: number = 42;\n")
      await fs.writeFile(policy, JSON.stringify({ version: deepseek ? 7 : mode.startsWith("project-command-") ? 4 : mode.startsWith("project-write-") ? 3 : mode.startsWith("project-") ? 2 : 1,
        targets: [{ id: "review", directory: project, agentID: "auto",
        providerID, modelID, ...(deepseek ? { profile: "project_deepseek_context_bound_v1" } : {}),
        budget: deepseek ? WorkAuthorityPolicy.DEEPSEEK_PROJECT_PROFILE.budget : mode.startsWith("project-") ? { ...WorkAuthorityPolicy.PROJECT_PROFILE.budget, maxChildren: 0, ...(mode === "project-budget" ? { maxTotalTokens: 16450 } : {}) } : { ...WorkAuthorityPolicy.TEXT_ONLY_PROFILE.budget, maxTotalTokens: 8_000 },
        ...(mode.startsWith("project-") ? { project: { tools: mode.startsWith("project-command-") ? ["managed_command", "write"] : mode.startsWith("project-write-") ? ["read", "write"] : ["read"],
          ...(mode.startsWith("project-command-") ? { commandRecipes: [{ ...commandRecipe, argv: mode === "project-command-multi"
            ? ["build", "input.ts", "--outdir", ".", "--entry-naming", "output.js", "--sourcemap=external", "--target", "bun"].map((value) => ({ kind: "literal", value }))
            : [...commandRecipe.argv, ...(mode === "project-command-cancel" ? [{ kind: "literal", value: "--watch" }] : [])],
            outputs: mode === "project-command-multi" ? ["output.js", "output.js.map"] : commandRecipe.outputs }] } : {}), fileScope: {
          read: [{ kind: "file", path: mode.startsWith("project-command-") ? "input.ts" : "approved.txt" }],
          write: mode.startsWith("project-command-") ? [{ kind: "file", path: "built.js" }] : mode.startsWith("project-write-") ? [{ kind: "file", path: mode === "project-write-create" ? "created.txt" : "approved.txt" }] : [], deny: [], maxReadBytes: 65536, maxPageBytes: 51200,
          maxHashBytes: 16777216, maxWriteBytes: mode.startsWith("project-write-") || mode.startsWith("project-command-") ? 51200 : 0, symlinks: "deny",
        } } } : {}),
      }] }))
      const bin = path.join(caseRoot, "home/.deepagent/code/cache/bin")
      await fs.mkdir(bin, { recursive: true })
      const rg = Bun.which("rg")
      if (!rg) throw new Error("Offline fixture requires installed rg")
      await fs.copyFile(rg, path.join(bin, "rg"))
      const env: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: path.join(caseRoot, "home"), TMPDIR: path.join(caseRoot, "tmp"),
        XDG_CONFIG_HOME: path.join(caseRoot, "config"), XDG_DATA_HOME: path.join(caseRoot, "data"), XDG_CACHE_HOME: path.join(caseRoot, "cache"), XDG_STATE_HOME: path.join(caseRoot, "state"),
        DEEPAGENT_CODE_TEST_HOME: path.join(caseRoot, "home"), DEEPAGENT_CODE_HOME: path.join(caseRoot, "data"),
        DEEPAGENT_CODE_DB: path.join(caseRoot, "file.sqlite"), DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(caseRoot, "managed"),
        DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1", DEEPAGENT_CODE_MODELS_PATH: path.join(host, "test/tool/fixtures/models-api.json"),
        DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "1", DEEPAGENT_CODE_V2_OWNER_CAMPAIGN: "", DEEPAGENT_CODE_V2_OWNER_PUBLIC_KEY: "",
        DEEPAGENT_CODE_SERVER_USERNAME: "fixture-operator", DEEPAGENT_CODE_SERVER_PASSWORD: mode === "ordinary" ? undefined : "fixture-operator-password",
        DEEPAGENT_IM_AGENT_RESPONDER: "off", DAC_FIXTURE_NATIVE_KEY: "fixture-native-key", NO_COLOR: "1", DAC_WORK_PROJECT: mode.startsWith("project-") ? "1" : undefined, DAC_WORK_WRITE_CASE: mode.startsWith("project-write-") ? mode : undefined,
        DAC_WORK_PERMISSION_HOLD_MS: holdPermission, DAC_WORK_PERMISSION_REVOKE: mode === "project-write-permission-revoked" ? "1" : undefined,
        DAC_WORK_COMMAND_CASE: mode.startsWith("project-command-") ? "1" : undefined }
      const run = async (name: string, args: string[]) => {
        const child = Bun.spawn([executable, ...args], { cwd: project, env: { ...env, DAC_WORK_PRODUCTION_RESULT: path.join(caseRoot, `${name}.json`) }, stdout: "pipe", stderr: "pipe" })
        scenario.kill = () => child.kill("SIGKILL")
        const timer = setTimeout(() => child.kill("SIGKILL"), mode === "project-command-im-task" ? 90_000 : 45_000)
        if ((mode === "project-cold-known" || mode === "project-recover-known") && name === "run") {
          const started = Date.now()
          while (!(await Bun.file(path.join(project, "known-read-committed")).exists())) {
            if (Date.now() - started > 15000 || child.exitCode !== null) break
            await Bun.sleep(10)
          }
          child.kill("SIGKILL")
        }
        if ((mode === "project-command-cancel" || mode === "project-command-killed") && name === "run") {
          const { Database } = await import("bun:sqlite")
          const deadline = Date.now() + 25000
          while (!(await Bun.file(path.join(project, "work-identity.json")).exists())) {
            if (Date.now() >= deadline || child.exitCode !== null) throw new Error("Actual command admission was not observed")
            await Bun.sleep(5)
          }
          const db = new Database(path.join(caseRoot, "file.sqlite"), { readonly: true })
          try {
            const read = db.query<{ record: string }, []>("SELECT record FROM work_command_intent LIMIT 1")
            const state: { record?: WorkCommandSchema.Record } = {}
            while (!state.record) {
              const actual = read.get()
              const command = actual ? Schema.decodeUnknownSync(Schema.fromJsonString(WorkCommandSchema.Record))(actual.record) : undefined
              if (command?.state === "dispatching" && command.processID !== null) {
                if (mode === "project-command-killed") state.record = command
                else {
                  const output = path.join(caseRoot, "data/work-command-stage", command.workspaceBasename, "output.js")
                  if ((await fs.stat(output)).size > 0) state.record = command
                }
              }
              if (Date.now() >= deadline || child.exitCode !== null) throw new Error("Actual dispatched command was not observed")
              if (!state.record) await Bun.sleep(2)
            }
            const command = state.record
            if (mode === "project-command-killed") child.kill("SIGKILL")
            else {
              const ports = Bun.spawnSync(["/usr/sbin/lsof", "-nP", "-a", "-p", String(child.pid), "-iTCP", "-sTCP:LISTEN", "-Fn"])
                .stdout.toString().split("\n").flatMap((line) => /^n127\.0\.0\.1:([0-9]+)$/.exec(line)?.[1] ?? [])
              if (ports.length !== 1) throw new Error("Owned CLI listener identity is unavailable")
              const response = await fetch(`http://127.0.0.1:${ports[0]}/session/${encodeURIComponent(command.sessionID)}/abort`, {
                method: "POST", headers: { authorization: `Basic ${Buffer.from("fixture-operator:fixture-operator-password").toString("base64")}`,
                  "x-deepagent-code-directory": project }, signal: AbortSignal.timeout(15000),
              })
              await fs.writeFile(path.join(caseRoot, "abort.json"), JSON.stringify({ status: response.status, body: await response.text(),
                pid: command.processID, commandID: command.commandID }))
              expect(response.status).toBe(200)
            }
            await fs.writeFile(path.join(caseRoot, "dispatch-observed.json"), JSON.stringify({ state: command.state,
              commandID: command.commandID, admissionID: command.admissionID, processID: command.processID,
              processIncarnation: command.processIncarnation, workspaceBasename: command.workspaceBasename, updatedAt: command.updatedAt }))
          } finally { db.close() }
        }
        const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).finally(() => clearTimeout(timer))
        await fs.writeFile(path.join(caseRoot, `${name}.log`), JSON.stringify({ exit, stdout, stderr }, null, 2))
        if ((mode === "project-cold-known" || mode === "project-recover-known") && name === "run") expect(await Bun.file(path.join(project, "known-read-committed")).exists()).toBe(true)
        if (name === "enroll" && exit !== 0) {
          const diagnostic = Bun.spawn([executable, "debug", "diagnose-enroll"], { cwd: project,
            env: { ...env, DAC_WORK_PRODUCTION_RESULT: path.join(caseRoot, "enroll-cause.json") }, stdout: "ignore", stderr: "pipe" })
          const diagnosticTimer = setTimeout(() => diagnostic.kill("SIGKILL"), 15000)
          const [status, diagnosticError] = await Promise.all([diagnostic.exited, new Response(diagnostic.stderr).text()]).finally(() => clearTimeout(diagnosticTimer))
          await fs.writeFile(path.join(caseRoot, "enroll-diagnostic.log"), JSON.stringify({ status, stderr: diagnosticError }))
        }
        expect(exit, `${mode}/${name}: ${stderr.slice(-1000)}`).toBe((mode === "count-killed" || mode === "project-command-killed" || (mode === "project-cold-known" || mode === "project-recover-known")) && name === "run" ? 137 : 0)
      }
      const start = observed.length
      if (mode !== "ordinary") {
        await run("enroll", ["operator", "enroll", "--request-id", "enroll", "--policy", policy])
        await run("approve", ["operator", "approve-route", "--target", "review", "--snapshot", modelID, "--request-id", "approve",
          "--expected-revision", "1", "--expected-route-revision", "0", "--expires-at", String(Date.now() + 600_000)])
        expect(observed.length).toBe(start)
      }
      if (mode === "project-command-cold-wake") {
        await run("prepare", ["debug", "prepare"])
        expect(observed.length).toBe(start)
        const { Database } = await import("bun:sqlite")
        const db = new Database(path.join(caseRoot, "file.sqlite"), { readonly: true })
        const identity = db.query<{ request_id: string; group_id: string; loopback_http: number; accept_request_id: string; accept_expected_revision: number }, []>(`SELECT g.request_id,m.group_id,w.loopback_http,g.accept_request_id,g.accept_expected_revision FROM im_task_grant g
          JOIN im_task_request r ON r.request_id=g.request_id JOIN im_task_source s ON s.source_id=r.source_id
          JOIN im_messages m ON m.id=s.message_id JOIN work_execution w ON w.work_id=g.work_id`).get()
        if (!identity) throw new Error("Actual durable task source is missing")
        const before = db.query(`SELECT admission_state,outcome,(SELECT count(*) FROM session_provider_attempt) attempts,
          (SELECT count(*) FROM session_v2_provider_turn_receipt) receipts,(SELECT count(*) FROM work_count_acquisition) counts,
          (SELECT count(*) FROM work_dispatch_reservation) reservations,(SELECT promoted_seq FROM session_input) promoted FROM work_execution`).get()
        expect(before).toEqual({ admission_state: "ready", outcome: "pending", attempts: 0, receipts: 0, counts: 0, reservations: 0, promoted: null })
        // The runtime DB lock permits one process owner. Concurrency below is HTTP exact
        // retries alongside that owner's normal daemon, not two independent DB owners.
        const listeners = await Promise.all([1].map(async () => {
          const reservation = createServer()
          await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve))
          const address = reservation.address()
          if (!address || typeof address === "string") throw new Error("Missing owned port")
          await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()))
          const child = Bun.spawn([executable, "serve", "--hostname", "127.0.0.1", "--port", String(address.port)], {
            cwd: project, env, stdout: "pipe", stderr: "pipe",
          })
          return { child, url: `http://127.0.0.1:${address.port}`, stdout: new Response(child.stdout).text(), stderr: new Response(child.stderr).text(), ready: false }
        }))
        const headers = { authorization: `Basic ${Buffer.from("fixture-operator:fixture-operator-password").toString("base64")}`, "x-deepagent-code-directory": project }
        const read = async (url: string) => {
          const response = await fetch(url, { headers, signal: AbortSignal.timeout(3000) }).catch(() => undefined)
          return response?.ok ? response.json() : undefined
        }
        try {
          const deadline = Date.now() + 75000
          const state: { messages?: { messages: { senderType: string; content: string }[] }; retries?: unknown[] } = {}
          while (!state.messages) {
            for (const listener of listeners) {
              const current = await read(`${listener.url}/api/v1/im/tasks/requests/${identity.request_id}`)
              if (current) listener.ready = true
            }
            if (!state.retries && listeners[0]!.ready) {
              state.retries = await Promise.all(Array.from({ length: 8 }, async () => {
                const response = await fetch(`${listeners[0]!.url}/api/v1/im/tasks/requests/${identity.request_id}/accept`, {
                  method: "POST", headers: { ...headers, "content-type": "application/json" },
                  body: JSON.stringify({ operationID: identity.accept_request_id, expectedRevision: identity.accept_expected_revision }),
                  signal: AbortSignal.timeout(10000),
                })
                const result = { status: response.status, body: await response.json() }
                // Credential verification has a separate bounded concurrency budget. A typed
                // capacity refusal is not a Work retry; retain it without automatic resend.
                expect([200, 503]).toContain(result.status)
                if (result.status === 503) expect(result.body.code).toBe("LOCAL_OPERATOR_UNAVAILABLE")
                return result
              }))
              expect(state.retries.some((retry) => !!retry && typeof retry === "object" && "status" in retry && retry.status === 200)).toBe(true)
            }
            const messages = await read(`${listeners[0]!.url}/api/v1/im/groups/${identity.group_id}/messages?limit=50`)
            if (messages?.messages.some((message: { senderType: string }) => message.senderType === "agent") && listeners.every((listener) => listener.ready)) state.messages = messages
            if (Date.now() >= deadline) throw new Error("Production cold daemon did not return the task reply")
            if (!state.messages) await Bun.sleep(250)
          }
          expect(listeners.every((listener) => listener.ready)).toBe(true)
          expect(state.messages.messages).toHaveLength(2)
          expect(state.messages.messages.find((message) => message.senderType === "agent")?.content).toBe("Reviewed fixed text.")
          expect(observed.slice(start).map((entry) => entry.path)).toEqual(Array.from({ length: 3 }, () => ["/v1/responses/input_tokens", "/v1/responses"]).flat())
          expect(db.query("SELECT admission_state,outcome FROM work_execution").all()).toEqual([{ admission_state: "ready", outcome: "succeeded" }])
          expect(db.query("SELECT status,attempts FROM im_reply_outbox").all()).toEqual([{ status: "delivered", attempts: 1 }])
          expect(db.query("SELECT count(*) count FROM session_input").get()).toEqual({ count: 1 })
          expect(db.query("SELECT count(*) count FROM session_v2_tool_effect").get()).toEqual({ count: 2 })
          expect(db.query("SELECT custody_count,retained_bytes FROM work_command_meter").get()).toEqual({ custody_count: 0, retained_bytes: 0 })
          const published = await fs.readFile(path.join(project, "built.js"))
          expect(hash(published)).toBe(commandOutput(observed[start + 3]!.body).sha256)
          await fs.writeFile(path.join(caseRoot, "cold-wake.json"), JSON.stringify({ before, loopbackHTTP: identity.loopback_http,
            listenerPIDs: listeners.map((listener) => listener.child.pid), retries: state.retries, messages: state.messages,
            work: db.query("SELECT work_id,admission_state,outcome FROM work_execution").all(),
            outbox: db.query("SELECT id,status,attempts FROM im_reply_outbox").all(),
            eventTypes: db.query("SELECT type FROM event WHERE type LIKE 'session.execution.%'").all(),
            providerPaths: observed.slice(start).map((entry) => entry.path) }, null, 2))
        } finally {
          for (const listener of listeners) listener.child.kill("SIGTERM")
          await Promise.all(listeners.map(async (listener, index) => {
            const timer = setTimeout(() => listener.child.kill("SIGKILL"), 5000)
            const [exit, stdout, stderr] = await Promise.all([listener.child.exited, listener.stdout, listener.stderr]).finally(() => clearTimeout(timer))
            await fs.writeFile(path.join(caseRoot, `serve-${index}.log`), JSON.stringify({ exit, stdout, stderr }))
          }))
          db.close()
        }
        const settledCalls = observed.length
        await run("cold", ["debug", "cold"])
        expect(observed.length).toBe(settledCalls)
        await fs.writeFile(path.join(caseRoot, "provider-ledger.json"), JSON.stringify(observed.slice(start), null, 2))
        console.info("WORK_PRODUCTION_CASE", mode, "passed")
        continue
      }
      const staged = ["credential-change", "operator-config-change", "config-change", "route-revoke", "source-revoke"].includes(mode)
      if (staged) {
        await run("prepare", ["debug", "prepare"])
        expect(observed.length).toBe(start)
        if (mode === "credential-change") env.DAC_FIXTURE_NATIVE_KEY = "changed-fixture-key"
        if (mode === "operator-config-change") env.DEEPAGENT_CODE_SERVER_PASSWORD = "changed-fixture-operator-password"
        if (mode === "config-change") await fs.writeFile(path.join(project, "deepagent-code.json"), JSON.stringify({ ...configuration,
          providers: { openai: { ...configuration.providers.openai, name: "Changed current configured source" } } }))
        if (mode === "route-revoke") await run("revoke", ["operator", "revoke-route", "--target", "review", "--request-id", "revoke",
          "--expected-revision", "2", "--expected-route-revision", "1"])
        if (mode === "source-revoke") await run("revoke", ["operator", "revoke", "--request-id", "revoke", "--expected-revision", "2"])
      }
      await run("run", ["debug", mode === "project-command-im-task" ? "im-task" : mode === "ordinary" ? "ordinary" : (mode === "project-cold-known" || mode === "project-recover-known") ? "project-cold-known" : mode === "count-revoked" || mode === "project-count-revoked" || mode === "project-generation-partial" || mode === "project-write-unknown" || mode.startsWith("generation-") ? mode : staged ? "resume" : "run"])
      const ledger = observed.slice(start)
      await fs.writeFile(path.join(caseRoot, "provider-ledger.json"), JSON.stringify(ledger, null, 2))
      const result = mode === "count-killed" || mode === "project-command-killed" || (mode === "project-cold-known" || mode === "project-recover-known") ? undefined : JSON.parse(await fs.readFile(path.join(caseRoot, "run.json"), "utf8"))
      if (mode === "project-command-cancel" || mode === "project-command-killed") {
        expect(ledger.map((row) => row.path)).toEqual(["/v1/responses/input_tokens", "/v1/responses"])
        const { Database } = await import("bun:sqlite")
        const db = new Database(path.join(caseRoot, "file.sqlite"), { readonly: true })
        try {
          const record = db.query<{ record: string }, []>("SELECT record FROM work_command_intent").get()
          if (!record) throw new Error("Actual command intent missing")
          const command = Schema.decodeUnknownSync(Schema.fromJsonString(WorkCommandSchema.Record))(record.record)
          expect(command.releasedAt).toBe(null)
          expect(command.reservedBytes).toBe(WorkCommandSchema.RESERVATION_BYTES)
          expect(db.query<{ count: number }, []>("SELECT count(*) count FROM session_v2_tool_effect WHERE known_command_proof IS NOT NULL").get()?.count).toBe(0)
          expect(db.query<{ custody_count: number }, []>("SELECT custody_count FROM work_command_meter").get()?.custody_count).toBe(1)
          if (mode === "project-command-cancel") {
            expect(command).toMatchObject({ state: "settled", outcome: "cancelled", stopConfirmed: true,
              stdout: { complete: true }, stderr: { complete: true } })
            expect(() => process.kill(command.processID!, 0)).toThrow()
            expect(result.after.pendingTools).toEqual([{ tool_name: "managed_command", effect_kind: "mutating" }])
          } else expect(command).toMatchObject({ state: "dispatching", outcome: null, stopConfirmed: false })
        } finally { db.close() }
      } else if ((mode === "project-cold-known" || mode === "project-recover-known")) {
        expect(ledger.map((row) => row.path)).toEqual(["/v1/responses/input_tokens", "/v1/responses"])
      } else if (mode === "project-generation-partial" || mode === "project-count-revoked" || mode === "project-budget") {
        expect(ledger.map((row) => row.path)).toEqual(mode === "project-generation-partial"
          ? ["/v1/responses/input_tokens", "/v1/responses", "/v1/responses/input_tokens", "/v1/responses"]
          : ["/v1/responses/input_tokens", "/v1/responses", "/v1/responses/input_tokens"])
        expect(result.after.tools).toEqual([{ state: "settled", kind: "read_only", has_proof: 1 }])
        expect(result.after.dispatches[0]).toEqual({ state: "settled", reserved_total_tokens: 16425, charged_tokens: 53 })
        expect(result.after.counts).toHaveLength(2)
        if (mode === "project-generation-partial") {
          expect(result.after.work[0].outcome).toBe("unknown")
          expect(result.after.dispatches[1]).toEqual({ state: "unknown", reserved_total_tokens: 16425, charged_tokens: 16425 })
          expect(result.afterRetry).toEqual(result.after)
        } else {
          expect(result.after.dispatches).toHaveLength(1)
          expect(result.after.work[0].outcome).toBe("pending")
          expect(result.executionCode).toBe(mode === "project-budget" ? "WORK_BUDGET_EXHAUSTED" : "WORK_REVOKED")
        }
      } else if (mode === "project-write-unknown") {
        expect(ledger.map((row) => row.path)).toEqual(Array.from({ length: 2 }, () => ["/v1/responses/input_tokens", "/v1/responses"]).flat())
        expect(ledger.every((row) => row.authenticated)).toBe(true)
        expect(result.executionCode).not.toBe("success")
        expect(result.after.tools).toEqual([{ state: "settled", kind: "read_only", has_proof: 1 }])
        expect(result.after.pendingTools).toEqual([{ tool_name: "write", effect_kind: "mutating" }])
        expect(result.after.dispatches.map((row: { charged_tokens: number }) => row.charged_tokens)).toEqual([53, 53])
        expect(result.after.stages).toHaveLength(1)
        expect(result.after.stages[0]).toMatchObject({ state: "publication_unknown", released_at: null })
        expect(result.after.stages[0].reserved_bytes).toBeGreaterThan(0)
        expect(result.after.meter[0]).toMatchObject({ custody_count: 1, audit_count: 1 })
        expect(result.after.meter[0].retained_bytes).toBeGreaterThan(0)
        expect(await fs.readFile(path.join(project, "approved.txt"), "utf8")).toBe("已验证的原子写入 Native published bytes.\n")
        expect(result.afterRetry).toEqual(result.after)
      } else if (mode === "project-write-permission-revoked") {
        expect(result.executionCode).not.toBe("success")
        expect(result.permissionPauses).toMatchObject([{ action: "edit", decision: "once", revoked: true }])
        expect(result.permissionPauses[0].elapsedMs).toBeGreaterThanOrEqual(1100)
        expect(ledger.map((row) => row.path)).toEqual(Array.from({ length: 2 }, () => ["/v1/responses/input_tokens", "/v1/responses"]).flat())
        expect(result.after.tools).toEqual([{ state: "settled", kind: "read_only", has_proof: 1 }])
        expect(result.after.stages).toEqual([])
        expect(result.after.pendingTools).toEqual([{ tool_name: "write", effect_kind: "mutating" }])
        expect(await fs.readFile(path.join(project, "approved.txt"), "utf8")).toBe("实际批准的原生文件内容 Native approved bytes.\n")
      } else if (mode === "project-write-flag-missing-read") {
        expect(ledger.map((row) => row.path)).toEqual(Array.from({ length: 2 }, () => deepseek ? ["/v1/responses"] : ["/v1/responses/input_tokens", "/v1/responses"]).flat())
        expect(result.executionCode).toBe("success")
        expect(result.authority.result).toBe("succeeded")
        expect(result.after.tools).toEqual([{ state: "settled", kind: "mutating", has_proof: 1 }])
        expect(result.after.stages[0]).toMatchObject({ state: "refused", reserved_bytes: 0, observed_retained_bytes: 0 })
        expect(result.after.pendingTools).toEqual([])
        expect(await fs.readFile(path.join(project, "approved.txt"), "utf8")).toBe("实际批准的原生文件内容 Native approved bytes.\n")
        expect(JSON.stringify(ledger.at(-1)?.body)).toContain("refused before publication")
        expect(result.after.meter).toEqual([{ custody_count: 0, retained_bytes: 0, audit_count: 1 }])
      } else if (mode.startsWith("project-write-")) {
        if (holdPermission) {
          expect(result.permissionPauses).toMatchObject([{ action: "edit", decision: "once", revoked: false }])
          expect(result.permissionPauses[0].elapsedMs).toBeGreaterThanOrEqual(1100)
        }
        expect(ledger.map((row) => row.path)).toEqual(Array.from({ length: 3 }, () => deepseek ? ["/v1/responses"] : ["/v1/responses/input_tokens", "/v1/responses"]).flat())
        expect(result.executionCode).toBe("success")
        expect(result.authority.result).toBe("succeeded")
        expect(result.after.tools).toEqual([{ state: "settled", kind: "read_only", has_proof: 1 }, { state: "settled", kind: "mutating", has_proof: 1 }])
        expect(result.after.dispatches.map((row: { charged_tokens: number }) => row.charged_tokens)).toEqual([53, 53, 53])
        const target = mode === "project-write-create" ? "created.txt" : "approved.txt"
        const refused = mode === "project-write-refused" || mode === "project-write-flag-changed"
        expect(await fs.readFile(path.join(project, target), "utf8")).toBe(refused ? "User's newer version.\n" : "已验证的原子写入 Native published bytes.\n")
        expect(result.after.stages).toHaveLength(1)
        expect(result.after.stages[0]).toMatchObject({ state: refused ? "refused" : "published", reserved_bytes: 0, observed_retained_bytes: 0 })
        expect(result.after.stages[0].released_at).toBeGreaterThan(0)
        expect(result.after.meter).toEqual([{ custody_count: 0, retained_bytes: 0, audit_count: 1 }])
        const body = JSON.stringify(ledger.at(-1)?.body)
        expect(body).toContain(refused ? "refused before publication" : "successfully")
        expect(body).not.toContain("known_write_proof")
        expect(body).not.toContain("dac-work-native-write")
      } else if (mode === "project-command-build" || mode === "project-command-multi" || mode === "project-command-im-task") {
        if (holdPermission) {
          expect(result.permissionPauses).toMatchObject([{ action: "bash", decision: "once", revoked: false }, { action: "edit", decision: "once", revoked: false }])
          expect(result.permissionPauses.every((item: { elapsedMs: number }) => item.elapsedMs >= 1100)).toBe(true)
        }
        expect(ledger.map((row) => row.path)).toEqual(Array.from({ length: 3 }, () => deepseek ? ["/v1/responses"] : ["/v1/responses/input_tokens", "/v1/responses"]).flat())
        expect(ledger.every((row) => row.authenticated)).toBe(true)
        expect(result.authority.result).toBe("succeeded")
        expect(result.after.tools).toEqual([{ state: "settled", kind: "mutating", has_proof: 1 }, { state: "settled", kind: "mutating", has_proof: 1 }])
        expect(result.after.commands).toHaveLength(1)
        expect(result.after.commands[0]).toMatchObject({ state: "settled", outcome: "exited", reserved_bytes: 0, observed_retained_bytes: 0 })
        expect(result.after.commands[0].released_at).toBeGreaterThan(0)
        expect(result.after.commandMeter).toEqual([{ custody_count: 0, retained_bytes: 0, audit_count: 1 }])
        expect(result.after.meter).toEqual([{ custody_count: 0, retained_bytes: 0, audit_count: 1 }])
        const output = commandOutput(ledger[deepseek ? 1 : 3].body)
        const published = await fs.readFile(path.join(project, "built.js"))
        expect(hash(published)).toBe(output.sha256)
        expect(published.byteLength).toBe(output.bytes)
        expect(published.toString()).toContain("42")
        expect(await fs.readFile(path.join(project, "input.ts"), "utf8")).toBe("export const answer: number = 42;\n")
        expect(JSON.stringify(ledger)).not.toContain("known_command_proof")
        expect(JSON.stringify(ledger)).not.toContain("dac-work-native-command-outcome")
        if (mode === "project-command-multi") {
          const retained = JSON.parse(await fs.readFile(path.join(caseRoot, "retained-at-final-provider.json"), "utf8"))
          expect(retained.releasedAt).toBe(null)
          expect(retained.reservedBytes).toBe(WorkCommandSchema.RESERVATION_BYTES)
          expect(retained.meter.custody_count).toBe(1)
          expect(retained.outputs).toHaveLength(2)
          expect(retained.sourceMapHash).toBe(retained.outputs.find((output: { relative: string }) => output.relative === "output.js.map").sha256)
          expect(await fs.readdir(path.join(caseRoot, "data/work-command-stage"))).toEqual([])
        }
      } else if (mode.startsWith("project-")) {
        expect(ledger.map((row) => row.path)).toEqual(["/v1/responses/input_tokens", "/v1/responses", "/v1/responses/input_tokens", "/v1/responses"])
        expect(ledger.every((row) => row.authenticated)).toBe(true)
        expect(result.authority.result).toBe("succeeded")
        expect(result.after.dispatches.map((row: { state: string; charged_tokens: number }) => ({ state: row.state, tokens: row.charged_tokens }))).toEqual([
          { state: "settled", tokens: 53 }, { state: "settled", tokens: 53 },
        ])
        expect(result.after.tools).toHaveLength(1)
        expect(result.after.tools[0]).toMatchObject({ state: "settled", kind: "read_only", has_proof: 1 })
        const second = JSON.stringify(ledger[3].body)
        expect(second).toContain("实际批准的原生文件内容")
        expect(second).not.toContain("known_read_proof")
        expect(second).not.toContain("dac-work-native-leaf-outcome")
      } else if (mode === "happy") {
        expect(ledger.map((row) => row.path)).toEqual(["/v1/responses/input_tokens", "/v1/responses"])
        expect(ledger.every((row) => row.authenticated)).toBe(true)
        expect(result.authority.result).toBe("succeeded")
        expect(result.after.dispatches).toEqual([{ state: "settled", reserved_total_tokens: 4137, charged_tokens: 53 }])
        expect(result.after.activities[0].state).toBe("settled")
      } else if (mode === "ordinary") {
        expect(ledger.map((row) => row.path)).toEqual(["/v1/responses"])
        expect(result.after.work).toEqual([])
        expect(result.after.counts).toEqual([])
      } else if (mode.startsWith("generation-")) {
        expect(ledger.map((row) => row.path)).toEqual(["/v1/responses/input_tokens", "/v1/responses"])
        expect(result.after.work[0].outcome).toBe("unknown")
        expect(result.after.counts[0].state).toBe("settled")
        expect(result.after.dispatches).toEqual([{ state: "unknown", reserved_total_tokens: 4137, charged_tokens: mode === "generation-usage-over" ? 5041 : 4137 }])
        expect(result.after.receipts).toEqual([{ state: mode.startsWith("generation-usage-") ? "settled" : "indeterminate_after_crash" }])
        expect(result.execution).not.toContain("illegal v2 provider receipt transition")
        expect(result.afterRetry).toEqual(result.after)
      } else {
        expect(ledger.map((row) => row.path)).toEqual(staged ? [] : ["/v1/responses/input_tokens"])
        if (result) {
          expect(String(result.executionCode)).toMatch(/^(WORK_|PROFILE_UNAVAILABLE)/)
          expect(result.after.work[0].outcome).toBe("pending")
          expect(result.after.dispatches).toEqual([])
          if (!staged) expect(result.after.counts[0].state).toBe(mode === "count-over" ? "settled" : "unknown")
        }
      }
      if (mode !== "ordinary") {
        const beforeCold = observed.length
        const writeBeforeCold = mode === "project-write-unknown" ? await fs.stat(path.join(project, "approved.txt"), { bigint: true }) : undefined
        await run("cold", ["debug", mode === "project-command-im-task" ? "im-task-cold" : "cold"])
        expect(observed.length).toBe(beforeCold)
        const cold = JSON.parse(await fs.readFile(path.join(caseRoot, "cold.json"), "utf8"))
        if (mode === "project-command-im-task") {
          expect(result.accepted.admission).toBe("ready")
          expect(result.current.execution).toBe("succeeded")
          expect(result.reply.content).toBe("Reviewed fixed text.")
          expect(result.messages.messages).toHaveLength(2)
          expect(result.reply.groupID).toBe(result.messages.messages.find((value: { senderType: string }) => value.senderType === "user").groupID)
          expect(result.outbox).toHaveLength(1)
          expect(result.outbox[0].status).toBe("delivered")
          expect(result.afterRetry).toEqual(result.after)
          expect(cold.accepted.execution).toBe("succeeded")
          expect(cold.messages.messages).toEqual(result.messages.messages)
          expect(cold.after).toEqual(cold.before)
        }
        expect(cold.after.inputs).toEqual(cold.before.inputs)
        if (mode === "project-write-unknown") {
          if (!writeBeforeCold) throw new Error("Missing actual published target identity")
          expect(cold.executionCode).not.toBe("success")
          expect(cold.after).toEqual(cold.before)
          expect(await fs.stat(path.join(project, "approved.txt"), { bigint: true })).toMatchObject({
            dev: writeBeforeCold.dev, ino: writeBeforeCold.ino, size: writeBeforeCold.size,
            mtimeNs: writeBeforeCold.mtimeNs, ctimeNs: writeBeforeCold.ctimeNs,
          })
          expect(await fs.readFile(path.join(project, "approved.txt"), "utf8")).toBe("已验证的原子写入 Native published bytes.\n")
        }
        if ((mode === "project-cold-known" || mode === "project-recover-known")) {
          // Resume does not recover a crashed execution claim. An explicitly authorized
          // known-result recovery contract is separate; no SQL claim clearing in this fixture.
          expect(cold.before.tools).toEqual([{ state: "settled", kind: "read_only", has_proof: 1 }])
          expect(cold.executionCode).toBe("SessionRunner.ExecutionRecoveryRequiredError")
          expect(cold.after).toEqual(cold.before)
        }
        expect(cold.after.counts).toEqual(cold.before.counts)
        expect(cold.after.dispatches).toEqual(cold.before.dispatches)
        if (mode === "count-unknown" && process.env.DAC_WORK_IM_COLD_UNKNOWN === "1") {
          const { Database } = await import("bun:sqlite")
          const db = new Database(path.join(caseRoot, "file.sqlite"), { readonly: true })
          const task = db.query<{ request_id: string }, []>("SELECT request_id FROM im_task_grant").get()
          if (!task) throw new Error("Unknown task grant missing")
          const before = db.query(`SELECT (SELECT count(*) FROM event) events,(SELECT count(*) FROM session_input) inputs,
            (SELECT count(*) FROM session_provider_attempt) attempts,(SELECT count(*) FROM work_count_acquisition) counts,
            (SELECT count(*) FROM work_dispatch_reservation) reservations,(SELECT count(*) FROM im_reply_outbox) replies`).get()
          const reservation = createServer()
          await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve))
          const address = reservation.address()
          if (!address || typeof address === "string") throw new Error("Missing owned port")
          await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()))
          const child = Bun.spawn([executable, "serve", "--hostname", "127.0.0.1", "--port", String(address.port)], { cwd: project, env, stdout: "pipe", stderr: "pipe" })
          const stdout = new Response(child.stdout).text()
          const stderr = new Response(child.stderr).text()
          try {
            const deadline = Date.now() + 15000
            const state: { view?: { execution: string } } = {}
            while (!state.view) {
              const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/im/tasks/requests/${task.request_id}`, {
                headers: { authorization: `Basic ${Buffer.from("fixture-operator:fixture-operator-password").toString("base64")}`, "x-deepagent-code-directory": project },
                signal: AbortSignal.timeout(3000),
              }).catch(() => undefined)
              if (response?.ok) state.view = await response.json()
              if (Date.now() >= deadline) throw new Error("Cold unknown observation unavailable")
              if (!state.view) await Bun.sleep(100)
            }
            expect(state.view.execution).toBe("recovery_required")
            // Two real production reconcile intervals; this wait tests the no-replay boundary.
            await Bun.sleep(11000)
            expect(observed.length).toBe(beforeCold)
            const after = db.query(`SELECT (SELECT count(*) FROM event) events,(SELECT count(*) FROM session_input) inputs,
              (SELECT count(*) FROM session_provider_attempt) attempts,(SELECT count(*) FROM work_count_acquisition) counts,
              (SELECT count(*) FROM work_dispatch_reservation) reservations,(SELECT count(*) FROM im_reply_outbox) replies`).get()
            expect(after).toEqual(before)
            expect(db.query("SELECT state FROM work_count_acquisition").all()).toEqual([{ state: "unknown" }])
            await fs.writeFile(path.join(caseRoot, "unknown-cold-daemon.json"), JSON.stringify({ before, after, view: state.view,
              providerCallsBefore: beforeCold, providerCallsAfter: observed.length, observedReconcileMs: 11000 }))
          } finally {
            child.kill("SIGTERM")
            const timer = setTimeout(() => child.kill("SIGKILL"), 5000)
            const logs = await Promise.all([child.exited, stdout, stderr]).finally(() => clearTimeout(timer))
            await fs.writeFile(path.join(caseRoot, "unknown-serve.log"), JSON.stringify(logs))
            db.close()
          }
        }
        if (mode === "count-killed") {
          expect(cold.before.counts[0].state).toBe("sending")
          expect(cold.before.dispatches).toEqual([])
          expect(cold.after.work[0].outcome).toBe("pending")
        }
        if (mode === "project-recover-known") {
          await run("before-recovery", ["debug", "observe"])
          const before = JSON.parse(await fs.readFile(path.join(caseRoot, "before-recovery.json"), "utf8"))
          const identity = JSON.parse(await fs.readFile(path.join(project, "work-identity.json"), "utf8"))
          const claim = before.recovery.claims.find((entry: { id: string }) => entry.id === identity.sessionID)
          expect(claim.token).toBeGreaterThan(0)
          const expiry = Math.max(...before.recovery.leases.filter((entry: { released_at: number | null }) => entry.released_at === null)
            .map((entry: { lease_expires_at: number }) => entry.lease_expires_at), 0)
          // Wait the actual old lease; no SQL owner reset or fabricated recovery claim.
          if (expiry >= Date.now()) await Bun.sleep(expiry - Date.now() + 5)
          const args = ["im", "work", "recover-known", identity.workID, "--session-id", identity.sessionID,
            "--request-id", "recover-known", "--expected-claim-token", String(claim.token), "--expected-control-revision", "1"]
          await run("recover", args)
          await run("recover-exact", args)
          expect(observed.length).toBe(beforeCold)
          const receipt = JSON.parse(JSON.parse(await fs.readFile(path.join(caseRoot, "recover.log"), "utf8")).stdout.trim())
          const retried = JSON.parse(JSON.parse(await fs.readFile(path.join(caseRoot, "recover-exact.log"), "utf8")).stdout.trim())
          expect(receipt.receipt.replayed).toBe(false)
          expect(receipt.execution).toBe("not_started")
          expect(retried.receipt.replayed).toBe(true)
          await run("after-recovery", ["debug", "observe"])
          const recovered = JSON.parse(await fs.readFile(path.join(caseRoot, "after-recovery.json"), "utf8"))
          expect(recovered.after).toEqual(before.after)
          expect(recovered.recovery.claims).toEqual([{ id: identity.sessionID, token: null }])
          expect(recovered.recovery.receipts).toHaveLength(1)
          expect(recovered.recovery.resumes).toEqual([])
          await run("recovered-unprivileged-cold", ["debug", "cold"])
          const unprivileged = JSON.parse(await fs.readFile(path.join(caseRoot, "recovered-unprivileged-cold.json"), "utf8"))
          expect(unprivileged.executionCode).toBe("WORK_RECOVERY_REQUIRED")
          expect(unprivileged.after).toEqual(unprivileged.before)
          expect(observed.length).toBe(beforeCold)
          const resume = ["im", "work", "resume-recovered", receipt.receipt.recoveryID,
            "--request-id", "explicit-continue", "--expected-control-revision", "1"]
          await run("continue", resume)
          const continuation = JSON.parse(JSON.parse(await fs.readFile(path.join(caseRoot, "continue.log"), "utf8")).stdout.trim())
          expect(continuation.execution).toBe("drained")
          expect(observed.slice(start).map((entry) => entry.path)).toEqual([
            "/v1/responses/input_tokens", "/v1/responses", "/v1/responses/input_tokens", "/v1/responses",
          ])
          await run("continue-exact", resume)
          await run("recovered-cold", ["debug", "cold"])
          expect(observed.length).toBe(beforeCold + 2)
          const final = JSON.parse(await fs.readFile(path.join(caseRoot, "recovered-cold.json"), "utf8"))
          expect(final.after.work[0].outcome).toBe("succeeded")
          expect(final.after.dispatches.map((entry: { charged_tokens: number }) => entry.charged_tokens)).toEqual([53, 53])
          expect(final.after.tools).toEqual([{ state: "settled", kind: "read_only", has_proof: 1 }])
          expect(final.after).toEqual(final.before)
          expect(JSON.stringify(observed.at(-1)!.body)).toContain("实际批准的原生文件内容")
          expect(JSON.stringify(observed.at(-1)!.body)).not.toContain("known_read_proof")
        }
        if (mode === "happy" || mode === "project-two-turn" || mode.startsWith("project-write-")) expect(cold.after).toEqual(cold.before)
      }
      console.info("WORK_PRODUCTION_CASE", mode, "passed")
    }
  } finally {
    await fs.writeFile(path.join(root, "provider-ledger.json"), JSON.stringify(observed, null, 2))
    provider.stop(true)
  }
}, 360_000)

/** Read the actual Responses tool-output input. Fixture code cannot mint an output
 * reference from predicted admission IDs or filesystem hashes. */
function commandOutput(body: unknown): WorkCommandSchema.OutputReference {
  const found: WorkCommandSchema.OutputReference[] = []
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(value)
      if (parsed._tag === "Some" && typeof parsed.value === "object" && parsed.value !== null) visit(parsed.value)
      return
    }
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (typeof value !== "object" || value === null) return
    const output = Schema.decodeUnknownOption(WorkCommandSchema.OutputReference)(value)
    if (output._tag === "Some") { found.push(output.value); return }
    Object.values(value).forEach(visit)
  }
  visit(body)
  const selected = found.filter((output) => output.relative === "output.js")
  if (selected.length !== 1) throw new Error(`Actual command output reference count: ${selected.length}`)
  return selected[0]!
}
