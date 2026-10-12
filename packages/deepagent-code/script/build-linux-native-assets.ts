import fs from "node:fs/promises"
import { constants, type BigIntStats } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"

export const LINUX_NATIVE_DEV_MANIFEST = "linux-native-dev-assets.json"
export const LINUX_NATIVE_DEV_DOMAIN = "dac.linux-native-dev-assets.v1"
export const LINUX_NATIVE_IMAGE_LIMIT = 268_435_456
export const LINUX_NATIVE_CLOSURE_LIMIT = 128
export const LINUX_NATIVE_CLOSURE_BYTES = 268_435_456
export const LINUX_NATIVE_TOTAL_BYTES = 536_870_912
const manifestLimit = 1_048_576
const names = ["deepagent-work-file-helper", "deepagent-work-storage-cleanup", "deepagent-work-process-supervisor", "bun-command-runtime"] as const
const licenseNames = ["NOTICE", "work-file-helper.LICENSE", "work-file-helper.NOTICE", "work-file-helper.UPSTREAM.json"] as const
const targets = ["linux-x64", "linux-arm64"] as const
export type LinuxNativeTarget = typeof targets[number]
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const record = Schema.Struct({ path: Schema.String, bytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: LINUX_NATIVE_IMAGE_LIMIT })), sha256: digest })
const toolRecord = Schema.Struct({ name: Schema.String, bytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: LINUX_NATIVE_IMAGE_LIMIT })), sha256: digest,
  version: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)) })
export const LinuxNativeDevManifest = Schema.Struct({
  schemaVersion: Schema.Literal(LINUX_NATIVE_DEV_DOMAIN), target: Schema.Literals(targets),
  sourceCommit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/)),
  sourceTree: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/)),
  source: Schema.Array(record).check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  tools: Schema.Array(toolRecord).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  runtimeVersion: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  assets: Schema.Array(record).check(Schema.isMinLength(4), Schema.isMaxLength(4 + LINUX_NATIVE_CLOSURE_LIMIT)),
  licenses: Schema.Array(record).check(Schema.isMinLength(4), Schema.isMaxLength(128)),
})
export type LinuxNativeDevManifest = typeof LinuxNativeDevManifest.Type
export type LinuxNativeAsset = typeof record.Type

/** One captured toolchain builds all three original bins; dispatcher shims are never invoked as Cargo. */
export function linuxNativeCargoInvocation(input: { cargo: string; rustc: string; target: LinuxNativeTarget; targetDirectory: string; environment?: NodeJS.ProcessEnv }) {
  if (![input.cargo, input.rustc, input.targetDirectory].every(path.isAbsolute) || path.basename(input.cargo) !== "cargo" || path.basename(input.rustc) !== "rustc") throw new Error("Linux Cargo requires actual absolute toolchain images")
  const environment = input.environment ?? process.env
  if (["RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "CARGO_BUILD_RUSTC_WRAPPER", "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER"].some((name) => environment[name])) throw new Error("Linux Cargo cannot use an uncaptured compiler wrapper")
  const rustTarget = input.target === "linux-x64" ? "x86_64-unknown-linux-gnu" : "aarch64-unknown-linux-gnu"
  return { rustTarget,
    args: ["build", "--locked", "--release", ...names.slice(0, 3).flatMap((name) => ["--bin", name]), "--target", rustTarget],
    env: { ...environment, RUSTC: input.rustc, CARGO_TARGET_DIR: input.targetDirectory } }
}

/** Data-only build inventory. It never supplies NativeInstallation authority. */
export async function inspectLinuxNativeAssets(input: { directory: string; target: LinuxNativeTarget; expectedManifestHash?: string }) {
  const directory = path.resolve(input.directory)
  if (await fs.realpath(directory) !== directory || !(await fs.lstat(directory)).isDirectory()) throw new Error("Linux assets require a physical directory")
  if (await present(path.join(directory, "node.js.native-installation.json"))) throw new Error("Dev Linux assets cannot inherit an installation receipt")
  const manifestImage = await image(path.join(directory, LINUX_NATIVE_DEV_MANIFEST), manifestLimit, false)
  const text = (await fs.readFile(manifestImage.canonical, "utf8"))
  const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(LinuxNativeDevManifest), { onExcessProperty: "error" })(text)
  if (text !== CanonicalJson.stringify(manifest) || manifest.target !== input.target ||
    input.expectedManifestHash !== undefined && input.expectedManifestHash !== manifestImage.sha256) throw new Error("Linux dev manifest does not match this asset cohort")
  const prefix = `packages/work-file-helper/bin/${input.target}/`
  const fileNames = manifest.assets.map((asset) => {
    if (!asset.path.startsWith(prefix)) throw new Error("Linux asset target differs from its manifest")
    return asset.path.slice(prefix.length)
  })
  if (new Set(fileNames).size !== fileNames.length || names.some((name) => !fileNames.includes(name)) ||
    fileNames.some((name) => !names.includes(name as typeof names[number]) && !closurePath(name)) ||
    manifest.assets.reduce((sum, entry) => sum + entry.bytes, 0) > LINUX_NATIVE_TOTAL_BYTES ||
    manifest.assets.filter((entry) => entry.path.includes("/runtime-closure/")).reduce((sum, entry) => sum + entry.bytes, 0) > LINUX_NATIVE_CLOSURE_BYTES)
    throw new Error("Linux asset set is incomplete, unsafe or over budget")
  if (manifest.source.some((entry) => !relativePath(entry.path)) || new Set(manifest.source.map((entry) => entry.path)).size !== manifest.source.length ||
    new Set(manifest.tools.map((entry) => entry.name)).size !== manifest.tools.length ||
    !["cargo,dpkg-query,git,ldconfig,readelf,rustc", "cargo,dpkg-query,git,ldconfig,readelf,rustc,rustup"].includes(manifest.tools.map((entry) => entry.name).toSorted().join(",")) ||
    manifest.licenses.some((entry) => !/^linux-native-licenses\/[a-zA-Z0-9_.+-]+$/.test(entry.path)) ||
    licenseNames.some((name) => !manifest.licenses.some((entry) => entry.path === `linux-native-licenses/${name}`)) ||
    new Set(manifest.licenses.map((entry) => entry.path)).size !== manifest.licenses.length ||
    manifest.licenses.reduce((sum, entry) => sum + entry.bytes, 0) > 8_388_608) throw new Error("Linux provenance inventory is invalid")
  const files = await Promise.all(manifest.assets.map(async (entry) => {
    const filename = path.join(directory, entry.path.slice(prefix.length))
    const observed = await image(filename, LINUX_NATIVE_IMAGE_LIMIT, true)
    if (observed.bytes !== entry.bytes || observed.sha256 !== entry.sha256) throw new Error("Linux asset differs from its manifest")
    requireELF(observed.header, input.target)
    return observed
  }))
  const licenses = await Promise.all(manifest.licenses.map(async (entry) => {
    const observed = await image(path.join(directory, entry.path), 1_048_576, false)
    if (observed.bytes !== entry.bytes || observed.sha256 !== entry.sha256) throw new Error("Linux license differs from its manifest")
    return observed
  }))
  const closure = await tree(path.join(directory, "runtime-closure"))
  const licensed = await tree(path.join(directory, "linux-native-licenses"))
  if (closure.map((item) => path.relative(directory, item)).toSorted().join("\n") !== fileNames.filter((name) => name.startsWith("runtime-closure/")).toSorted().join("\n") ||
    licensed.map((item) => path.relative(directory, item)).toSorted().join("\n") !== manifest.licenses.map((entry) => entry.path).toSorted().join("\n")) throw new Error("Linux assets contain unrecorded closure or licenses")
  await Promise.all([manifestImage, ...files, ...licenses].map(current))
  return { manifest, manifestHash: manifestImage.sha256, files: [path.join(directory, LINUX_NATIVE_DEV_MANIFEST), ...files.map((entry) => entry.canonical), ...licenses.map((entry) => entry.canonical)] }
}

/** Fixed native Ubuntu/glibc build. No payload, ldd, signing key or remote runtime is invoked. */
export async function buildLinuxNativeAssets(input: { destination: string }) {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) throw new Error("Linux Native assets require a native Linux x64 or arm64 host")
  if (["LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT"].some((name) => process.env[name])) throw new Error("Linux Native assets require the ordinary system loader environment")
  const target = `linux-${process.arch}` as LinuxNativeTarget
  const repository = path.resolve(import.meta.dirname, "../../..")
  const destination = path.resolve(input.destination)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  const staging = await fs.mkdtemp(path.join(path.dirname(destination), ".linux-native-assets-"))
  await fs.chmod(staging, 0o700)
  try {
    const readelf = await tool("readelf", "/usr/bin/readelf")
    const ldconfig = await tool("ldconfig", "/usr/sbin/ldconfig")
    const dpkg = await tool("dpkg-query", "/usr/bin/dpkg-query")
    const git = await tool("git", "/usr/bin/git")
    const crate = path.join(repository, "packages/work-file-helper")
    const cargoAlias = Bun.which("cargo")
    const compilerAlias = Bun.which("rustc")
    if (!cargoAlias || !compilerAlias) throw new Error("Linux Rust toolchain is unavailable")
    const cargoImage = await image(await fs.realpath(cargoAlias), LINUX_NATIVE_IMAGE_LIMIT, true)
    const compilerImage = await image(await fs.realpath(compilerAlias), LINUX_NATIVE_IMAGE_LIMIT, true)
    const rustup = path.basename(cargoImage.canonical) === "rustup" || path.basename(compilerImage.canonical) === "rustup"
      ? await tool("rustup", cargoImage.canonical, process.env) : undefined
    if (rustup && (cargoImage.canonical !== rustup.canonical || compilerImage.canonical !== rustup.canonical)) throw new Error("Linux Rustup dispatchers do not share one toolchain authority")
    // Rustup's dispatcher chooses the operation from argv[0]. Resolve its actual images
    // in the crate's original override context before invoking any Cargo operation.
    const cargo = await tool("cargo", rustup ? (await command(rustup, ["which", "cargo"], crate, process.env)).trim() : cargoAlias, process.env)
    const compiler = await tool("rustc", rustup ? (await command(rustup, ["which", "rustc"], crate, process.env)).trim() : compilerAlias, process.env)
    if (rustup && path.dirname(cargo.canonical) !== path.dirname(compiler.canonical)) throw new Error("Linux Rustup resolved mismatched Cargo and compiler images")
    const build = linuxNativeCargoInvocation({ cargo: cargo.canonical, rustc: compiler.canonical, target, targetDirectory: path.join(staging, "cargo"), environment: process.env })
    const runtime = await image(await fs.realpath(process.execPath), LINUX_NATIVE_IMAGE_LIMIT, true)
    requireELF(runtime.header, target)
    const sourceCommit = (await command(git, ["rev-parse", "HEAD"], repository)).trim()
    const sourceTree = (await command(git, ["rev-parse", "HEAD^{tree}"], repository)).trim()
    const sourcePaths = (await command(git, ["ls-files", "--cached", "--others", "--exclude-standard", "packages/work-file-helper/src", "packages/work-file-helper/Cargo.toml", "packages/work-file-helper/Cargo.lock", "packages/work-file-helper/LICENSE", "packages/work-file-helper/NOTICE", "packages/work-file-helper/UPSTREAM.json", "packages/deepagent-code/script/build-linux-native-assets.ts"], repository)).trim().split("\n")
    if (!sourcePaths.length || sourcePaths.some((entry) => !relativePath(entry))) throw new Error("Linux Native source inventory is unavailable")
    const sources = await Promise.all([...new Set(sourcePaths)].toSorted().map(async (entry) => ({ path: entry, image: await image(path.join(repository, entry), 16_777_216, false) })))
    await command(cargo, build.args, crate, build.env, 600_000)
    await Promise.all(names.slice(0, 3).map(async (name) => {
      await fs.copyFile(path.join(build.env.CARGO_TARGET_DIR, build.rustTarget, "release", name), path.join(staging, name), constants.COPYFILE_EXCL)
      await fs.chmod(path.join(staging, name), 0o755)
    }))
    await fs.copyFile(runtime.canonical, path.join(staging, names[3]), constants.COPYFILE_EXCL)
    await fs.chmod(path.join(staging, names[3]), 0o755)
    const stagedRuntime = await image(path.join(staging, names[3]), LINUX_NATIVE_IMAGE_LIMIT, true)
    if (stagedRuntime.sha256 !== runtime.sha256 || stagedRuntime.bytes !== runtime.bytes) throw new Error("Linux Bun runtime changed during copying")
    const cache = await image("/etc/ld.so.cache", 16_777_216, false)
    const listing = await command(ldconfig, ["-p"])
    const libraries = new Map<string, Awaited<ReturnType<typeof image>>>()
    const licenses = new Map<string, Awaited<ReturnType<typeof copyright>>>()
    const aliases = new Map<string, string>()
    await fs.mkdir(path.join(staging, "linux-native-licenses"))
    const pending = [{ logical: "", filename: stagedRuntime.canonical }]
    while (pending.length) {
      const entry = pending.shift()!
      const needed = await dependencies(readelf, entry.filename)
      const logical = [...(needed.interpreter ? [needed.interpreter] : []), ...await Promise.all(needed.names.map(async (name) => {
        const candidates = [...listing.matchAll(/^\s*(\S+)\s+\(([^\n]*)\)\s+=>\s+(\/\S+)\s*$/gm)].filter((match) => match[1] === name && match[2]!.split(",").map((tag) => tag.trim()).includes(process.arch === "x64" ? "x86-64" : "AArch64")).map((match) => match[3]!)
          .filter((filename) => systemLibrary(filename))
        const native = candidates.filter((filename) => process.arch === "x64" ? !/\/(i386|aarch64|arm)-/.test(filename) : !/\/(i386|x86_64|arm)-/.test(filename))
        const resolved = await Promise.all(native.map(async (filename) => {
          const canonical = await fs.realpath(filename)
          if (!systemLibrary(canonical)) throw new Error("Linux runtime library alias escapes the system library roots")
          aliases.set(filename, canonical)
          return canonical
        }))
        // ldconfig can list the interpreter through both a multiarch directory and
        // its system alias. Accept those only when they name one actual image.
        if (!resolved.length || new Set(resolved).size !== 1) throw new Error("Linux runtime library resolution is ambiguous or unavailable")
        return native[0]!
      }))]
      for (const filename of logical) {
        if (!systemLibrary(filename)) throw new Error("Linux runtime requires a non-system loader or library")
        if (libraries.has(filename)) continue
        if (libraries.size >= LINUX_NATIVE_CLOSURE_LIMIT) throw new Error("Linux runtime closure exceeds its file bound")
        const canonical = await fs.realpath(filename)
        if (!systemLibrary(canonical)) throw new Error("Linux runtime library alias escapes the system library roots")
        const observed = await image(canonical, LINUX_NATIVE_IMAGE_LIMIT, false)
        requireELF(observed.header, target)
        if ([...libraries.values()].reduce((sum, item) => sum + item.bytes, 0) + observed.bytes > LINUX_NATIVE_CLOSURE_BYTES) throw new Error("Linux runtime closure exceeds its byte bound")
        libraries.set(filename, observed)
        const relative = filename.slice(1)
        await fs.mkdir(path.dirname(path.join(staging, "runtime-closure", relative)), { recursive: true })
        await fs.copyFile(canonical, path.join(staging, "runtime-closure", relative), constants.COPYFILE_EXCL)
        await fs.chmod(path.join(staging, "runtime-closure", relative), 0o755)
        pending.push({ logical: filename, filename: canonical })
        const packageName = await linuxNativePackageOwnership({ logical: filename, canonical,
          query: (source) => command(dpkg, ["-S", source]) })
        if (!licenses.has(packageName)) licenses.set(packageName, await copyright({ packageName, directory: staging,
          query: (args) => command(dpkg, args) }))
      }
    }
    const licenseRecords = [...licenses].map(([name, observed]) => ({
      path: `linux-native-licenses/${name}.copyright`, bytes: observed.bytes, sha256: observed.sha256,
    }))
    const provenance = await Promise.all(["LICENSE", "NOTICE", "UPSTREAM.json"].map(async (name) => {
      const original = sources.find((entry) => entry.path === `packages/work-file-helper/${name}`)
      if (!original) throw new Error("Linux Rust component license provenance is unavailable")
      const filename = `linux-native-licenses/work-file-helper.${name}`
      await fs.copyFile(original.image.canonical, path.join(staging, filename), constants.COPYFILE_EXCL)
      await fs.chmod(path.join(staging, filename), 0o644)
      return { path: filename, bytes: original.image.bytes, sha256: original.image.sha256 }
    }))
    licenseRecords.push(...provenance)
    const notice = "Linux Native development assets are data-only; this inventory does not grant execution authority.\nRuntime: Bun " + process.versions.bun + ".\nRust helper/storage/supervisor provenance and licenses: linux-native-licenses/work-file-helper.LICENSE, linux-native-licenses/work-file-helper.NOTICE, linux-native-licenses/work-file-helper.UPSTREAM.json.\nSystem runtime closure provenance: original native Debian packages and the accompanying copyright files.\n"
    await fs.writeFile(path.join(staging, "linux-native-licenses/NOTICE"), notice, { mode: 0o644, flag: "wx" })
    licenseRecords.push({ path: "linux-native-licenses/NOTICE", bytes: Buffer.byteLength(notice), sha256: createHash("sha256").update(notice).digest("hex") })
    const files = [...names, ...[...libraries.keys()].map((name) => `runtime-closure/${name.slice(1)}`)].toSorted()
    const assets = await Promise.all(files.map(async (name) => {
      const observed = await image(path.join(staging, name), LINUX_NATIVE_IMAGE_LIMIT, true)
      requireELF(observed.header, target)
      return { path: `packages/work-file-helper/bin/${target}/${name}`, bytes: observed.bytes, sha256: observed.sha256 }
    }))
    await Promise.all([runtime, cache, ...sources.map((entry) => entry.image), ...libraries.values(), ...licenses.values(), cargoImage, compilerImage, readelf, ldconfig, dpkg, git, cargo, compiler, ...(rustup ? [rustup] : [])].map(current))
    await Promise.all([...licenses.values()].map((observed) => observed.sourceCurrent()))
    await Promise.all([...aliases].map(async ([filename, canonical]) => {
      if (await fs.realpath(filename) !== canonical) throw new Error("Linux runtime library alias changed during building")
    }))
    if (await fs.realpath(cargoAlias) !== cargoImage.canonical || await fs.realpath(compilerAlias) !== compilerImage.canonical) throw new Error("Linux Rust dispatcher changed during building")
    if (rustup && ((await command(rustup, ["which", "cargo"], crate, process.env)).trim() !== cargo.requested || (await command(rustup, ["which", "rustc"], crate, process.env)).trim() !== compiler.requested)) throw new Error("Linux selected Rust toolchain changed during building")
    if ((await command(git, ["rev-parse", "HEAD"], repository)).trim() !== sourceCommit || (await command(git, ["rev-parse", "HEAD^{tree}"], repository)).trim() !== sourceTree) throw new Error("Linux Native source identity changed during building")
    const manifest: LinuxNativeDevManifest = { schemaVersion: LINUX_NATIVE_DEV_DOMAIN, target, sourceCommit, sourceTree,
      source: sources.map((entry) => ({ path: entry.path, bytes: entry.image.bytes, sha256: entry.image.sha256 })),
      tools: [readelf, ldconfig, dpkg, git, cargo, compiler, ...(rustup ? [rustup] : [])].map((entry) => ({ name: entry.name, bytes: entry.bytes, sha256: entry.sha256, version: entry.version })),
      runtimeVersion: process.versions.bun!, assets, licenses: licenseRecords.toSorted((a,b) => a.path.localeCompare(b.path)) }
    await fs.writeFile(path.join(staging, LINUX_NATIVE_DEV_MANIFEST), CanonicalJson.stringify(manifest), { mode: 0o644, flag: "wx" })
    await fs.rm(build.env.CARGO_TARGET_DIR, { recursive: true })
    const checked = await inspectLinuxNativeAssets({ directory: staging, target })
    // The owner chooses a fresh directory, so an earlier cohort is never merged or overwritten.
    if (await present(destination)) throw new Error("Linux asset destination already exists; use a fresh cohort directory")
    await fs.rename(staging, destination)
    return { target, manifestPath: path.join(destination, LINUX_NATIVE_DEV_MANIFEST), manifestHash: checked.manifestHash, assets }
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
}

export async function linuxNativePackageOwnership(input: { logical: string; canonical: string; query: (source: string) => Promise<string> }) {
  const output = await input.query(input.canonical).catch((error: unknown) => {
    // A registered physical image can have a diverted logical alias on merged-/usr.
    // Only dpkg's exact unregistered-path result permits querying that alias instead.
    if (!(error instanceof Error) || error.message !== `Linux dpkg-query operation failed (1); dpkg-query: no path found matching pattern ${input.canonical}\n`) throw error
    return input.query(input.logical)
  })
  return linuxNativePackageProvenance({ logical: input.logical, canonical: input.canonical, output })
}

export function linuxNativePackageProvenance(input: { logical: string; canonical: string; output: string }) {
  const ownership = input.output.trim().split("\n")
  if (ownership.length !== 1 || !/^([a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?):\s+\//.test(ownership[0]!)) {
    const paths = [input.logical, input.canonical].map((value) => systemLibrary(value) && value.length <= 512 && /^[A-Za-z0-9_+./-]+$/.test(value) ? value : "unavailable")
    throw new Error(`Linux runtime library requires unambiguous package provenance (logical=${paths[0]}, canonical=${paths[1]}, records=${Math.min(ownership.length, 129)})`)
  }
  return ownership[0]!.slice(0, ownership[0]!.indexOf(": ")).split(":")[0]!
}

export async function linuxNativeCopyrightMetadata(input: { canonical: string; query: (args: string[]) => Promise<string> }) {
  const packageName = /^\/usr\/share\/doc\/([a-z0-9][a-z0-9+.-]{0,127})\/copyright$/.exec(input.canonical)
  if (!packageName || packageName[0] !== input.canonical) throw new Error("Linux copyright requires a fixed canonical package path")
  const ownership = await input.query(["-S", input.canonical])
  const owner = /^([a-z0-9][a-z0-9+.-]{0,127}(?::[a-z0-9]{1,16})?): (\/[^\s]+)$/.exec(ownership.trim())
  if (!owner || owner[1]!.split(":")[0] !== packageName[1] || owner[2] !== input.canonical)
    throw new Error("Linux copyright requires one exact registered package owner")
  const registered = await input.query(["--control-show", owner[1]!, "md5sums"])
  if (Buffer.byteLength(registered) > manifestLimit) throw new Error("Linux copyright registration exceeds its bound")
  const records = registered.split("\n").flatMap((line) => {
    if (!line) return []
    const record = /^([a-f0-9]{32})[ \t]+(.+)$/.exec(line)
    if (!record) throw new Error("Linux copyright registration is invalid")
    return record?.[2] === input.canonical.slice(1) ? [record[1]!] : []
  })
  if (records.length !== 1) throw new Error("Linux copyright requires one exact registered content digest")
  return { ownership, registered, md5: records[0]! }
}

async function copyright(input: { packageName: string; directory: string; query: (args: string[]) => Promise<string> }) {
  if (!/^[a-z0-9][a-z0-9+.-]{0,127}$/.test(input.packageName)) throw new Error("Linux copyright package name is invalid")
  const logical = `/usr/share/doc/${input.packageName}/copyright`
  const canonical = await fs.realpath(logical)
  const metadata = await linuxNativeCopyrightMetadata({ canonical, query: input.query })
  const copied = await linuxNativeCopyrightCopy({ source: canonical,
    destination: path.join(input.directory, "linux-native-licenses", `${input.packageName}.copyright`), md5: metadata.md5 })
  if (await fs.realpath(logical) !== canonical) throw new Error("Linux copyright alias changed during capture")
  return { ...copied, sourceCurrent: async () => {
    await copied.sourceCurrent()
    const current = await linuxNativeCopyrightMetadata({ canonical, query: input.query })
    if (current.ownership !== metadata.ownership || current.registered !== metadata.registered || await fs.realpath(logical) !== canonical)
      throw new Error("Linux copyright package provenance changed after capture")
  } }
}

export async function linuxNativeCopyrightCopy(input: { source: string; destination: string; md5: string }) {
  const observed = await registeredCopyright(input.source, input.md5)
  const captured = { bytes: observed.body.length, sha256: observed.sha256, identity: observed.identity }
  const destination = path.resolve(input.destination)
  if (await fs.realpath(path.dirname(destination)) !== path.dirname(destination)) throw new Error("Linux copyright requires a physical private destination")
  await fs.writeFile(destination, observed.body, { mode: 0o644, flag: "wx" })
  await fs.chmod(destination, 0o644)
  const copied = await image(destination, manifestLimit, false)
  if (copied.bytes !== captured.bytes || copied.sha256 !== captured.sha256) throw new Error("Linux copyright copy differs from its registered source")
  const sourceCurrent = async () => {
    const next = await registeredCopyright(input.source, input.md5)
    if (next.body.length !== captured.bytes || next.sha256 !== captured.sha256 || next.identity !== captured.identity)
      throw new Error("Linux copyright source changed after capture")
    await current(copied)
  }
  await sourceCurrent()
  return { ...copied, sourceCurrent }
}

async function registeredCopyright(filename: string, expectedMD5: string) {
  if (!/^[a-f0-9]{32}$/.test(expectedMD5)) throw new Error("Linux copyright content digest is invalid")
  const canonical = path.resolve(filename)
  if (await fs.realpath(canonical) !== canonical) throw new Error("Linux copyright requires a physical source")
  const file = await fs.open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(manifestLimit))
      throw new Error("Linux copyright requires a bounded singlelink regular source")
    const body = Buffer.alloc(Number(before.size))
    const state = { bytes: 0 }
    while (state.bytes < body.length) {
      const read = await file.read(body, state.bytes, body.length - state.bytes, null)
      if (!read.bytesRead) throw new Error("Linux copyright source changed while reading")
      state.bytes += read.bytesRead
    }
    if ((await file.read(Buffer.alloc(1), 0, 1, null)).bytesRead || stamp(before) !== stamp(await file.stat({ bigint: true })) ||
      stamp(before) !== stamp(await fs.lstat(canonical, { bigint: true })) || await fs.realpath(canonical) !== canonical)
      throw new Error("Linux copyright source changed while reading")
    if (createHash("md5").update(body).digest("hex") !== expectedMD5) throw new Error("Linux copyright differs from registered package content")
    return { body, sha256: createHash("sha256").update(body).digest("hex"), identity: stamp(before) }
  } finally { await file.close() }
}

function relativePath(value: string) {
  return !!value && !path.isAbsolute(value) && !value.includes("\\") && value.split("/").every((part) => !!part && part !== "." && part !== "..")
}
function closurePath(value: string) {
  return value.startsWith("runtime-closure/") && systemLibrary(`/${value.slice("runtime-closure/".length)}`)
}
function systemLibrary(value: string) {
  return /^\/(lib|lib64|usr\/lib|usr\/lib64)\//.test(value) && relativePath(value.slice(1))
}
function requireELF(header: Buffer, target: LinuxNativeTarget) {
  if (header.length < 64 || header.readUInt32LE(0) !== 0x464c457f || header[4] !== 2 || header[5] !== 1 || header[6] !== 1 ||
    ![2,3].includes(header.readUInt16LE(16)) || header.readUInt16LE(18) !== (target === "linux-x64" ? 62 : 183) || header.readUInt32LE(20) !== 1)
    throw new Error("Linux image must be a matching native ELF64 executable or library")
}
export function linuxNativeImageRejection(input: { filename: string; stats: BigIntStats; maximum: number; executable: boolean }) {
  const predicate = !input.stats.isFile() ? "regular"
    : input.stats.nlink !== 1n ? "nlink"
    : input.stats.size < 1n ? "size_empty"
    : input.stats.size > BigInt(input.maximum) ? "size_limit"
    : (input.stats.mode & 0o022n) !== 0n ? "writable"
    : input.executable && (input.stats.mode & 0o111n) === 0n ? "executable" : undefined
  if (!predicate) return
  // Only the fixed system copyright namespace may disclose bounded provenance metadata.
  const copyright = /^\/usr\/share\/doc\/([a-z0-9][a-z0-9+.-]{0,127})\/copyright$/.exec(input.filename)
  return "Linux assets require bounded private regular files; " + (copyright && copyright[0] === input.filename
    ? `kind=copyright, package=${copyright[1]}, predicate=${predicate}, bytes=${input.stats.size}, nlink=${input.stats.nlink}, maximum=${input.maximum}, mode=0o${input.stats.mode.toString(8)}`
    : `kind=image, predicate=${predicate}`)
}

async function image(filename: string, maximum: number, executable: boolean) {
  const canonical = path.resolve(filename)
  if (await fs.realpath(canonical) !== canonical) throw new Error("Linux assets require physical files")
  const file = await fs.open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat({ bigint: true })
    const rejection = linuxNativeImageRejection({ filename: canonical, stats: before, maximum, executable })
    if (rejection) throw new Error(rejection)
    const buffer = Buffer.alloc(65_536)
    const hash = createHash("sha256")
    const state = { bytes: 0, header: Buffer.alloc(0) }
    for (;;) {
      const read = await file.read(buffer, 0, buffer.length, null)
      if (!read.bytesRead) break
      if (!state.bytes) state.header = Buffer.from(buffer.subarray(0, Math.min(64, read.bytesRead)))
      state.bytes += read.bytesRead
      if (state.bytes > maximum || state.bytes > Number(before.size)) throw new Error("Linux asset changed while reading")
      hash.update(buffer.subarray(0, read.bytesRead))
    }
    if (state.bytes !== Number(before.size) || stamp(before) !== stamp(await file.stat({ bigint: true })) || stamp(before) !== stamp(await fs.lstat(canonical, { bigint: true })) || await fs.realpath(canonical) !== canonical) throw new Error("Linux asset changed while reading")
    return { canonical, bytes: state.bytes, sha256: hash.digest("hex"), identity: stamp(before), header: state.header }
  } finally { await file.close() }
}
function stamp(value: BigIntStats) {
  return [value.dev,value.ino,value.mode,value.nlink,value.size,value.mtimeNs,value.ctimeNs].join(":")
}
async function current(prior: Awaited<ReturnType<typeof image>> & { requested?: string }) {
  const observed = await image(prior.canonical, Math.max(prior.bytes, 1), false)
  if (prior.sha256 !== observed.sha256 || prior.identity !== observed.identity || prior.requested && await fs.realpath(prior.requested) !== prior.canonical) throw new Error("Linux source, tool or asset changed after capture")
}
async function tool(name: string, filename: string, environment?: NodeJS.ProcessEnv) {
  if (!path.isAbsolute(filename)) throw new Error("Linux build tool is unavailable")
  const observed = await image(await fs.realpath(filename), LINUX_NATIVE_IMAGE_LIMIT, true)
  const value = { ...observed, name, requested: path.resolve(filename), version: "" }
  value.version = (await command(value, ["--version"], undefined, environment)).trim().slice(0,2048)
  return value
}
async function command(tool: Awaited<ReturnType<typeof image>> & { requested?: string }, args: string[], cwd?: string, env: NodeJS.ProcessEnv = { LC_ALL: "C", LANG: "C" }, timeout = 15_000) {
  await current(tool)
  if (args.length > 32 || args.some((value) => value.length > 4096)) throw new Error("Linux build tool arguments exceed their bound")
  const process = Bun.spawn([tool.canonical, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    const state = { bytes: 0, text: "" }
    const decoder = new TextDecoder("utf-8", { fatal: true })
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        state.bytes += chunk.value.byteLength
        if (state.bytes > 1_048_576) { process.kill(); throw new Error("Linux build tool output exceeds its bound") }
        state.text += decoder.decode(chunk.value, { stream: true })
      }
      return state.text + decoder.decode()
    } finally { reader.releaseLock() }
  }
  const timer = setTimeout(() => process.kill(), timeout)
  try {
    const [output, error, code] = await Promise.all([read(process.stdout), read(process.stderr), process.exited])
    if (code !== 0) throw new Error(`Linux ${path.basename(tool.canonical)} operation failed (${code}); ${error.slice(0,256)}`)
    await current(tool)
    return output
  } finally { clearTimeout(timer); if (process.exitCode === null) { process.kill(); await process.exited } }
}
async function dependencies(tool: Awaited<ReturnType<typeof image>>, filename: string) {
  const program = await command(tool, ["--wide", "--program-headers", filename])
  const dynamic = await command(tool, ["--wide", "--dynamic", filename])
  if (/\((?:RPATH|RUNPATH)\)/.test(dynamic)) throw new Error("Linux runtime closure forbids custom loader search paths")
  const interpreters = [...program.matchAll(/Requesting program interpreter:\s*([^\]]+)\]/g)].map((match) => match[1]!)
  const names = [...dynamic.matchAll(/\(NEEDED\).*?\[([^\]]+)\]/g)].map((match) => match[1]!)
  if (interpreters.length > 1 || names.length > 128 || names.some((name) => !/^[a-zA-Z0-9_.+-]{1,255}$/.test(name))) throw new Error("Linux loader description is invalid")
  return { interpreter: interpreters[0], names }
}
async function tree(directory: string, count = { entries: 0 }): Promise<string[]> {
  if (!await present(directory)) return []
  if (await fs.realpath(directory) !== directory || !(await fs.lstat(directory)).isDirectory()) throw new Error("Linux asset tree requires physical directories")
  const entries = await fs.readdir(directory, { withFileTypes: true })
  count.entries += entries.length
  if (entries.length > 256 || count.entries > 4096) throw new Error("Linux asset tree exceeds its entry bound")
  return (await Promise.all(entries.map(async (entry) => {
    if (entry.isSymbolicLink()) throw new Error("Linux asset tree forbids symbolic links")
    const filename = path.join(directory, entry.name)
    return entry.isDirectory() ? tree(filename, count) : [filename]
  }))).flat()
}
async function present(filename: string) {
  return fs.lstat(filename).then(() => true, () => false)
}
