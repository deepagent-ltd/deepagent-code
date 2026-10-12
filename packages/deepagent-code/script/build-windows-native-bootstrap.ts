import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { createHash, createPublicKey, sign, type KeyObject } from "node:crypto"
import { Schema } from "effect"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { NativeInstallationSchema } from "../src/installation/native-installation.schema"

const LIMIT = 268_435_456
const names = ["native-image-factory.node", "node.js", "sidecar.js"] as const

/** Only the current compiler's fixed Bun asset supplies this offline issuer.
 * Its private copy stays separate from the Work image whose DACL the original
 * Native preparation changes. No PATH or caller-selected host is consumed. */
export async function withWindowsNativePublisherHost<T>(artifact: string, use: (host: string) => Promise<T>) {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch) || !path.isAbsolute(artifact) ||
    !["node.js", "deepagent-code.exe"].includes(path.basename(artifact)) || await fs.realpath(artifact) !== artifact)
    throw new Error("Windows publisher host requires its fixed native artifact")
  const metadata = await openWindowsPublisherImage(`${artifact}.native-components.json`, NativeInstallationSchema.COMPONENTS_LIMIT)
  try {
    const components = Schema.decodeUnknownSync(Schema.fromJsonString(NativeInstallationSchema.Components), {
      onExcessProperty: "error",
    })(metadata.content.toString("utf8"))
    if (metadata.content.toString("utf8") !== CanonicalJson.stringify(components) ||
      components.target !== `win32-${process.arch}` || new Set(components.components.map((entry) => entry.path)).size !== components.components.length)
      throw new Error("Windows publisher host inventory rejected")
    const observations = await Promise.allSettled(["bun-command-runtime.exe", "native-image-factory.node"].map(async (name) => {
      const expected = components.components.filter((entry) => entry.path === `packages/work-file-helper/bin/${components.target}/${name}`)
      if (expected.length !== 1) throw new Error("Windows publisher host fixed asset inventory missing")
      const image = await openWindowsPublisherImage(path.join(path.dirname(artifact), name), LIMIT)
      try {
        const pe = image.content.length >= 64 ? image.content.readUInt32LE(0x3c) : image.content.length
        if (image.content.length !== expected[0]!.bytes || image.sha256 !== expected[0]!.sha256 ||
          image.content.subarray(0, 2).toString() !== "MZ" || pe > image.content.length - 24 ||
          image.content.subarray(pe, pe + 4).toString("hex") !== "50450000" ||
          image.content.readUInt16LE(pe + 4) !== (process.arch === "arm64" ? 0xaa64 : 0x8664))
          throw new Error("Windows publisher host differs from its fixed PE inventory")
        return image
      } catch (error) { await image.close(); throw error }
    }))
    const images = observations.flatMap((result) => result.status === "fulfilled" ? [result.value] : [])
    if (images.length !== observations.length) {
      await Promise.all(images.map((image) => image.close()))
      throw new Error("Windows publisher host fixed asset observation rejected")
    }
    try {
      const directory = await fs.mkdtemp(path.join(path.dirname(artifact), ".native-publisher-host-"))
      try {
        await fs.chmod(directory, 0o700)
        if (await fs.realpath(directory) !== directory) throw new Error("Windows publisher host private directory changed")
        const host = path.join(directory, "bun.exe")
        const file = await fs.open(host, "wx", 0o700)
        try { await file.writeFile(images[0]!.content); await file.sync() } finally { await file.close() }
        await metadata.requireCurrent()
        await Promise.all(images.map((image) => image.requireCurrent()))
        const copied = await openWindowsPublisherImage(host, LIMIT)
        try {
          if (copied.content.length !== images[0]!.content.length || copied.sha256 !== images[0]!.sha256)
            throw new Error("Windows publisher host private copy differs from inventory")
          const parent = await fs.lstat(directory, { bigint: true })
          const parentStamp = (value: typeof parent) => [value.dev, value.ino, value.size, value.mode, value.nlink, value.mtimeNs, value.ctimeNs].join(":")
          const requireParentCurrent = async () => {
            if (!parent.isDirectory() || parent.isSymbolicLink() ||
              parentStamp(parent) !== parentStamp(await fs.lstat(directory, { bigint: true })) || await fs.realpath(directory) !== directory)
              throw new Error("Windows publisher host owned parent changed")
            const entries = await fs.opendir(directory)
            try {
              if ((await entries.read())?.name !== "bun.exe" || await entries.read() !== null ||
                parentStamp(parent) !== parentStamp(await fs.lstat(directory, { bigint: true })))
                throw new Error("Windows publisher host owned namespace changed")
            } finally { await entries.close() }
          }
          // Native preparation owns the target Work image's DACL update. Its
          // bytes/identity are revalidated there; this host's immutable lease
          // instead spans the entire child issuer invocation.
          await requireParentCurrent()
          const result = await use(host)
          await copied.requireCurrent()
          await requireParentCurrent()
          await metadata.requireCurrent()
          await images[1]!.requireCurrent()
          return result
        } finally { await copied.close() }
      } finally { await fs.rm(directory, { recursive: true, force: true }) }
    } finally { await Promise.all(images.map((image) => image.close())) }
  } finally { await metadata.close() }
}

async function openWindowsPublisherImage(filename: string, limit: number) {
  if (!path.isAbsolute(filename) || await fs.realpath(filename) !== filename)
    throw new Error("Windows publisher host requires canonical fixed files")
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat({ bigint: true })
    const stamp = (value: typeof before) => [value.dev, value.ino, value.size, value.mode, value.nlink, value.mtimeNs, value.ctimeNs].join(":")
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(limit) ||
      stamp(before) !== stamp(await fs.lstat(filename, { bigint: true })))
      throw new Error("Windows publisher host fixed file rejected")
    const content = await file.readFile()
    const sha256 = createHash("sha256").update(content).digest("hex")
    const requireCurrent = async () => {
      if (stamp(before) !== stamp(await file.stat({ bigint: true })) ||
        stamp(before) !== stamp(await fs.lstat(filename, { bigint: true })) || await fs.realpath(filename) !== filename)
        throw new Error("Windows publisher host fixed file changed")
      const current = Buffer.alloc(content.length)
      const read = { bytes: 0 }
      while (read.bytes < current.length) {
        const next = await file.read(current, read.bytes, current.length - read.bytes, read.bytes)
        if (!next.bytesRead) break
        read.bytes += next.bytesRead
      }
      if (read.bytes !== current.length || createHash("sha256").update(current).digest("hex") !== sha256 ||
        stamp(before) !== stamp(await file.stat({ bigint: true })) || stamp(before) !== stamp(await fs.lstat(filename, { bigint: true })))
        throw new Error("Windows publisher host fixed bytes changed")
    }
    if (content.length !== Number(before.size)) throw new Error("Windows publisher host fixed bytes incomplete")
    await requireCurrent()
    return { content, sha256, requireCurrent, close: () => file.close() }
  } catch (error) { await file.close(); throw error }
}

/** This is the existing internal publisher pin. It is unrelated to Windows
 * application signing, SAC, or a user installation license. */
export function windowsNativePublisherPin(publicKey: string | KeyObject) {
  const key = typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new Error("Windows Native publisher requires an Ed25519 public pin")
  const der = key.export({ type: "spki", format: "der" })
  if (der.length !== 44 || der.subarray(0, 12).toString("hex") !== "302a300506032b6570032100") throw new Error("Windows Native publisher pin encoding rejected")
  return der.subarray(12).toString("hex")
}

/** Target-platform build only. Root owns publication of the returned artifact;
 * this operation never registers a native port or grants runtime authority. */
export async function buildWindowsNativeBootstrap(input: { repository: string; staging: string; publicKey: string | KeyObject }) {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch) ||
    !path.isAbsolute(input.repository) || !path.isAbsolute(input.staging)) throw new Error("Windows Native requires its actual target platform and owned staging")
  const directory = path.join(input.staging, "native-bootstrap-cargo")
  const child = Bun.spawn(["cargo", "build", "--locked", "--release", "--lib", "--bin", "deepagent-work-process-supervisor"], {
    cwd: path.join(input.repository, "packages/work-file-helper"),
    env: { ...process.env, CARGO_TARGET_DIR: directory, DAC_NATIVE_PRELOADER_PUBLISHER_HEX: windowsNativePublisherPin(input.publicKey) },
    stdout: "inherit", stderr: "inherit",
  })
  if (await child.exited !== 0) throw new Error("Windows Native bootstrap build failed")
  const bytes = await fs.readFile(path.join(directory, "release/native_image_factory.dll"))
  if (bytes.length < 64 || bytes.length > LIMIT || bytes.subarray(0, 2).toString() !== "MZ") throw new Error("Windows Native bootstrap is not a bounded PE image")
  const pe = bytes.readUInt32LE(0x3c)
  if (pe > bytes.length - 24 || bytes.subarray(pe, pe + 4).toString("hex") !== "50450000" ||
    bytes.readUInt16LE(pe + 4) !== (process.arch === "arm64" ? 0xaa64 : 0x8664)) throw new Error("Windows Native bootstrap target ABI mismatch")
  const asset = path.join(input.staging, "native-image-factory.node")
  await fs.writeFile(asset, bytes, { flag: "wx" })
  if (!process.versions.bun) throw new Error("Windows command runtime must be the original build Bun executable")
  const assets = await Promise.all(([
    { name: "deepagent-work-process-supervisor.exe", source: path.join(directory, "release/deepagent-work-process-supervisor.exe") },
    { name: "bun-command-runtime.exe", source: process.execPath },
  ] as const).map((entry) => copyWindowsWorkBuildImage({ ...entry, staging: input.staging, cargoDirectory: directory,
    architecture: process.arch === "arm64" ? "arm64" : "x64" })))
  const licenses = await Promise.all(["ed25519-dalek.LICENSE", "curve25519-dalek.LICENSE", "NOTICE"].map(async (name) => {
    const content = await fs.readFile(path.join(input.repository, "packages/work-file-helper", name))
    await fs.writeFile(path.join(input.staging, name), content, { flag: "wx" })
    return Object.freeze({ path: `packages/work-file-helper/bin/win32-${process.arch}/${name}`, bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex") })
  }))
  return Object.freeze({ assets: Object.freeze(assets), licenses: Object.freeze(licenses), filename: asset, path: `packages/work-file-helper/bin/win32-${process.arch}/native-image-factory.node`,
    bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), publisherPin: windowsNativePublisherPin(input.publicKey) })
}

/** Copies only the build-owned fixed images. Cargo's unique source hardlink is
 * checked before an exclusive single-link publication; installed guards stay strict. */
export async function copyWindowsWorkBuildImage(input: {
  name: "deepagent-work-process-supervisor.exe" | "bun-command-runtime.exe"
  source: string
  staging: string
  cargoDirectory: string
  architecture: "x64" | "arm64"
}) {
  if (![input.source, input.staging, input.cargoDirectory].every(path.isAbsolute))
    throw new Error("Windows fixed Work build image requires absolute owned paths")
  const handle = await fs.open(input.source, "r")
  try {
    const before = await handle.stat({ bigint: true })
    const fields = ["dev", "ino", "size", "mode", "nlink", "mtimeNs", "ctimeNs"] as const
    const changed = (value: typeof before) => fields.find((field) => value[field] !== before[field])
    const reject = (predicate: "source_file" | "source_links" | "cargo_alias_missing" | "cargo_alias_multiple" |
      "cargo_alias_file" | "source_symlink" | "bytes_size" | "bytes_bounds" | "pe_magic" | "pe_abi" | "published_single_link" |
      `${"cargo_alias" | "named_before" | "opened_after" | "named_after" | "cargo_alias_after"}_${typeof fields[number]}`) => new Error(`Windows fixed Work build image rejected: asset=${input.name}, predicate=${predicate}`)
    // Cargo omits the executable hash on MSVC so its embedded PDB path stays
    // stable. Both names belong only to this fixed fresh build artifact.
    const aliases = input.name === "deepagent-work-process-supervisor.exe" && before.nlink === 2n
      ? (await fs.readdir(path.join(input.cargoDirectory, "release/deps"))).filter((name) => /^deepagent_work_process_supervisor(?:-[a-f0-9]{16})?\.exe$/.test(name))
      : []
    const alias = aliases.length === 1 ? path.join(input.cargoDirectory, "release/deps", aliases[0]!) : undefined
    const linked = alias ? await fs.lstat(alias, { bigint: true }) : undefined
    const named = await fs.lstat(input.source, { bigint: true })
    const content = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    const final = await fs.lstat(input.source, { bigint: true })
    const finalAlias = alias ? await fs.lstat(alias, { bigint: true }) : undefined
    if (!before.isFile()) throw reject("source_file")
    if (before.nlink !== 1n) {
      if (before.nlink !== 2n || input.name !== "deepagent-work-process-supervisor.exe") throw reject("source_links")
      if (aliases.length !== 1) throw reject(aliases.length === 0 ? "cargo_alias_missing" : "cargo_alias_multiple")
      if (!linked?.isFile() || linked.isSymbolicLink()) throw reject("cargo_alias_file")
      const aliasChanged = changed(linked)
      if (aliasChanged) throw reject(`cargo_alias_${aliasChanged}`)
    }
    if (named.isSymbolicLink()) throw reject("source_symlink")
    const namedChanged = changed(named)
    const openedChanged = changed(after)
    const finalChanged = changed(final)
    const finalAliasChanged = finalAlias && changed(finalAlias)
    if (namedChanged) throw reject(`named_before_${namedChanged}`)
    if (openedChanged) throw reject(`opened_after_${openedChanged}`)
    if (finalChanged) throw reject(`named_after_${finalChanged}`)
    if (finalAliasChanged) throw reject(`cargo_alias_after_${finalAliasChanged}`)
    if (content.length !== Number(before.size)) throw reject("bytes_size")
    if (content.length < 64 || content.length > LIMIT) throw reject("bytes_bounds")
    if (content.subarray(0, 2).toString() !== "MZ") throw reject("pe_magic")
    const offset = content.readUInt32LE(0x3c)
    if (offset > content.length - 24 || content.subarray(offset, offset + 4).toString("hex") !== "50450000" ||
      content.readUInt16LE(offset + 4) !== (input.architecture === "arm64" ? 0xaa64 : 0x8664)) throw reject("pe_abi")
    await fs.writeFile(path.join(input.staging, input.name), content, { flag: "wx" })
    const copied = await fs.lstat(path.join(input.staging, input.name), { bigint: true })
    if (!copied.isFile() || copied.isSymbolicLink() || copied.nlink !== 1n || copied.size !== BigInt(content.length))
      throw reject("published_single_link")
    return Object.freeze({ path: `packages/work-file-helper/bin/win32-${input.architecture}/${input.name}` as const,
      bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") })
  } finally { await handle.close() }
}

/** Runs after final sidecar and sealed Node bytes exist. Names/placement are
 * compiler constants; no caller-chosen image or command path enters the ticket. */
export async function signWindowsNativeSidecar(input: { mainDirectory: string; privateKey: KeyObject; bootstrapHash: string; publisherPin: string }) {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch) || !path.isAbsolute(input.mainDirectory) || input.privateKey.type !== "private" || input.privateKey.asymmetricKeyType !== "ed25519" ||
    windowsNativePublisherPin(createPublicKey(input.privateKey)) !== input.publisherPin || !/^[a-f0-9]{64}$/.test(input.bootstrapHash))
    throw new Error("Windows Native sidecar publisher rejected")
  const images = await Promise.all(names.map(async (name) => {
    const filename = name === "sidecar.js" ? path.join(input.mainDirectory, name) : path.join(input.mainDirectory, "chunks", name)
    const initial = await fs.lstat(filename, { bigint: true })
    if (!initial.isFile() || initial.nlink !== 1n || initial.size < 1n || initial.size > BigInt(LIMIT) || await fs.realpath(filename) !== filename)
      throw new Error("Windows Native publisher artifact rejected")
    const handle = await fs.open(filename, "r")
    try {
      const before = await handle.stat({ bigint: true })
      const stamp = (value: typeof before) => [value.dev, value.ino, value.size, value.mode, value.nlink, value.mtimeNs, value.ctimeNs].join(":")
      const bytes = await handle.readFile()
      if (stamp(before) !== stamp(initial) || stamp(before) !== stamp(await handle.stat({ bigint: true })) ||
        stamp(before) !== stamp(await fs.lstat(filename, { bigint: true })) || bytes.length !== Number(before.size) || await fs.realpath(filename) !== filename)
        throw new Error("Windows Native publisher artifact changed")
      return { bytes: bytes.length, name, sha256: createHash("sha256").update(bytes).digest("hex") }
    } finally { await handle.close() }
  }))
  if (images[0].sha256 !== input.bootstrapHash) throw new Error("Windows Native bootstrap differs from the original build")
  const payload = { domain: "dac.windows-native-preloader.v1", images, purpose: "desktop-sidecar", target: `win32-${process.arch}` }
  const manifest = { payload, signature: sign(null, Buffer.from(CanonicalJson.stringify(payload)), input.privateKey).toString("hex") }
  const file = await fs.open(path.join(input.mainDirectory, "chunks/native-preloader.installation.json"), "wx")
  try { await file.writeFile(CanonicalJson.stringify(manifest)); await file.sync() } finally { await file.close() }
  return Object.freeze({ sha256: createHash("sha256").update(CanonicalJson.stringify(manifest)).digest("hex"), images, publisherPin: input.publisherPin })
}
