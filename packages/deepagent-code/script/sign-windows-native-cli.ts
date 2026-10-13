import fs from "node:fs/promises"
import path from "node:path"
import { constants } from "node:fs"
import { createHash, createPublicKey, sign, type KeyObject } from "node:crypto"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { NativeInstallationSchema } from "../src/installation/native-installation.schema"
import { Schema } from "effect"

const names = ["native-image-factory.node", "deepagent-code.exe", "deepagent-code.exe.native-components.json"] as const

/** Offline issuer only. The runtime accepts these fixed roles through original
 * inherited handles; this public receipt never creates a Root or Work permit. */
export async function signWindowsNativeCLI(input: { executable: string; privateKey: KeyObject }) {
  if (process.platform !== "win32" || !process.versions.bun || !["x64", "arm64"].includes(process.arch) ||
    path.basename(input.executable) !== "deepagent-code.exe" || input.privateKey.type !== "private" ||
    input.privateKey.asymmetricKeyType !== "ed25519") throw new Error("Windows CLI preloader issuer requires its native fixed candidate")
  const directory = path.dirname(input.executable)
  const images = await Promise.all(names.map(async (name) => {
    const observed = await observe(path.join(directory, name), name.endsWith(".json") ? NativeInstallationSchema.COMPONENTS_LIMIT : 268_435_456)
    return { name, bytes: observed.bytes, sha256: observed.sha256, stamp: observed.stamp }
  }))
  const components = Schema.decodeUnknownSync(Schema.fromJsonString(NativeInstallationSchema.Components), {
    onExcessProperty: "error",
  })(await fs.readFile(path.join(directory, names[2]), "utf8"))
  const expected = components.components.filter((entry) => entry.path === `packages/work-file-helper/bin/${components.target}/${names[0]}`)
  if (components.target !== `win32-${process.arch}` || expected.length !== 1 ||
    expected[0]!.bytes !== images[0]!.bytes || expected[0]!.sha256 !== images[0]!.sha256)
    throw new Error("Windows CLI preloader differs from the compiled fixed Native inventory")
  const payload = { domain: "dac.windows-native-preloader.v1", purpose: "compiled-bun-cli", target: components.target,
    images: images.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })) }
  const text = CanonicalJson.stringify({ payload,
    signature: sign(null, Buffer.from(CanonicalJson.stringify(payload)), input.privateKey).toString("hex") })
  const file = await fs.open(path.join(directory, "native-preloader.installation.json"), "wx", 0o644)
  try {
    await file.writeFile(text, "utf8")
    await file.sync()
    const current = await Promise.all(names.map((name) => observe(path.join(directory, name),
      name.endsWith(".json") ? NativeInstallationSchema.COMPONENTS_LIMIT : 268_435_456)))
    if (current.some((image, index) => image.stamp !== images[index]!.stamp || image.bytes !== images[index]!.bytes ||
      image.sha256 !== images[index]!.sha256)) throw new Error("Windows CLI fixed images changed during issuance")
  } finally { await file.close() }
  return { receiptHash: createHash("sha256").update(text).digest("hex"), imageCount: 3,
    signerHash: createHash("sha256").update(createPublicKey(input.privateKey).export({ type: "spki", format: "der" })).digest("hex") }
}

async function observe(filename: string, limit: number) {
  if (!path.isAbsolute(filename) || await fs.realpath(filename) !== filename)
    throw new Error("Windows CLI issuer requires physical fixed files")
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(limit))
      throw new Error("Windows CLI issuer fixed file rejected")
    const bytes = await file.readFile()
    const stamp = (value: typeof before) => [value.dev, value.ino, value.size, value.mode, value.nlink, value.mtimeNs, value.ctimeNs].join(":")
    if (bytes.length !== Number(before.size) || stamp(before) !== stamp(await file.stat({ bigint: true })) ||
      stamp(before) !== stamp(await fs.lstat(filename, { bigint: true })) || await fs.realpath(filename) !== filename)
      throw new Error("Windows CLI issuer fixed file changed")
    return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), stamp: stamp(before) }
  } finally { await file.close() }
}
