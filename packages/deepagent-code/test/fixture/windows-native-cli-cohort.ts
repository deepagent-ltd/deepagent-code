export * as WindowsNativeCliCohort from "./windows-native-cli-cohort"

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash, sign } from "node:crypto"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { NativeInstallationSchema } from "../../src/installation/native-installation.schema"
import { nativeNodeDefines } from "../../script/build-native-node"
import { buildWindowsNativeBootstrap, withWindowsNativePublisherHost } from "../../script/build-windows-native-bootstrap"
import { signWindowsNativeCLI } from "../../script/sign-windows-native-cli"
import { prepareTestNativePublisher, verifyNativePublisherKeys, verifyTestNativeReceipt, verifyTestWindowsCLIPreloader } from "../../../desktop/scripts/test-native-publisher"
import { captureToolchain } from "./windows-native-node-cohort"

const repository = path.resolve(import.meta.dir, "../../../..")
const host = path.join(repository, "packages/deepagent-code")
const source = fileURLToPath(import.meta.url)
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const runtimeLimit = 27 * 30_000 + 30_000

/** The production compiled launcher owns its original child receipt. Only its
 * business import is replaced; Native ports, storage and codecs stay original. */
export async function build(input: {
  directory: string
  businessEntry: string
  extraSources?: string[]
  plugins?: Bun.BunPlugin[]
  manifestVariants?: (payload: NativeInstallationSchema.Payload) => Record<string, NativeInstallationSchema.Payload>
}) {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch))
    throw new Error("The Native CLI cohort requires its actual Windows target")
  const deadline = Date.now() + 230_000
  assert(path.isAbsolute(input.directory) && path.isAbsolute(input.businessEntry))
  const directory = await fs.realpath(input.directory)
  assert.equal(path.win32.parse(directory).root.toUpperCase(), "D:\\", "Native fixture builds must stay on D:")
  const relative = path.relative(repository, directory)
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative))
    assert.equal(Bun.spawnSync(["git", "check-ignore", "--quiet", relative], { cwd: repository }).exitCode, 0)
  const businessEntry = await fs.realpath(input.businessEntry)
  assert(path.relative(host, businessEntry).startsWith(`test${path.sep}`))
  const toolchain = await captureToolchain()
  const environmentFile = path.join(directory, `.native-cli-environment-${crypto.randomUUID()}`)
  await fs.writeFile(environmentFile, "", { flag: "wx", mode: 0o600 })
  const publisher = await prepareTestNativePublisher({ runnerTemp: directory, environmentFile,
    target: `win32-${process.arch}`, releaseID: "owned-native-cli-cohort" }).catch(async (error: unknown) => {
    await fs.rm(environmentFile, { force: true })
    throw error
  })
  const root = publisher.directory
  const executable = path.join(root, "deepagent-code.exe")
  const privateInput = path.join(root, ".native-cli-build-input.json")
  const remaining = () => {
    const milliseconds = deadline - Date.now()
    assert(milliseconds > 0, "Native CLI cohort build deadline exceeded")
    return milliseconds
  }
  try {
    await prepareDirectories(root)
    await fs.writeFile(privateInput, JSON.stringify({ root, publicKeyFile: publisher.publicKeyFile }), { flag: "wx", mode: 0o600 })
    const assets = await execute([process.execPath, source, privateInput], root,
      { ...environment(root, toolchain.rustupHome), DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY: publisher.publicKeyFile,
        PATH: `${path.dirname(toolchain.cargo)}${path.delimiter}${process.env.PATH ?? ""}`, RUSTC: toolchain.rustc,
        RUSTUP_AUTO_INSTALL: "0" },
      "assets", remaining())
    assert.equal(assets.code, 0, `Native CLI assets failed: ${JSON.stringify(assets)}`)
    assert.equal(assets.timedOut, false)
    const defines = await Bun.file(path.join(root, "native-build-defines.json")).json() as Record<string, string>
    assert.equal(defines.DEEPAGENT_CODE_NATIVE_RUNTIME_PUBLIC_KEY, JSON.stringify(await fs.readFile(publisher.publicKeyFile, "utf8")))
    const original = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.fromJsonString(NativeInstallationSchema.Components)))(
      defines.DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST!,
    )
    const helpers = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard",
      "packages/deepagent-code/test/lib", "packages/deepagent-code/test/fixture",
      "packages/core/test/fixture", "packages/core/test/lib"], { cwd: repository, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    assert.equal(helpers.exitCode, 0, "Native CLI fixture dependency inventory is unavailable")
    assert(!(input.plugins?.length || input.manifestVariants) || input.extraSources?.length,
      "Plugin and negative-manifest implementation sources must enter the Native fixture inventory")
    const additional = await Promise.all([source, businessEntry,
      path.join(import.meta.dir, "windows-native-node-cohort.ts"),
      path.join(repository, "packages/desktop/scripts/test-native-publisher.ts"),
      ...helpers.stdout.toString().trim().split("\n").filter(Boolean).map((file) => path.join(repository, file)),
      ...(input.extraSources ?? []).map((file) => path.resolve(repository, file)),
    ].map(async (file) => {
      const current = await fs.realpath(file)
      const relative = path.relative(repository, current).replaceAll("\\", "/")
      assert(relative.startsWith("packages/") && !relative.split("/").includes(".."))
      const bytes = await fs.readFile(current)
      return new NativeInstallationSchema.Component({ path: relative, bytes: bytes.length, sha256: hash(bytes) })
    }))
    const entries = new Map(original.components.map((entry) => [entry.path, entry]))
    for (const entry of additional) {
      const prior = entries.get(entry.path)
      assert(!prior || prior.bytes === entry.bytes && prior.sha256 === entry.sha256, "Captured Native fixture source changed")
      entries.set(entry.path, entry)
    }
    const components = new NativeInstallationSchema.Components({ ...original,
      components: [...entries.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) })
    const text = CanonicalJson.stringify(components)
    assert(Buffer.byteLength(text) <= NativeInstallationSchema.COMPONENTS_LIMIT)
    const index = path.join(host, "src/index.ts")
    remaining()
    const compiled = await Bun.build({
      entrypoints: [path.join(host, "src/windows-cli.ts")], tsconfig: path.join(host, "tsconfig.json"),
      conditions: ["node"], target: "bun", format: "esm", splitting: true, external: ["node-gyp"],
      compile: { outfile: executable, autoloadDotenv: false, autoloadBunfig: false, execArgv: ["--use-system-ca", "--"] },
      define: { ...defines, DEEPAGENT_CODE_NATIVE_NODE_ARTIFACT: "false",
        DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST: JSON.stringify(text),
        DEEPAGENT_CODE_VERSION: JSON.stringify("2.0.5-dev"), DEEPAGENT_CODE_CHANNEL: JSON.stringify("dev") },
      files: { "deepagent-code-web-ui.gen.ts": "" },
      plugins: [{ name: "owned-native-cli-business-entry", setup(builder) {
        builder.onLoad({ filter: /[/\\]src[/\\]index\.ts$/ }, (args) => {
          if (path.resolve(args.path) !== index) return undefined
          return { contents: `try {
  await import(${JSON.stringify(businessEntry)})
} catch (error) {
  try {
    const observedTag = error instanceof Error ? error.name : undefined
    const observedCode = error && typeof error === "object" && "code" in error ? error.code : undefined
    const tag = typeof observedTag === "string" && /^[A-Za-z][A-Za-z0-9_.]{0,63}$/.test(observedTag) ? observedTag : "unknown"
    const code = typeof observedCode === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(observedCode) ? observedCode : "UNCLASSIFIED"
    const message = new TextDecoder().decode(Buffer.from(error instanceof Error ? error.message
      : typeof error === "string" ? error : "Non-Error rejection").subarray(0, 2048), { stream: true })
    console.error(JSON.stringify({ stage: "owned-native-business-import", tag, code, message }))
  } finally {
    throw error
  }
}
`, loader: "ts" }
        })
      } }, ...(input.plugins ?? [])],
    })
    assert(compiled.success, compiled.logs.map((item) => item.message).join("\n"))
    await fs.writeFile(`${executable}.native-components.json`, text, { flag: "wx" })
    await fs.rm(path.join(root, "node.js.native-components.json"), { force: true })
    for (const entry of components.components.filter((entry) => !entry.path.startsWith("packages/work-file-helper/bin/")))
      assert.equal(hash(await fs.readFile(path.join(repository, entry.path))), entry.sha256, "A captured Native build source changed")
    const keys = await verifyNativePublisherKeys(publisher.privateKeyFile, publisher.publicKeyFile)
    const issued = await withWindowsNativePublisherHost(executable, (compiler) => execute([
      compiler, path.join(host, "script/sign-native-node.ts"), "--cli", "--module", executable, "--runtime", executable,
      "--key", publisher.privateKeyFile, "--release", "owned-native-cli-cohort",
    ], root, environment(root, toolchain.rustupHome), "publisher", Math.min(60_000, remaining())))
    assert.equal(issued.code, 0, `Physical Native CLI publisher failed: ${JSON.stringify(issued)}`)
    assert.equal(issued.timedOut, false)
    const signed = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
      payload: NativeInstallationSchema.Payload, signerHash: Schema.String,
    })), { onExcessProperty: "error" })(issued.stdout)
    const preloader = await signWindowsNativeCLI({ executable, privateKey: keys.privateKey })
    assert.equal(signed.signerHash, keys.signerHash)
    assert.equal(preloader.signerHash, keys.signerHash)
    assert.equal(signed.payload.componentsHash, hash(text))
    assert.equal(signed.payload.target, components.target)
    await verifyTestNativeReceipt({ executable, target: components.target, releaseID: "owned-native-cli-cohort",
      publicKeyFile: publisher.publicKeyFile })
    await verifyTestWindowsCLIPreloader({ executable, target: components.target, publicKeyFile: publisher.publicKeyFile })
    const variantInput = new NativeInstallationSchema.Payload({ ...signed.payload,
      executable: new NativeInstallationSchema.Executable({ ...signed.payload.executable }) })
    Object.freeze(variantInput.executable)
    Object.freeze(variantInput)
    const variants = Object.entries(input.manifestVariants?.(variantInput) ?? {})
    assert(variants.length <= 6, "Only the original bounded installation mismatch vectors are accepted")
    const manifests = Object.fromEntries(variants.map(([name, value]) => {
      assert(["signature", "components", "commit", "target", "binary", "size"].includes(name))
      const payload = Schema.decodeUnknownSync(NativeInstallationSchema.Payload, { onExcessProperty: "error" })(value)
      const expected = new NativeInstallationSchema.Payload({ ...signed.payload,
        ...(name === "components" ? { componentsHash: payload.componentsHash } : {}),
        ...(name === "commit" ? { sourceCommit: payload.sourceCommit } : {}),
        ...(name === "target" ? { target: payload.target } : {}),
        ...(name === "binary" ? { executable: new NativeInstallationSchema.Executable({ ...signed.payload.executable,
          sha256: payload.executable.sha256 }) } : {}),
        ...(name === "size" ? { executable: new NativeInstallationSchema.Executable({ ...signed.payload.executable,
          bytes: payload.executable.bytes }) } : {}),
      })
      assert.equal(CanonicalJson.stringify(payload), CanonicalJson.stringify(expected), "Installation negative must change only its declared field")
      assert(name === "signature" || CanonicalJson.stringify(payload) !== CanonicalJson.stringify(signed.payload))
      return [name, CanonicalJson.stringify(new NativeInstallationSchema.Manifest({ payload,
        signature: sign(null, Buffer.from(CanonicalJson.stringify(payload)), keys.privateKey).toString("hex") }))]
    }))
    await fs.writeFile(path.join(root, "negative-manifests.json"), JSON.stringify(manifests))
    remaining()
    await fs.writeFile(path.join(root, "cohort.json"), JSON.stringify({ target: components.target,
      sourceCommit: components.sourceCommit, sourceTree: components.sourceTree, componentsHash: hash(text),
      executable: signed.payload.executable, signerHash: keys.signerHash, preloaderReceiptHash: preloader.receiptHash,
      toolchain, productionOwnerMaterial: false }))
    const state = { disposed: false, counter: 0, stops: new Set<() => Promise<void>>(), runs: new Set<Promise<unknown>>() }
    const invocation = async (input: { args?: string[]; env?: Record<string, string>; inheritEnvironment?: boolean; cwd?: string } = {}) => {
      assert(!state.disposed, "Native CLI cohort is disposed")
      assert((input.args ?? []).length <= 64 && (input.args ?? []).every((arg) => arg.length <= 8192 && !arg.includes("\0")))
      const env: Record<string, string | undefined> = environment(root, toolchain.rustupHome, input.inheritEnvironment !== false)
      for (const [name, value] of Object.entries(input.env ?? {})) {
        assert(/^[a-zA-Z_][a-zA-Z0-9_()]*$/.test(name) && !value.includes("\0"))
        const key = Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase()) ?? name.toUpperCase()
        env[key] = value
      }
      for (const name of ["DEEPAGENT_CODE_V2_OWNER_CAMPAIGN", "DEEPAGENT_CODE_V2_OWNER_PUBLIC_KEY"])
        assert(!env[name], "Formal owner material is not accepted by this test cohort")
      for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TEMP", "TMP",
        "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "CARGO_HOME",
        "BUN_RUNTIME_TRANSPILER_CACHE_PATH", "DEEPAGENT_CODE_TEST_HOME", "DEEPAGENT_CODE_HOME",
        "DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR"]) {
        if (!env[name]) continue
        await requireOwnedDirectory(root, env[name]!)
      }
      assert.equal(env.RUSTUP_HOME, toolchain.rustupHome)
      if (env.DEEPAGENT_CODE_DB && env.DEEPAGENT_CODE_DB !== ":memory:")
        await requireOwnedDirectory(root, path.dirname(env.DEEPAGENT_CODE_DB))
      if (input.cwd) await requireOwnedDirectory(root, input.cwd)
      return { cmd: [executable, ...(input.args ?? [])], cwd: input.cwd ?? root,
        env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)) }
    }
    return { root, executable, components, payload: signed.payload, manifests,
      invocation,
      async run(input: { args?: string[]; env?: Record<string, string>; stdin?: string | Uint8Array; milliseconds?: number;
        inheritEnvironment?: boolean } = {}) {
        assert(!state.disposed, "Native CLI cohort is disposed")
        assert((input.args ?? []).length <= 64 && (input.args ?? []).every((arg) => arg.length <= 8192 && !arg.includes("\0")))
        const milliseconds = input.milliseconds ?? 60_000
        assert(Number.isSafeInteger(milliseconds) && milliseconds > 0 && milliseconds <= runtimeLimit)
        const command = await invocation(input)
        assert(input.stdin === undefined || Buffer.byteLength(input.stdin) <= 1_048_576)
        const run = execute(command.cmd, command.cwd, command.env, `runtime-${state.counter++}`,
          milliseconds, input.stdin, state.stops)
        state.runs.add(run)
        try { return await run } finally { state.runs.delete(run) }
      },
      async dispose() {
        if (state.disposed) return
        state.disposed = true
        const stopped = await Promise.allSettled([...state.stops].map((stop) => stop()))
        await Promise.allSettled([...state.runs])
        const failures = stopped.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
        if (failures.length) throw new AggregateError(failures, "Native CLI cohort retirement is unknown")
        // Keep public receipts, source identities and complete logs for CI
        // diagnosis. Build's finally already removed the ephemeral private key.
      },
    }
  } finally {
    await Promise.all([privateInput, environmentFile, publisher.privateKeyFile].map((file) => fs.rm(file, { force: true })))
  }
}

function environment(root: string, rustupHome: string, inherit = true) {
  return {
    ...(inherit ? Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/^(?:DEEPAGENT_|DAC_|XDG_|BUN_OPTIONS$|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$)/i.test(name))) : {
      SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
      WINDIR: process.env.WINDIR,
      ComSpec: process.env.ComSpec ?? process.env.COMSPEC,
      SystemDrive: process.env.SystemDrive,
      PATH: process.env.PATH,
    }),
    HOME: path.join(root, "profile"), USERPROFILE: path.join(root, "profile"),
    APPDATA: path.join(root, "profile/appdata"), LOCALAPPDATA: path.join(root, "profile/localappdata"),
    TMPDIR: path.join(root, "tmp"), TEMP: path.join(root, "tmp"), TMP: path.join(root, "tmp"),
    XDG_DATA_HOME: path.join(root, "data"), XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    CARGO_HOME: path.join(root, "cargo-cache"), RUSTUP_HOME: rustupHome,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(root, "bun-cache"),
    DEEPAGENT_CODE_TEST_HOME: root, DEEPAGENT_CODE_HOME: path.join(root, "data"),
  }
}

async function prepareDirectories(root: string) {
  for (const name of ["profile", "profile/appdata", "profile/localappdata", "tmp", "data", "config", "cache", "state", "cargo-cache", "bun-cache"])
    await fs.mkdir(path.join(root, name), { recursive: true, mode: 0o700 })
}

async function requireOwnedDirectory(root: string, directory: string) {
  assert(path.isAbsolute(directory))
  const relative = path.relative(root, directory)
  assert(!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`), "Writable environment escaped its owned cohort")
  const parent = await fs.realpath(directory).catch(async (error: unknown): Promise<string> => {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error
    await requireOwnedDirectory(root, path.dirname(directory))
    await fs.mkdir(directory, { mode: 0o700 })
    return fs.realpath(directory)
  })
  const current = path.relative(root, parent)
  assert(!path.isAbsolute(current) && current !== ".." && !current.startsWith(`..${path.sep}`), "Writable environment resolved outside its owned cohort")
}

async function execute(command: string[], root: string, env: Record<string, string | undefined>, name: string,
  milliseconds: number, stdin?: string | Uint8Array, stops?: Set<() => Promise<void>>) {
  const stdoutFile = path.join(root, `${name}-stdout.log`)
  const stderrFile = path.join(root, `${name}-stderr.log`)
  await Promise.all([stdoutFile, stderrFile].map((file) => fs.writeFile(file, "", { flag: "wx", mode: 0o600 })))
  const child = Bun.spawn(command, { cwd: root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const started = Date.now()
  const readers = [child.stdout.getReader(), child.stderr.getReader()]
  const state = { timedOut: false, drained: 0, stopping: undefined as Promise<void> | undefined }
  const drain = async (reader: typeof readers[number], filename: string) => {
    const tail: { bytes: Uint8Array } = { bytes: new Uint8Array() }
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) return Buffer.from(tail.bytes).toString()
        tail.bytes = Buffer.concat([tail.bytes, chunk.value]).subarray(-16_384)
        await fs.appendFile(filename, chunk.value)
      }
    } finally { state.drained++; reader.releaseLock() }
  }
  const drains = [drain(readers[0]!, stdoutFile), drain(readers[1]!, stderrFile)]
  const output = Promise.all(drains)
  const stop = () => state.stopping ??= (async () => {
    if (child.exitCode !== null) return
    try {
      const killer = Bun.spawn([path.win32.join(process.env.SystemRoot!, "System32/taskkill.exe"),
        "/PID", String(child.pid), "/T", "/F"], { stdin: "ignore", stdout: "ignore", stderr: "ignore",
        timeout: 5_000, killSignal: "SIGKILL" })
      await killer.exited
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
    }
    const deadline = Promise.withResolvers<never>()
    const timer = setTimeout(() => deadline.reject(new Error("Owned Native child retirement is unknown")), 5_000)
    try {
      await Promise.race([child.exited, deadline.promise])
    } finally { clearTimeout(timer) }
  })()
  stops?.add(stop)
  const cancel = async () => { await Promise.allSettled(readers.map((reader) => reader.cancel())) }
  const timer = setTimeout(() => {
    state.timedOut = true
    void stop().finally(cancel).catch(() => {})
  }, milliseconds)
  try {
    if (stdin !== undefined) child.stdin.write(stdin)
    child.stdin.end()
    const [code, logs] = await Promise.all([child.exited, output])
    return { code, stdout: logs[0]!, stderr: logs[1]!, stdoutFile, stderrFile,
      milliseconds: Date.now() - started, timedOut: state.timedOut }
  } finally {
    clearTimeout(timer)
    try { await stop() } finally {
      if (state.drained !== 2) await cancel()
      await Promise.allSettled(drains)
      if (child.exitCode !== null) stops?.delete(stop)
    }
  }
}

async function assemble(input: { root: string; publicKeyFile: string }) {
  const bootstrap = await buildWindowsNativeBootstrap({ repository, staging: input.root,
    publicKey: await fs.readFile(input.publicKeyFile, "utf8") })
  const cargo = path.join(input.root, "native-bootstrap-cargo")
  const helper = Bun.spawn(["cargo", "build", "--locked", "--release", "--bin", "deepagent-work-file-helper"], {
    cwd: path.join(repository, "packages/work-file-helper"),
    env: { ...process.env, CARGO_TARGET_DIR: cargo, DAC_NATIVE_PRELOADER_PUBLISHER_HEX: bootstrap.publisherPin },
    stdin: "ignore", stdout: "inherit", stderr: "inherit",
  })
  assert.equal(await helper.exited, 0)
  const filename = "deepagent-work-file-helper.exe"
  await fs.copyFile(path.join(cargo, "release", filename), path.join(input.root, filename))
  const bytes = await fs.readFile(path.join(input.root, filename))
  const defines = await nativeNodeDefines({ repository, destination: input.root,
    helper: { path: `packages/work-file-helper/bin/win32-${process.arch}/${filename}`, bytes: bytes.length, sha256: hash(bytes) },
    assets: [bootstrap, ...bootstrap.assets, ...bootstrap.licenses] })
  await fs.writeFile(path.join(input.root, "native-build-defines.json"), JSON.stringify(defines))
}

if (import.meta.main) {
  const input = await Bun.file(process.argv[2]!).json() as Parameters<typeof assemble>[0]
  await assemble(input)
}
