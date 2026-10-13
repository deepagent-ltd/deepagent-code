import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { InstallationVersion } from "@deepagent-code/core/installation/version"
import { NativeInstallation } from "@/installation/native-installation"
import { NativeInstallationSchema } from "@/installation/native-installation.schema"
import { cmd } from "../cmd"

const runtime = { kind: process.versions.bun ? "bun" : "node", version: process.versions.bun ?? process.versions.node }

/** Public installation facts do not authorize a project, route, task or tool. */
export const inspectNativeInstallation = Effect.fn("Cli.debug.nativeInstallation")(
  function* () {
    const handle = yield* NativeInstallation.current()
    const description = yield* NativeInstallation.describe(handle)
    const inventory = yield* NativeInstallation.inventory(handle)
    const directory = yield* NativeInstallation.assetDirectory(handle)
    const assets = inventory.filter((entry) => entry.path.startsWith("packages/work-file-helper/bin/"))
    yield* Effect.tryPromise({
      try: async () => {
        const names = [
          "deepagent-work-file-helper",
          "deepagent-work-storage-cleanup",
          "bun-command-runtime",
          "deepagent-work-file-helper.exe",
          "deepagent-work-storage-cleanup.exe",
        ]
        if (assets.length < 2 || assets.length > 3 || new Set(assets.map((entry) => entry.path)).size !== assets.length)
          throw new Error("Invalid installation assets")
        for (const asset of assets) {
          const name = path.basename(asset.path)
          if (!names.includes(name) || asset.path !== `packages/work-file-helper/bin/${description.target}/${name}`)
            throw new Error("Invalid installation asset path")
          const filename = path.join(directory, name)
          if ((await fs.realpath(filename)) !== filename) throw new Error("Installation asset is not physical")
          const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
          try {
            const before = await file.stat({ bigint: true })
            if (
              !before.isFile() ||
              before.nlink !== 1n ||
              before.size !== BigInt(asset.bytes) ||
              before.size > BigInt(NativeInstallationSchema.EXECUTABLE_LIMIT) ||
              (before.mode & 0o022n) !== 0n
            )
              throw new Error("Invalid installation asset identity")
            const hash = createHash("sha256")
            const buffer = Buffer.alloc(65_536)
            const count = { bytes: 0 }
            while (true) {
              const read = await file.read(buffer, 0, buffer.length, null)
              if (!read.bytesRead) break
              count.bytes += read.bytesRead
              if (count.bytes > asset.bytes) throw new Error("Installation asset changed")
              hash.update(buffer.subarray(0, read.bytesRead))
            }
            const stamp = (value: typeof before) =>
              [value.dev, value.ino, value.size, value.mode, value.nlink, value.mtimeNs, value.ctimeNs].join(":")
            if (
              count.bytes !== asset.bytes ||
              hash.digest("hex") !== asset.sha256 ||
              stamp(before) !== stamp(await file.stat({ bigint: true })) ||
              stamp(before) !== stamp(await fs.lstat(filename, { bigint: true })) ||
              (await fs.realpath(filename)) !== filename
            )
              throw new Error("Installation asset changed")
          } finally {
            await file.close()
          }
        }
      },
      catch: () =>
        new NativeInstallationSchema.Error({
          code: "NATIVE_COMPONENTS_MISMATCH",
          message: "Native installation assets are unavailable",
        }),
    })
    yield* NativeInstallation.requireCurrent(handle)
    return {
      state: "available" as const,
      target: description.target,
      runtime,
      version: InstallationVersion,
      sourceDigest: description.componentsHash,
      verifiedAssetCount: assets.length,
    }
  },
  Effect.match({
    onFailure: (error) => ({
      state: "unavailable" as const,
      code: error.code,
      target: `${process.platform}-${process.arch}`,
      runtime,
      version: InstallationVersion,
      verifiedAssetCount: 0,
    }),
    onSuccess: (result) => result,
  }),
)

export const NativeInstallationCommand = cmd({
  command: "native-installation",
  describe: "verify the installed Native runtime and fixed assets without authorizing execution",
  async handler() {
    const result = JSON.stringify(await Effect.runPromise(inspectNativeInstallation()))
    if (Buffer.byteLength(result) > 8192) throw new Error("Native installation summary exceeds its bound")
    process.stdout.write(`${result}\n`)
  },
})
