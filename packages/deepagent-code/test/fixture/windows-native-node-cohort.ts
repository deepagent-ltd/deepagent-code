export * as WindowsNativeNodeCohort from "./windows-native-node-cohort"

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash, createPrivateKey, createPublicKey } from "node:crypto"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { NativeInstallationSchema } from "../../src/installation/native-installation.schema"
import { nativeNodeDefines } from "../../script/build-native-node"
import { buildWindowsNativeBootstrap, signWindowsNativeSidecar, withWindowsNativePublisherHost } from "../../script/build-windows-native-bootstrap"
import { prepareTestNativePublisher } from "../../../desktop/scripts/test-native-publisher"

const repository = path.resolve(import.meta.dir, "../../../..")
const mainEntry = path.join(import.meta.dir, "windows-native-node-main.ts")
const sidecarEntry = path.join(import.meta.dir, "windows-native-node-sidecar.ts")
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** A test-only publisher and the original desktop-sidecar protocol. No capture,
 * Current reference, DPAPI codec or production owner material is injected. */
export async function build(input: { directory: string; nodeEntry: string }) {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch))
    throw new Error("The Native Node cohort requires its actual Windows target")
  assert(path.isAbsolute(input.directory) && path.isAbsolute(input.nodeEntry))
  const directory = await fs.realpath(input.directory)
  assert.equal(path.win32.parse(directory).root.toUpperCase(), "D:\\", "Native fixture builds must stay on D:")
  const relative = path.relative(repository, directory)
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative))
    assert.equal(Bun.spawnSync(["git", "check-ignore", "--quiet", relative], { cwd: repository }).exitCode, 0)
  const toolchain = await captureToolchain()
  const environmentFile = path.join(directory, `.native-cohort-environment-${crypto.randomUUID()}`)
  await fs.writeFile(environmentFile, "", { flag: "wx", mode: 0o600 })
  const publisher = await prepareTestNativePublisher({
    runnerTemp: directory, environmentFile, target: `win32-${process.arch}`, releaseID: "owned-native-mcp-probe",
  })
  const root = publisher.directory
  const privateInput = path.join(root, ".private-build-input.json")
  try {
    await fs.writeFile(privateInput, JSON.stringify({ root, nodeEntry: input.nodeEntry,
      privateKeyFile: publisher.privateKeyFile, publicKeyFile: publisher.publicKeyFile, toolchain }), { flag: "wx", mode: 0o600 })
    const built = await execute([process.execPath, fileURLToPath(import.meta.url), privateInput], root,
      { ...environment(root, toolchain.rustupHome), DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY: publisher.publicKeyFile }, "build", 230_000)
    assert.equal(built.code, 0, `Native cohort build failed: ${JSON.stringify(built)}`)
  } catch (error) {
    console.error("WINDOWS_NATIVE_COHORT_BUILD_FAILURE", JSON.stringify({ root, phases: await phases(root) }))
    throw error
  } finally {
    await Promise.all([privateInput, environmentFile, publisher.privateKeyFile].map((file) => fs.rm(file, { force: true })))
  }
  return {
    root,
    main: path.join(root, "main", "main.js"),
    module: path.join(root, "main", "chunks", "node.js"),
    async run(mode = "probe") {
      const metadata = await Bun.file(path.join(root, "cohort.json")).json() as { runtime: string }
      return execute([metadata.runtime, path.join(root, "main", "main.js"), mode], root, environment(root, toolchain.rustupHome), "runtime", 60_000)
    },
    async dispose() {
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

/** Query the usable runner toolchain before replacing its profile environment.
 * These commands neither install Rust nor change its default configuration. */
export async function captureToolchain() {
  const query = async (command: string[], env = process.env) => {
    const child = Bun.spawn(command, { cwd: path.join(repository, "packages/work-file-helper"), env,
      stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const state = { timedOut: false }
    const timer = setTimeout(() => { state.timedOut = true; child.kill("SIGKILL") }, 15_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      assert(!state.timedOut && code === 0, `Original toolchain query failed (${command.join(" ")}): ${JSON.stringify({ code, timedOut: state.timedOut, stderr: stderr.slice(-2048) })}`)
      return stdout.trim()
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
    }
  }
  const rustupHome = await fs.realpath(await query(["rustup", "show", "home"]))
  assert(path.isAbsolute(rustupHome))
  const env = { ...process.env, RUSTUP_HOME: rustupHome }
  const cargo = await fs.realpath(await query(["rustup", "which", "cargo"], env))
  const rustc = await fs.realpath(await query(["rustup", "which", "rustc"], env))
  const cargoVersion = await query([cargo, "--version"], env)
  const rustcVersion = await query([rustc, "--version"], env)
  assert.equal(await query(["cargo", "--version"], env), cargoVersion)
  assert.equal(await query(["rustc", "--version"], env), rustcVersion)
  return { rustupHome, cargo, rustc, cargoVersion, rustcVersion,
    activeToolchain: await query(["rustup", "show", "active-toolchain"], env) }
}

async function assemble(input: { root: string; nodeEntry: string; privateKeyFile: string; publicKeyFile: string;
  toolchain: Awaited<ReturnType<typeof captureToolchain>> }) {
  const chunks = path.join(input.root, "main", "chunks")
  await fs.mkdir(chunks, { recursive: true })
  await fs.writeFile(path.join(path.dirname(chunks), "package.json"), JSON.stringify({ type: "module" }), { flag: "wx" })
  await phase(input.root, "build-native-start")
  const bootstrap = await buildWindowsNativeBootstrap({ repository, staging: chunks,
    publicKey: await fs.readFile(input.publicKeyFile, "utf8") })
  await phase(input.root, "build-native-complete")
  const cargoDirectory = path.join(chunks, "native-bootstrap-cargo")
  const helper = Bun.spawn(["cargo", "build", "--locked", "--release", "--bin", "deepagent-work-file-helper"], {
    cwd: path.join(repository, "packages/work-file-helper"),
    env: { ...process.env, CARGO_TARGET_DIR: cargoDirectory, DAC_NATIVE_PRELOADER_PUBLISHER_HEX: bootstrap.publisherPin },
    stdin: "ignore", stdout: "inherit", stderr: "inherit",
  })
  assert.equal(await helper.exited, 0)
  const helperName = "deepagent-work-file-helper.exe"
  await fs.copyFile(path.join(cargoDirectory, "release", helperName), path.join(chunks, helperName))
  const helperBytes = await fs.readFile(path.join(chunks, helperName))
  const defines = await nativeNodeDefines({ repository, destination: chunks,
    helper: { path: `packages/work-file-helper/bin/win32-${process.arch}/${helperName}`,
      bytes: helperBytes.length, sha256: digest(helperBytes) },
    assets: [bootstrap, ...bootstrap.assets, ...bootstrap.licenses],
  })
  const original = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.fromJsonString(NativeInstallationSchema.Components)))(
    defines.DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST!,
  )
  const fixtures = await Promise.all([mainEntry, sidecarEntry, input.nodeEntry, fileURLToPath(import.meta.url),
    path.join(repository, "packages/deepagent-code/test/mcp/windows-native-cohort.test.ts")].map(async (file) => {
    const relative = path.relative(repository, file).replaceAll("\\", "/")
    assert(relative.startsWith("packages/deepagent-code/test/") && !relative.split("/").includes(".."))
    const bytes = await fs.readFile(file)
    return new NativeInstallationSchema.Component({ path: relative, bytes: bytes.length, sha256: digest(bytes) })
  }))
  const components = new NativeInstallationSchema.Components({ ...original,
    components: [...original.components, ...fixtures].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  })
  const text = CanonicalJson.stringify(components)
  assert(Buffer.byteLength(text) <= NativeInstallationSchema.COMPONENTS_LIMIT)
  await fs.writeFile(path.join(chunks, "node.js.native-components.json"), text)
  const compiled = await Bun.build({
    entrypoints: [input.nodeEntry], outdir: chunks, naming: "node.js", target: "node", format: "esm",
    external: ["@lydell/node-pty", "jsonc-parser", "bun"],
    define: { ...defines, DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST: JSON.stringify(text) },
    files: { "deepagent-code-web-ui.gen.ts": "" },
  })
  assert(compiled.success, compiled.logs.map((item) => item.message).join("\n"))
  for (const entry of components.components.filter((entry) => !entry.path.startsWith("packages/work-file-helper/bin/")))
    assert.equal(digest(await fs.readFile(path.join(repository, entry.path))), entry.sha256, "A captured build source changed")
  const desktop = createRequire(path.join(repository, "packages/desktop/package.json"))
  const runtime = await fs.realpath(desktop("electron") as string)
  const nodeModule = path.join(chunks, "node.js")
  await phase(input.root, "physical-publisher-start")
  await withWindowsNativePublisherHost(nodeModule, async (host) => {
    const issued = await execute([host, path.join(repository, "packages/deepagent-code/script/sign-native-node.ts"),
      "--module", nodeModule, "--runtime", runtime, "--key", input.privateKeyFile,
      "--release", "owned-native-mcp-probe"], input.root, environment(input.root, input.toolchain.rustupHome), "publisher", 60_000)
    assert.equal(issued.code, 0, `Physical Node publisher failed: ${JSON.stringify(issued)}`)
  })
  for (const entry of [mainEntry, sidecarEntry]) {
    const built = await Bun.build({ entrypoints: [entry], outdir: path.dirname(chunks), target: "node", format: "esm",
      naming: entry === mainEntry ? "main.js" : "sidecar.js", external: ["electron"] })
    assert(built.success, built.logs.map((item) => item.message).join("\n"))
  }
  const receipt = await signWindowsNativeSidecar({ mainDirectory: path.dirname(chunks),
    privateKey: createPrivateKey(await fs.readFile(input.privateKeyFile)), bootstrapHash: bootstrap.sha256,
    publisherPin: bootstrap.publisherPin })
  await fs.writeFile(path.join(input.root, "cohort.json"), JSON.stringify({ runtime, target: components.target,
    sourceCommit: components.sourceCommit, sourceTree: components.sourceTree, inputs: components.components.length,
    componentsHash: digest(Buffer.from(text)), nodeSha256: digest(await fs.readFile(nodeModule)),
    bootstrapSha256: bootstrap.sha256, preloaderSha256: receipt.sha256,
    signerHash: digest(createPublicKey(await fs.readFile(input.publicKeyFile)).export({ type: "spki", format: "der" })),
    productionOwnerMaterial: false, toolchain: input.toolchain,
  }))
  await phase(input.root, "physical-cohort-sealed")
}

function environment(root: string, rustupHome: string) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/^(?:DEEPAGENT_|DAC_|XDG_|BUN_OPTIONS$|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$)/i.test(name))),
    HOME: path.join(root, "profile"), USERPROFILE: path.join(root, "profile"),
    APPDATA: path.join(root, "profile", "appdata"), LOCALAPPDATA: path.join(root, "profile", "localappdata"),
    TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"),
    XDG_DATA_HOME: path.join(root, "data"), XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    RUSTUP_HOME: rustupHome, CARGO_HOME: path.join(root, "cargo-cache"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(root, "bun-cache"),
    DEEPAGENT_CODE_TEST_HOME: root, DEEPAGENT_CODE_HOME: path.join(root, "data"),
    DAC_NATIVE_NODE_COHORT_ROOT: root,
  }
}

async function execute(command: string[], root: string, env: Record<string, string | undefined>, name: string, milliseconds: number) {
  for (const directory of ["profile", "profile/appdata", "profile/localappdata", "profile/electron-user", "profile/electron-session",
    "tmp", "data", "config", "cache", "state"])
    await fs.mkdir(path.join(root, directory), { recursive: true })
  const started = Date.now()
  const child = Bun.spawn(command, { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const drain = async (stream: ReadableStream<Uint8Array>, file: string) => {
    const output = { text: "" }
    const reader = stream.getReader()
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        output.text = (output.text + Buffer.from(chunk.value).toString()).slice(-16_384)
        await fs.appendFile(path.join(root, file), chunk.value)
      }
    } finally {
      reader.releaseLock()
    }
    return output.text
  }
  const output = Promise.all([drain(child.stdout, `${name}-stdout.log`), drain(child.stderr, `${name}-stderr.log`)])
  const stopped = { promise: undefined as Promise<void> | undefined }
  const stop = () => stopped.promise ??= (async () => {
    if (child.exitCode !== null) return
    try {
      if (process.platform === "win32") {
        const tree = Bun.spawn([path.win32.join(process.env.SystemRoot!, "System32", "taskkill.exe"),
          "/PID", String(child.pid), "/T", "/F"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
        await tree.exited
      }
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
    }
  })()
  const timer = setTimeout(() => { void stop() }, milliseconds)
  try {
    const code = await child.exited
    const logs = await output
    return { code, stdout: logs[0]!, stderr: logs[1]!, milliseconds: Date.now() - started, phases: await phases(root) }
  } finally {
    clearTimeout(timer)
    await stop()
    await child.exited
    await output
  }
}

async function phase(root: string, name: string) {
  await fs.appendFile(path.join(root, "phases.jsonl"), `${JSON.stringify({ phase: name, at: Date.now() })}\n`)
}

async function phases(root: string) {
  return fs.readFile(path.join(root, "phases.jsonl"), "utf8").then((value) => value.trim().split("\n"), () => [])
}

if (import.meta.main) {
  const input = await Bun.file(process.argv[2]!).json() as Parameters<typeof assemble>[0]
  await assemble(input)
}
