import fs from "node:fs/promises"
import path from "node:path"
import { createHash, createPublicKey } from "node:crypto"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { NativeInstallationSchema } from "../src/installation/native-installation.schema"
import { signNativeNodeAssets } from "./sign-native-assets"

/** Build metadata contains only public input hashes. The publisher signs the final
 * module and interpreter later; this step never loads a private release key. */
export async function nativeNodeDefines(input: {
  repository: string
  destination: string
  helper: { path: string; bytes: number; sha256: string }
  assets?: readonly { path: string; bytes: number; sha256: string }[]
}): Promise<Record<string, string>> {
  const raw = process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY?.trim()
  if (!raw) {
    await fs.rm(path.join(input.destination, "node.js.native-components.json"), { force: true })
    return {}
  }
  const pin = raw.includes("-----BEGIN") ? raw : await fs.readFile(raw, "utf8")
  if (
    pin.includes("PRIVATE KEY") ||
    !pin.includes("-----BEGIN PUBLIC KEY-----") ||
    createPublicKey(pin).asymmetricKeyType !== "ed25519"
  )
    throw new Error("Native Node build requires an Ed25519 public release pin")
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: input.repository, stdout: "pipe", stderr: "ignore" })
    if (result.exitCode !== 0) throw new Error("Native Node source inventory is unavailable")
    return result.stdout.toString().trim()
  }
  const sourceCommit = git(["rev-parse", "HEAD"])
  if (process.env.DEEPAGENT_CODE_COMMIT && process.env.DEEPAGENT_CODE_COMMIT !== sourceCommit)
    throw new Error("Native Node build requires its actual source commit")
  if (process.env.DEEPAGENT_CODE_RELEASE && git(["status", "--porcelain", "--untracked-files=all"]))
    throw new Error("Release Node build requires a clean source commit")
  const files = git([
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "packages/core/src",
    "packages/llm/src",
    "packages/deepagent-code/src",
    "packages/effect-drizzle-sqlite/src",
    "packages/server/src",
    "packages/sdk/js/src",
    "packages/plugin/src",
    "packages/util/src",
    "packages/script/src",
    "packages/tui/src/util",
    "packages/im-kernel-sdk/upstream/src",
    "packages/core/package.json",
    "packages/llm/package.json",
    "packages/deepagent-code/package.json",
    "packages/server/package.json",
    "packages/sdk/js/package.json",
    "packages/plugin/package.json",
    "packages/util/package.json",
    "packages/script/package.json",
    "bun.lock",
    "patches",
    "packages/tui/package.json",
    "packages/im-kernel-sdk/package.json",
    "packages/deepagent-code/script/build-node.ts",
    "packages/deepagent-code/script/build-native-node.ts",
    "packages/deepagent-code/script/build-work-file-helper.ts",
    "packages/deepagent-code/script/build-work-storage-cleanup.ts",
    "packages/deepagent-code/script/build-windows-native-bootstrap.ts",
    "packages/deepagent-code/script/sign-native-node.ts",
    "packages/desktop/src/main",
    "packages/desktop/src/env.d.ts",
    "packages/desktop/electron.vite.config.ts",
    "packages/desktop/electron-builder.config.ts",
    "packages/deepagent-code/script/sign-native-assets.ts",
    "packages/deepagent-code/script/native-command-entitlements.plist",
    "packages/desktop/scripts/native-node-artifact.ts",
    "packages/desktop/scripts/mac-native-assets.ts",
    "packages/work-file-helper/src",
    "packages/work-file-helper/Cargo.toml",
    "packages/work-file-helper/Cargo.lock",
    "packages/work-file-helper/LICENSE",
    "packages/work-file-helper/NOTICE",
    "packages/work-file-helper/ed25519-dalek.LICENSE",
    "packages/work-file-helper/curve25519-dalek.LICENSE",
    "packages/work-file-helper/UPSTREAM.json",
  ])
  if (!files) throw new Error("Native Node source inventory is empty")
  // The workspace IM SDK's actual package entry is generated and may be Git-ignored.
  // Its bytes enter this bundle and must be recorded alongside the source inputs.
  const components = await Promise.all(
    [...new Set([...files.split("\n"), "packages/im-kernel-sdk/lib/index.js"])].toSorted().map(async (entry) => {
      const bytes = await fs.readFile(path.join(input.repository, entry))
      return new NativeInstallationSchema.Component({
        path: entry,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      })
    }),
  )
  const runtime =
    process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64")
      ? await fs.readFile(await fs.realpath(process.execPath))
      : undefined
  if (runtime) {
    if (runtime.length > 268_435_456) throw new Error("Installed command runtime exceeds its bound")
    await fs.writeFile(path.join(input.destination, "bun-command-runtime"), runtime, { mode: 0o755 })
  }
  const finalAssets = runtime ? await signNativeNodeAssets(input.destination) : [input.helper, ...(input.assets ?? [])]
  const manifest = new NativeInstallationSchema.Components({
    schemaVersion: "dac.native-components.v1",
    target: `${process.platform}-${process.arch}`,
    sourceCommit,
    sourceTree: git(["rev-parse", "HEAD^{tree}"]),
    components: [...components, ...finalAssets.map((asset) => new NativeInstallationSchema.Component(asset))].sort(
      (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    ),
  })
  const text = CanonicalJson.stringify(manifest)
  if (Buffer.byteLength(text) > NativeInstallationSchema.COMPONENTS_LIMIT)
    throw new Error("Native Node source inventory exceeds its bound")
  await fs.writeFile(path.join(input.destination, "node.js.native-components.json"), text)
  return {
    DEEPAGENT_CODE_NATIVE_RUNTIME_PUBLIC_KEY: JSON.stringify(pin),
    DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST: JSON.stringify(text),
    DEEPAGENT_CODE_NATIVE_NODE_ARTIFACT: "true",
  }
}
