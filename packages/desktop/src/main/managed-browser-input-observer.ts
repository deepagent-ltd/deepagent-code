import type { BrowserWindow } from "electron"
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import path from "node:path"

export type ManagedBrowserInputAsset = Readonly<{
  schemaVersion: "dac.managed-browser-input.darwin.v1"
  target: "darwin-arm64" | "darwin-x64"
  napiVersion: 8
  path: string
  bytes: number
  sha256: string
  sourceSha256: string
}>

type NativeLease = { healthy(): boolean; release(): void }
type NativeObserver = { version: 1; observe(handle: Buffer, invalidate: () => void): NativeLease }

/** Main-only: asset is a publisher manifest selected by the fixed product build. */
export function observeManagedBrowserInput(input: {
  window: BrowserWindow
  invalidate: () => void
  asset: ManagedBrowserInputAsset
}) {
  if (process.platform !== "darwin" || !process.versions.electron || process.type !== "browser")
    return { status: "unavailable", reason: "unsupported_runtime" } as const
  if (input.window.isDestroyed()) return { status: "unavailable", reason: "window_closed" } as const
  try {
    verifyManagedBrowserInputAsset(input.asset)
    const binding: unknown = createRequire(import.meta.url)(input.asset.path)
    if (!binding || typeof binding !== "object" || !("version" in binding) || binding.version !== 1 ||
      !("observe" in binding) || typeof binding.observe !== "function" ||
      Object.getOwnPropertyNames(binding).toSorted().join(",") !== "observe,version")
      return { status: "unavailable", reason: "invalid_module" } as const
    const native = (binding as NativeObserver).observe(input.window.getNativeWindowHandle(), () => input.invalidate())
    if (!native.healthy()) { native.release(); return { status: "unavailable", reason: "observer_unhealthy" } as const }
    const contents = input.window.webContents
    const state = { released: false }
    const release = () => {
      if (state.released) return
      state.released = true
      input.window.removeListener("closed", release)
      contents.removeListener("render-process-gone", release)
      native.release()
    }
    input.window.once("closed", release)
    contents.once("render-process-gone", release)
    return Object.freeze({ status: "available" as const,
      healthy: () => !state.released && !input.window.isDestroyed() && native.healthy(), release })
  } catch (error) {
    if (error instanceof Error && error.message === "MANAGED_BROWSER_INPUT_CAPACITY")
      return { status: "unavailable", reason: "observer_capacity" } as const
    return { status: "unavailable", reason: "native_unavailable" } as const
  }
}

export function verifyManagedBrowserInputAsset(asset: ManagedBrowserInputAsset) {
  if (asset.schemaVersion !== "dac.managed-browser-input.darwin.v1" || asset.napiVersion !== 8 ||
    asset.target !== `darwin-${process.arch}` || !Number.isSafeInteger(asset.bytes) ||
    asset.bytes < 32 || asset.bytes > 1_048_576 || !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    !/^[a-f0-9]{64}$/.test(asset.sourceSha256) || !path.isAbsolute(asset.path) ||
    path.basename(asset.path) !== "managed-browser-input-darwin.node" || realpathSync(asset.path) !== asset.path)
    throw new Error("Managed browser input asset unavailable")
  const file = openSync(asset.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(file, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(asset.bytes) ||
      (before.mode & 0o022n) !== 0n) throw new Error("Managed browser input asset identity unavailable")
    const header = Buffer.alloc(32)
    if (readSync(file, header, 0, header.length, 0) !== header.length || header.readUInt32LE(0) !== 0xfeedfacf ||
      header.readUInt32LE(4) !== (process.arch === "arm64" ? 0x0100000c : 0x01000007) ||
      header.readUInt32LE(12) !== 8) throw new Error("Managed browser input asset target unavailable")
    const body = Buffer.alloc(asset.bytes)
    const observed = { bytes: 0 }
    while (observed.bytes < body.length) {
      const bytes = readSync(file, body, observed.bytes, body.length - observed.bytes, observed.bytes)
      if (!bytes) throw new Error("Managed browser input asset truncated")
      observed.bytes += bytes
    }
    if (readSync(file, Buffer.alloc(1), 0, 1, body.length) !== 0 ||
      createHash("sha256").update(body).digest("hex") !== asset.sha256)
      throw new Error("Managed browser input asset digest unavailable")
    const stamp = (value: typeof before) =>
      [value.dev, value.ino, value.mode, value.nlink, value.size, value.mtimeNs, value.ctimeNs].join(":")
    if (stamp(before) !== stamp(fstatSync(file, { bigint: true })) ||
      stamp(before) !== stamp(lstatSync(asset.path, { bigint: true })) || realpathSync(asset.path) !== asset.path)
      throw new Error("Managed browser input asset changed")
  } finally { closeSync(file) }
}
