import fs from "node:fs/promises"
import { constants } from "node:fs"
import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto"
import { parseArgs } from "node:util"
import { Schema } from "effect"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { NativeInstallationSchema } from "../src/installation/native-installation.schema"

/** Publisher-only operation, never called by the runtime. Both fixed artifacts are
 * read through a stable descriptor before signing; no private key enters metadata. */
export async function signNativeNodeArtifact(input: {
  module: string
  runtime: string
  releaseID: string
  privateKey: KeyObject
}) {
  if (input.privateKey.asymmetricKeyType !== "ed25519" || input.privateKey.type !== "private")
    throw new Error("Native Node publisher requires an Ed25519 private key")
  const components = Schema.decodeUnknownSync(Schema.fromJsonString(NativeInstallationSchema.Components), {
    onExcessProperty: "error",
  })(await fs.readFile(`${input.module}.native-components.json`, "utf8"))
  const publisher = process.platform === "win32" ? await windowsPublisher(input.module, input.runtime, components) : undefined
  try {
    const payload = new NativeInstallationSchema.NodePayload({ domain: NativeInstallationSchema.NODE_DOMAIN,
      releaseID: input.releaseID, target: components.target, sourceCommit: components.sourceCommit,
      sourceTree: components.sourceTree, componentsHash: createHash("sha256").update(CanonicalJson.stringify(components)).digest("hex"),
      executable: publisher?.description.artifact ?? await fingerprint(input.module),
      runtime: publisher?.description.runtime ?? await fingerprint(input.runtime) })
    const manifest = new NativeInstallationSchema.NodeManifest({ payload,
      signature: sign(null, Buffer.from(CanonicalJson.stringify(payload)), input.privateKey).toString("hex") })
    publisher?.requireCurrent()
    const file = await fs.open(`${input.module}${NativeInstallationSchema.SIDECAR_SUFFIX}`, "wx", 0o644)
    try {
      await file.writeFile(CanonicalJson.stringify(manifest), "utf8")
      await file.sync()
      publisher?.requireCurrent()
    } finally {
      await file.close()
    }
    return { payload, signerHash: createHash("sha256").update(createPublicKey(input.privateKey).export({ type: "spki", format: "der" })).digest("hex") }
  } finally { publisher?.close() }

}

/** Compiled binaries keep the original executable-only Payload domain. The
 * Windows issuer reads its fixed PE through Native, never through mode bits. */
export async function signNativeCliArtifact(input: {
  executable: string
  releaseID: string
  privateKey: KeyObject
}) {
  if (input.privateKey.asymmetricKeyType !== "ed25519" || input.privateKey.type !== "private")
    throw new Error("Native CLI publisher requires an Ed25519 private key")
  const components = Schema.decodeUnknownSync(Schema.fromJsonString(NativeInstallationSchema.Components), {
    onExcessProperty: "error",
  })(await fs.readFile(`${input.executable}.native-components.json`, "utf8"))
  const publisher = process.platform === "win32"
    ? await windowsPublisher(input.executable, input.executable, components, "offline-cli-publisher") : undefined
  try {
    const payload = new NativeInstallationSchema.Payload({ domain: NativeInstallationSchema.DOMAIN,
      releaseID: input.releaseID, target: components.target, sourceCommit: components.sourceCommit,
      sourceTree: components.sourceTree, componentsHash: createHash("sha256").update(CanonicalJson.stringify(components)).digest("hex"),
      executable: publisher?.description.artifact ?? await fingerprint(input.executable) })
    const manifest = new NativeInstallationSchema.Manifest({ payload,
      signature: sign(null, Buffer.from(CanonicalJson.stringify(payload)), input.privateKey).toString("hex") })
    publisher?.requireCurrent()
    const file = await fs.open(`${input.executable}${NativeInstallationSchema.SIDECAR_SUFFIX}`, "wx", 0o644)
    try {
      await file.writeFile(CanonicalJson.stringify(manifest), "utf8")
      await file.sync()
      publisher?.requireCurrent()
    } finally { await file.close() }
    return { payload, signerHash: createHash("sha256").update(createPublicKey(input.privateKey).export({ type: "spki", format: "der" })).digest("hex") }
  } finally { publisher?.close() }
}

const PublisherDescription = Schema.Struct({ version: Schema.Literal(1), purpose: Schema.Literal("offline-node-publisher"),
  artifact: NativeInstallationSchema.Executable, runtime: NativeInstallationSchema.Executable })
const CliPublisherDescription = Schema.Struct({ version: Schema.Literal(1), purpose: Schema.Literal("offline-cli-publisher"),
  artifact: NativeInstallationSchema.Executable, runtime: NativeInstallationSchema.Executable })
const WorkRuntimePreparation = Schema.Struct({ version: Schema.Literal(1), purpose: Schema.Literal("offline-work-runtime-readonly"),
  target: Schema.String, asset_path: Schema.String,
  identity: Schema.Struct({ kind: Schema.Literal("windows"), volume_serial: Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/)),
    file_id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)) }),
  sha256: NativeInstallationSchema.Executable.fields.sha256, bytes: NativeInstallationSchema.Executable.fields.bytes,
  arap_mask: Schema.Literal(0x0012_00a9), work_authority: Schema.Literal(false),
})
type PublisherPort = Readonly<{
  capture: object
  current(capture: object): boolean
  preloaded(capture: object): boolean
  prepareWorkRuntime(capture: object): string
  prepareCliWorkRuntime?(capture: object): string
  openPublisher(capture: object, request: string): object
  readPublisher(capture: object, lease: object): string
  closePublisher(capture: object, lease: object): void
}>

/** This offline issuer reader cannot register an Installed/Root/Work authority.
 * Its original Native lease holds both candidate files and their ancestors until
 * the signed manifest has been flushed. POSIX runtime checks remain unchanged. */
async function windowsPublisher(module: string, runtime: string, components: NativeInstallationSchema.Components,
  purpose: "offline-node-publisher" | "offline-cli-publisher" = "offline-node-publisher") {
  if (components.target !== `win32-${process.arch}` || await fs.realpath(module) !== module || await fs.realpath(runtime) !== runtime)
    throw new Error("Windows publisher requires its exact physical target files")
  const { createRequire } = await import("node:module")
  const { pathToFileURL, fileURLToPath } = await import("node:url")
  const native: unknown = createRequire(pathToFileURL(module))(fileURLToPath(new URL("./native-image-factory.node", pathToFileURL(module))))
  if (!native || typeof native !== "object" || !Object.isFrozen(native) || !("capture" in native) ||
    !("current" in native) || typeof native.current !== "function" || !("preloaded" in native) || typeof native.preloaded !== "function" ||
    !("prepareWorkRuntime" in native) || typeof native.prepareWorkRuntime !== "function" ||
    !("openPublisher" in native) || typeof native.openPublisher !== "function" ||
    !("readPublisher" in native) || typeof native.readPublisher !== "function" ||
    !("closePublisher" in native) || typeof native.closePublisher !== "function") throw new Error("Windows Native publisher unavailable")
  const original = native as PublisherPort
  if (!original.current(original.capture) || original.preloaded(original.capture)) throw new Error("Windows publisher requires its offline original Native capture")
  // The Native publisher selects only its adjacent, inventoried Bun image and
  // grants a non-inheriting ARAP RX ACE before its immutable lease is opened.
  // This is installation preparation, not a Work or AppContainer permit.
  const prepare = purpose === "offline-cli-publisher" ? original.prepareCliWorkRuntime : original.prepareWorkRuntime
  if (typeof prepare !== "function") throw new Error("Windows fixed CLI runtime preparation unavailable")
  const prepared = Schema.decodeUnknownSync(Schema.fromJsonString(WorkRuntimePreparation), { onExcessProperty: "error" })(
    prepare(original.capture),
  )
  const fixed = components.components.filter((component) => component.path === `packages/work-file-helper/bin/${components.target}/bun-command-runtime.exe`)
  if (fixed.length !== 1 || prepared.target !== components.target || prepared.asset_path !== fixed[0]!.path ||
    prepared.sha256 !== fixed[0]!.sha256 || prepared.bytes !== fixed[0]!.bytes || !original.current(original.capture) || original.preloaded(original.capture))
    throw new Error("Windows fixed Work runtime preparation changed")
  const lease = original.openPublisher(original.capture, CanonicalJson.stringify({ version: 1, purpose, module, runtime }))
  try {
    const text = original.readPublisher(original.capture, lease)
    const description = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Union([PublisherDescription, CliPublisherDescription])), { onExcessProperty: "error" })(text)
    if (description.purpose !== purpose || (purpose === "offline-cli-publisher" &&
      CanonicalJson.stringify(description.artifact) !== CanonicalJson.stringify(description.runtime)))
      throw new Error("Windows publisher purpose or fixed CLI image differs")
    return Object.freeze({ description,
      requireCurrent() {
        if (!original.current(original.capture) || original.preloaded(original.capture) || original.readPublisher(original.capture, lease) !== text)
          throw new Error("Windows Native publisher observation changed")
      },
      close: () => original.closePublisher(original.capture, lease),
    })
  } catch (error) { original.closePublisher(original.capture, lease); throw error }
}

async function fingerprint(filename: string) {
  if (await fs.realpath(filename) !== filename) throw new Error("Publisher artifact must have a canonical physical path")
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n ||
      before.size > BigInt(NativeInstallationSchema.EXECUTABLE_LIMIT) || (before.mode & 0o022n) !== 0n)
      throw new Error("Publisher artifact is not a bounded private file")
    const hash = createHash("sha256")
    const buffer = Buffer.alloc(65_536)
    const bytes = { value: 0 }
    while (true) {
      const read = await file.read(buffer, 0, buffer.length, null)
      if (!read.bytesRead) break
      bytes.value += read.bytesRead
      if (bytes.value > Number(before.size)) throw new Error("Publisher artifact changed while reading")
      hash.update(buffer.subarray(0, read.bytesRead))
    }
    const stamp = (value: typeof before) => [value.dev, value.ino, value.size, value.mode, value.nlink, value.mtimeNs, value.ctimeNs].join(":")
    if (bytes.value !== Number(before.size) || stamp(before) !== stamp(await file.stat({ bigint: true })) ||
      stamp(before) !== stamp(await fs.lstat(filename, { bigint: true })) || await fs.realpath(filename) !== filename)
      throw new Error("Publisher artifact changed while reading")
    return new NativeInstallationSchema.Executable({ bytes: bytes.value, sha256: hash.digest("hex") })
  } finally {
    await file.close()
  }
}

if (import.meta.main) {
  const args = parseArgs({ options: { module: { type: "string" }, runtime: { type: "string" }, key: { type: "string" }, release: { type: "string" } } })
  if (!args.values.module || !args.values.runtime || !args.values.key || !args.values.release)
    throw new Error("Required: --module --runtime --key --release")
  const result = await signNativeNodeArtifact({ module: args.values.module, runtime: args.values.runtime,
    releaseID: args.values.release, privateKey: createPrivateKey(await fs.readFile(args.values.key)) })
  console.log(JSON.stringify(result))
}
