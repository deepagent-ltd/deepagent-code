import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execute = promisify(execFile)
export const nativeAssetNames = [
  "deepagent-work-file-helper",
  "deepagent-work-storage-cleanup",
  "bun-command-runtime",
] as const

/** Publisher build operation. The exact certificate is explicit; there is no keychain
 * discovery, credential import or signing authority available in the installed runtime. */
export async function signNativeNodeAssets(directory: string) {
  if (process.platform !== "darwin" || (process.arch !== "arm64" && process.arch !== "x64"))
    throw new Error("Native asset signing requires a native macOS ARM or Intel build")
  const identity = process.env.DEEPAGENT_CODE_NATIVE_ASSET_SIGN_IDENTITY?.trim()
  if (identity && identity !== "-" && !/^[0-9a-f]{40}$/i.test(identity))
    throw new Error("Native asset signing requires an exact certificate fingerprint")
  const keychain = process.env.DEEPAGENT_CODE_NATIVE_ASSET_SIGN_KEYCHAIN?.trim()
  return await Promise.all(
    nativeAssetNames.map(async (name) => {
      const filename = path.join(directory, name)
      const canonical = await fs.realpath(filename)
      const stat = await fs.lstat(filename)
      if (canonical !== filename || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0)
        throw new Error("Native asset signing requires private physical build files")
      const opened = await fs.open(filename, "r")
      try {
        const header = Buffer.alloc(32)
        if ((await opened.read(header, 0, header.length, 0)).bytesRead !== header.length ||
          header.readUInt32LE(0) !== 0xfeedfacf ||
          header.readUInt32LE(4) !== (process.arch === "x64" ? 0x01000007 : 0x0100000c) ||
          header.readUInt32LE(12) !== 2)
          throw new Error("Native asset signing requires a matching native Mach-O executable")
      } finally {
        await opened.close()
      }
      if (identity) {
        await execute("/usr/bin/codesign", [
          "--force",
          "--sign",
          identity,
          "--options",
          "runtime",
          ...(keychain ? ["--keychain", keychain] : []),
          ...(name === "bun-command-runtime"
            ? ["--entitlements", path.join(import.meta.dirname, "native-command-entitlements.plist")]
            : []),
          identity === "-" ? "--timestamp=none" : "--timestamp",
          filename,
        ])
        await execute("/usr/bin/codesign", ["--verify", "--strict", filename])
      }
      const bytes = await fs.readFile(filename)
      if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf ||
        bytes.readUInt32LE(4) !== (process.arch === "x64" ? 0x01000007 : 0x0100000c) || bytes.readUInt32LE(12) !== 2)
        throw new Error("Native asset architecture changed during signing")
      return {
        path: `packages/work-file-helper/bin/darwin-${process.arch}/${name}`,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }
    }),
  )
}
