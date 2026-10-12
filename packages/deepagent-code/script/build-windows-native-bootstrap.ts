import fs from "node:fs/promises"
import path from "node:path"
import { createHash, createPublicKey, sign, type KeyObject } from "node:crypto"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"

const LIMIT = 268_435_456
const names = ["native-image-factory.node", "node.js", "sidecar.js"] as const

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
  const assets = await Promise.all([
    { name: "deepagent-work-process-supervisor.exe", source: path.join(directory, "release/deepagent-work-process-supervisor.exe") },
    { name: "bun-command-runtime.exe", source: process.execPath },
  ].map(async (entry) => {
    const handle = await fs.open(entry.source, "r")
    try {
      const before = await handle.stat({ bigint: true })
      const stamp = (value: typeof before) => [value.dev, value.ino, value.size, value.mode, value.nlink, value.mtimeNs, value.ctimeNs].join(":")
      // Cargo publishes its fixed executable as a second link to the corresponding deps artifact.
      // This exception is confined to our fresh owned build tree; installed images still require one link.
      const aliases = entry.name === "deepagent-work-process-supervisor.exe" && before.nlink === 2n
        ? (await fs.readdir(path.join(directory, "release/deps"))).filter((name) => /^deepagent_work_process_supervisor-[a-f0-9]{16}\.exe$/.test(name))
        : []
      const alias = aliases.length === 1 ? path.join(directory, "release/deps", aliases[0]!) : undefined
      const linked = alias ? await fs.lstat(alias, { bigint: true }) : undefined
      const cargoLink = linked?.isFile() === true && !linked.isSymbolicLink() && stamp(linked) === stamp(before)
      const named = await fs.lstat(entry.source, { bigint: true })
      const content = await handle.readFile()
      const after = await handle.stat({ bigint: true })
      if (!before.isFile() || (before.nlink !== 1n && !(before.nlink === 2n && cargoLink)) || named.isSymbolicLink() ||
        stamp(named) !== stamp(before) || stamp(after) !== stamp(before) ||
        stamp(await fs.lstat(entry.source, { bigint: true })) !== stamp(before) ||
        (alias && stamp(await fs.lstat(alias, { bigint: true })) !== stamp(before)) ||
        content.length !== Number(before.size) || content.length < 64 || content.length > LIMIT ||
        content.subarray(0, 2).toString() !== "MZ") throw new Error("Windows fixed Work build image changed or is invalid")
      const offset = content.readUInt32LE(0x3c)
      if (offset > content.length - 24 || content.subarray(offset, offset + 4).toString("hex") !== "50450000" ||
        content.readUInt16LE(offset + 4) !== (process.arch === "arm64" ? 0xaa64 : 0x8664)) throw new Error("Windows fixed Work build image ABI mismatch")
      await fs.writeFile(path.join(input.staging, entry.name), content, { flag: "wx" })
      const copied = await fs.lstat(path.join(input.staging, entry.name), { bigint: true })
      if (!copied.isFile() || copied.isSymbolicLink() || copied.nlink !== 1n || copied.size !== BigInt(content.length))
        throw new Error("Windows fixed Work published image must have one original link")
      return Object.freeze({ path: `packages/work-file-helper/bin/win32-${process.arch}/${entry.name}`, bytes: content.length,
        sha256: createHash("sha256").update(content).digest("hex") })
    } finally { await handle.close() }
  }))
  const licenses = await Promise.all(["ed25519-dalek.LICENSE", "curve25519-dalek.LICENSE", "NOTICE"].map(async (name) => {
    const content = await fs.readFile(path.join(input.repository, "packages/work-file-helper", name))
    await fs.writeFile(path.join(input.staging, name), content, { flag: "wx" })
    return Object.freeze({ path: `packages/work-file-helper/bin/win32-${process.arch}/${name}`, bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex") })
  }))
  return Object.freeze({ assets: Object.freeze(assets), licenses: Object.freeze(licenses), filename: asset, path: `packages/work-file-helper/bin/win32-${process.arch}/native-image-factory.node`,
    bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), publisherPin: windowsNativePublisherPin(input.publicKey) })
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
