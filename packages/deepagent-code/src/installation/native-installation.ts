import { constants, type BigIntStats } from "node:fs"
import fs from "node:fs/promises"
import { createHash, createPublicKey, verify } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Option, Schema } from "effect"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { NativeInstallationSchema } from "./native-installation.schema"

declare const DEEPAGENT_CODE_NATIVE_RUNTIME_PUBLIC_KEY: string | undefined
declare const DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST: string | undefined
declare const DEEPAGENT_CODE_NATIVE_NODE_ARTIFACT: boolean | undefined

declare const verified: unique symbol
/** A process-local installation fact. It grants no route, factory, credential or execution authority. */
export interface VerifiedInstalledComponents {
  readonly [verified]: true
}

export interface Description {
  readonly releaseID: string
  readonly target: string
  readonly sourceCommit: string
  readonly sourceTree: string
  readonly componentsHash: string
  readonly executableHash: string
  readonly executableBytes: number
  readonly signerHash: string
  readonly manifestHash: string
}

type Snapshot = {
  readonly description: Description
  readonly executableIdentity: string
  readonly manifestIdentity: string
  readonly runtimeIdentity?: string
  readonly components: readonly Readonly<{ path: string; bytes: number; sha256: string }>[]
}

const handles = new WeakMap<object, Snapshot>()
const nodeArtifact = typeof DEEPAGENT_CODE_NATIVE_NODE_ARTIFACT === "boolean" && DEEPAGENT_CODE_NATIVE_NODE_ARTIFACT &&
  !process.versions.bun && import.meta.url.startsWith("file:") && new URL(import.meta.url).pathname.endsWith("/node.js")
const executablePath = nodeArtifact ? fileURLToPath(import.meta.url) : process.execPath
const pin = typeof DEEPAGENT_CODE_NATIVE_RUNTIME_PUBLIC_KEY === "string" ? DEEPAGENT_CODE_NATIVE_RUNTIME_PUBLIC_KEY : ""
const componentsText =
  typeof DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST === "string" ? DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST : ""
// A source invocation cannot turn its Bun interpreter into a DAC artifact, even by setting similarly named globals.
const windowsCompiled = process.platform === "win32" && !!process.versions.bun &&
  (import.meta.url.startsWith("file:///$bunfs/") || import.meta.url.startsWith("B:/~BUN/") ||
    import.meta.url.startsWith("file:///B:/~BUN/") || (typeof Bun !== "undefined" && Bun.main.startsWith("B:/~BUN/")))
const compiled = import.meta.url.startsWith("file:///$bunfs/") || nodeArtifact || windowsCompiled

export const current = Effect.fn("NativeInstallation.current")(function* () {
  const snapshot = yield* inspect()
  const handle = Object.freeze(Object.create(null)) as VerifiedInstalledComponents
  handles.set(handle, snapshot)
  return handle
})

export const describe = Effect.fn("NativeInstallation.describe")(function* (handle: VerifiedInstalledComponents) {
  const snapshot = lookup(handle)
  if (!snapshot) return yield* refusal("NATIVE_HANDLE_INVALID")
  return snapshot.description
})

/** Inventory comes only from the verified embedded manifest. No path/hash supplied by a caller
 * can add a component, and the returned records cannot mutate the private installation fact. */
export const inventory = Effect.fn("NativeInstallation.inventory")(function* (handle: VerifiedInstalledComponents) {
  yield* requireCurrent(handle)
  return lookup(handle)!.components
})

/** The fixed verified entry owns its adjacent assets. Electron's interpreter lives
 * elsewhere; callers may not substitute a resource directory or executable path. */
export const assetDirectory = Effect.fn("NativeInstallation.assetDirectory")(function* (handle: VerifiedInstalledComponents) {
  // This locates assets, rather than granting current authority. Callers first read
  // the verified inventory, which already revalidates the installation bytes.
  if (!lookup(handle)) return yield* refusal("NATIVE_HANDLE_INVALID")
  return path.dirname(executablePath)
})

/** Re-observe the original installation rather than trusting a prior success.
 * Windows uses its original held, write-excluding Native capture; POSIX rehashes.
 * A changed identity is never silently adopted. */
export const requireCurrent = Effect.fn("NativeInstallation.requireCurrent")(function* (
  handle: VerifiedInstalledComponents,
) {
  const prior = lookup(handle)
  if (!prior) return yield* refusal("NATIVE_HANDLE_INVALID")
  const actual = yield* inspect().pipe(Effect.tapError(() => Effect.sync(() => handles.delete(handle))))
  if (
    actual.executableIdentity !== prior.executableIdentity ||
    actual.manifestIdentity !== prior.manifestIdentity ||
    actual.runtimeIdentity !== prior.runtimeIdentity ||
    CanonicalJson.stringify(actual.description) !== CanonicalJson.stringify(prior.description)
  ) {
    handles.delete(handle)
    return yield* refusal("NATIVE_IDENTITY_CHANGED")
  }
  return prior.description
})

function lookup(handle: VerifiedInstalledComponents) {
  return typeof handle === "object" && handle !== null ? handles.get(handle) : undefined
}

function refusal(code: typeof NativeInstallationSchema.ErrorCode.Type) {
  return new NativeInstallationSchema.Error({ code, message: "Native installation verification is unavailable" })
}

function digest(input: string | Uint8Array) {
  return createHash("sha256").update(input).digest("hex")
}

function identity(stat: BigIntStats) {
  return [stat.dev, stat.ino, stat.size, stat.mode, stat.uid, stat.gid, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(
    ":",
  )
}

function requireFile(stat: BigIntStats, limit: number) {
  if (!stat.isFile() || stat.size < 1n || stat.size > BigInt(limit) || stat.nlink !== 1n || (stat.mode & 0o022n) !== 0n)
    throw refusal("NATIVE_INSTALLATION_UNAVAILABLE")
}

// O_NOFOLLOW alone does not protect the parent path. Compare canonical path and path stat to the
// same descriptor before and after reading; NONBLOCK prevents a raced FIFO from hanging startup.
async function readVerifiedFile(
  filename: string,
  limit: number,
  text: boolean,
  windows?: Awaited<ReturnType<typeof originalWindowsRead>>,
) {
  if (process.platform === "win32" && (nodeArtifact || windowsCompiled)) {
    if (!windows) throw refusal("NATIVE_INSTALLATION_UNAVAILABLE")
    const observed = filename === executablePath ? windows.artifact
      : filename === `${executablePath}${NativeInstallationSchema.SIDECAR_SUFFIX}` ? windows.manifest
      : filename === process.execPath ? windows.runtime : undefined
    if (!observed || observed.bytes > limit || (text ? typeof observed.text !== "string" : observed.text !== null) ||
      (text && Buffer.byteLength(observed.text!) !== observed.bytes)) throw refusal("NATIVE_INSTALLATION_UNAVAILABLE")
    return { identity: observed.identity, hash: observed.hash, bytes: observed.bytes,
      ...(text ? { text: observed.text! } : {}) }
  }
  if ((await fs.realpath(filename)) !== filename) throw refusal("NATIVE_IDENTITY_CHANGED")
  const initial = await fs.lstat(filename, { bigint: true })
  requireFile(initial, limit)
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat({ bigint: true })
    requireFile(before, limit)
    if (identity(before) !== identity(initial)) throw refusal("NATIVE_IDENTITY_CHANGED")
    const hash = createHash("sha256")
    const chunks: Buffer[] = []
    const buffer = Buffer.alloc(65_536)
    const count = { bytes: 0 }
    while (true) {
      const result = await file.read(buffer, 0, buffer.byteLength, null)
      if (result.bytesRead === 0) break
      count.bytes += result.bytesRead
      if (count.bytes > limit) throw refusal("NATIVE_INSTALLATION_UNAVAILABLE")
      hash.update(buffer.subarray(0, result.bytesRead))
      if (text) chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)))
    }
    const after = await file.stat({ bigint: true })
    const named = await fs.lstat(filename, { bigint: true })
    if (
      identity(before) !== identity(after) ||
      identity(after) !== identity(named) ||
      BigInt(count.bytes) !== after.size ||
      (await fs.realpath(filename)) !== filename
    )
      throw refusal("NATIVE_IDENTITY_CHANGED")
    const content = text ? Buffer.concat(chunks) : undefined
    const decoded = content ? new TextDecoder("utf-8", { fatal: true }).decode(content) : undefined
    if (content && decoded !== undefined && !Buffer.from(decoded, "utf8").equals(content))
      throw refusal("NATIVE_MANIFEST_INVALID")
    return {
      identity: identity(after),
      hash: hash.digest("hex"),
      bytes: count.bytes,
      text: decoded,
    }
  } finally {
    await file.close()
  }
}

async function originalWindowsRead() {
  if (process.platform !== "win32" || !(nodeArtifact || windowsCompiled)) return
  const { NativeWindowsBootstrap } = await import("./windows-native-bootstrap")
  return NativeWindowsBootstrap.readInstallation()
}

function inspect() {
  return Effect.tryPromise({
    try: async (): Promise<Snapshot> => {
      if (
        !compiled ||
        !path.isAbsolute(executablePath) ||
        !pin ||
        Buffer.byteLength(pin) > 4096 ||
        !componentsText ||
        Buffer.byteLength(componentsText) > NativeInstallationSchema.COMPONENTS_LIMIT
      )
        throw refusal("NATIVE_INSTALLATION_UNAVAILABLE")
      const components = Schema.decodeUnknownOption(Schema.fromJsonString(NativeInstallationSchema.Components), {
        onExcessProperty: "error",
      })(componentsText)
      if (Option.isNone(components) || CanonicalJson.stringify(components.value) !== componentsText)
        throw refusal("NATIVE_MANIFEST_INVALID")
      const paths = components.value.components.map((entry) => entry.path)
      if (
        new Set(paths).size !== paths.length ||
        paths.some((entry) => entry.split("/").some((part) => part === "." || part === "..")) ||
        paths.join("\n") !== paths.toSorted().join("\n")
      )
        throw refusal("NATIVE_MANIFEST_INVALID")
      // One original Native batch already contains all three held files. Keep
      // it local to this inspection and compare a second current batch at the
      // end, rather than repeating the complete image graph for each member.
      const windows = await originalWindowsRead()
      const manifest = await readVerifiedFile(
        `${executablePath}${NativeInstallationSchema.SIDECAR_SUFFIX}`,
        NativeInstallationSchema.MANIFEST_LIMIT,
        true,
        windows,
      )
      const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Union([
        NativeInstallationSchema.Manifest, NativeInstallationSchema.NodeManifest,
      ])), { onExcessProperty: "error" })(manifest.text)
      if (Option.isNone(decoded) || CanonicalJson.stringify(decoded.value) !== manifest.text ||
        decoded.value.payload.domain !== (nodeArtifact ? NativeInstallationSchema.NODE_DOMAIN : NativeInstallationSchema.DOMAIN))
        throw refusal("NATIVE_MANIFEST_INVALID")
      const key = createPublicKey(pin)
      if (
        key.asymmetricKeyType !== "ed25519" ||
        !verify(
          null,
          Buffer.from(CanonicalJson.stringify(decoded.value.payload)),
          key,
          Buffer.from(decoded.value.signature, "hex"),
        )
      )
        throw refusal("NATIVE_SIGNATURE_INVALID")
      const payload = decoded.value.payload
      if (payload.target !== `${process.platform}-${process.arch}` || components.value.target !== payload.target)
        throw refusal("NATIVE_TARGET_MISMATCH")
      if (
        payload.componentsHash !== digest(componentsText) ||
        payload.sourceCommit !== components.value.sourceCommit ||
        payload.sourceTree !== components.value.sourceTree
      )
        throw refusal("NATIVE_COMPONENTS_MISMATCH")
      const executable = await readVerifiedFile(executablePath, NativeInstallationSchema.EXECUTABLE_LIMIT, false, windows)
      if (executable.hash !== payload.executable.sha256 || executable.bytes !== payload.executable.bytes)
        throw refusal("NATIVE_BYTES_MISMATCH")
      const runtime = "runtime" in payload
        ? await readVerifiedFile(process.execPath, NativeInstallationSchema.EXECUTABLE_LIMIT, false, windows)
        : undefined
      if (runtime && "runtime" in payload &&
        (runtime.hash !== payload.runtime.sha256 || runtime.bytes !== payload.runtime.bytes))
        throw refusal("NATIVE_BYTES_MISMATCH")
      // Recheck the sidecar after the potentially longer executable hash, too.
      const finalWindows = await originalWindowsRead()
      const finalManifest = await readVerifiedFile(
        `${executablePath}${NativeInstallationSchema.SIDECAR_SUFFIX}`,
        NativeInstallationSchema.MANIFEST_LIMIT,
        true,
        finalWindows,
      )
      if (
        manifest.identity !== finalManifest.identity ||
        manifest.hash !== finalManifest.hash ||
        (windows && (!finalWindows || (["artifact", "manifest", "runtime"] as const).some((name) =>
          windows[name].identity !== finalWindows[name].identity ||
          windows[name].hash !== finalWindows[name].hash ||
          windows[name].bytes !== finalWindows[name].bytes ||
          windows[name].text !== finalWindows[name].text))) ||
        (process.platform !== "win32" && (identity(await fs.lstat(executablePath, { bigint: true })) !== executable.identity ||
          (runtime && identity(await fs.lstat(process.execPath, { bigint: true })) !== runtime.identity) ||
          (await fs.realpath(executablePath)) !== executablePath))
      )
        throw refusal("NATIVE_IDENTITY_CHANGED")
      return {
        components: Object.freeze(
          components.value.components.map((component) =>
            Object.freeze({
              path: component.path,
              bytes: component.bytes,
              sha256: component.sha256,
            }),
          ),
        ),
        description: Object.freeze({
          releaseID: payload.releaseID,
          target: payload.target,
          sourceCommit: payload.sourceCommit,
          sourceTree: payload.sourceTree,
          componentsHash: payload.componentsHash,
          executableHash: executable.hash,
          executableBytes: executable.bytes,
          signerHash: digest(key.export({ type: "spki", format: "der" })),
          manifestHash: manifest.hash,
        }),
        executableIdentity: executable.identity,
        manifestIdentity: manifest.identity,
        ...(runtime ? { runtimeIdentity: runtime.identity } : {}),
      }
    },
    catch: (error) =>
      error instanceof NativeInstallationSchema.Error ? error : refusal("NATIVE_INSTALLATION_UNAVAILABLE"),
  })
}

export * as NativeInstallation from "./native-installation"
