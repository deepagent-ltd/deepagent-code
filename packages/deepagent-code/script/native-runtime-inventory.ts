import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import type { BunPlugin } from "bun"
import { NativeInstallationSchema } from "../src/installation/native-installation.schema"

export async function captureNativeRuntimeInventory(input: {
  repository: string
  target: string
  sourceCommit: string
  assets: readonly { path: string; bytes: number; sha256: string }[]
}) {
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: input.repository, stdout: "pipe", stderr: "ignore" })
    if (result.exitCode !== 0) throw new Error("Native runtime source inventory is unavailable")
    return result.stdout.toString().trim()
  }
  const commit = git(["rev-parse", "HEAD"])
  if (commit !== input.sourceCommit) throw new Error("Native runtime source commit changed")
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
    "packages/tui/src",
    "packages/ui/src/assets/audio",
    "packages/im-kernel-sdk/upstream/src",
    "packages/im-kernel-sdk/lib/index.js",
    "packages/core/package.json",
    "packages/llm/package.json",
    "packages/deepagent-code/package.json",
    "packages/effect-drizzle-sqlite/package.json",
    "packages/server/package.json",
    "packages/sdk/js/package.json",
    "packages/plugin/package.json",
    "packages/util/package.json",
    "packages/script/package.json",
    "packages/tui/package.json",
    "packages/im-kernel-sdk/package.json",
    "bun.lock",
    "patches",
    "packages/deepagent-code/script/build.ts",
    "packages/deepagent-code/script/build-output.ts",
    "packages/deepagent-code/script/native-runtime-inventory.ts",
    "packages/deepagent-code/script/build-work-file-helper.ts",
    "packages/deepagent-code/script/build-work-storage-cleanup.ts",
    "packages/deepagent-code/script/build-windows-native-bootstrap.ts",
    "packages/deepagent-code/script/sign-native-node.ts",
    "packages/deepagent-code/script/sign-windows-native-cli.ts",
    "packages/desktop/src/main",
    "packages/desktop/src/env.d.ts",
    "packages/desktop/electron.vite.config.ts",
    "packages/desktop/electron-builder.config.ts",
    "packages/deepagent-code/script/build-work-process-supervisor.ts",
    "packages/deepagent-code/script/sign-native-assets.ts",
    "packages/desktop/scripts/native-node-artifact.ts",
    "packages/deepagent-code/script/native-command-entitlements.plist",
    "packages/work-file-helper/src",
    "packages/work-file-helper/Cargo.toml",
    "packages/work-file-helper/Cargo.lock",
    "packages/work-file-helper/LICENSE",
    "packages/work-file-helper/NOTICE",
    "packages/work-file-helper/ed25519-dalek.LICENSE",
    "packages/work-file-helper/curve25519-dalek.LICENSE",
    "packages/work-file-helper/UPSTREAM.json",
  ])
  const source = await Promise.all(
    [...new Set([...files.split("\n"), "packages/im-kernel-sdk/lib/index.js",
      // Existing build-* ignore patterns must not omit a directly imported issuer producer.
      "packages/deepagent-code/script/build-work-process-supervisor.ts",
      "packages/deepagent-code/script/build-windows-native-bootstrap.ts",
      "packages/deepagent-code/script/build-linux-native-assets.ts"])]
      .filter(Boolean)
      .toSorted()
      .map(async (filename) => {
        const bytes = await fs.readFile(path.join(input.repository, filename))
        // The existing component contract cannot represent empty placeholder files.
        // If the compiler actually loads one, coverage below refuses the artifact.
        if (!bytes.length) return
        return new NativeInstallationSchema.Component({
          path: filename,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        })
      }),
  )
  const captured = source.filter((entry) => entry !== undefined)
  const components = new NativeInstallationSchema.Components({
    schemaVersion: "dac.native-components.v1",
    target: input.target,
    sourceCommit: commit,
    sourceTree: git(["rev-parse", "HEAD^{tree}"]),
    components: [...captured, ...input.assets.map((asset) => new NativeInstallationSchema.Component(asset))].sort(
      (left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
    ),
  })
  const loaded = new Set<string>()
  const plugin: BunPlugin = {
    name: "native-runtime-source-observation",
    setup(build) {
      build.onLoad({ filter: /.*/ }, (args) => {
        const filename = path.relative(input.repository, args.path).replaceAll(path.sep, "/")
        if (
          !filename.split("/").includes("node_modules") &&
          /^packages\/[^/]+\/(?:src\/|upstream\/src\/|lib\/|package\.json$)/.test(filename)
        )
          loaded.add(filename)
        return undefined
      })
    },
  }
  return { components, source: captured, loaded, plugin }
}

/** Actual compiler observations are checked against the captured bytes, not a claim
 * that a source directory or a Git-tracked list is automatically complete. */
export async function requireNativeRuntimeCoverage(input: {
  repository: string
  source: readonly { path: string; bytes: number; sha256: string }[]
  loaded: ReadonlySet<string>
}) {
  const captured = new Map(input.source.map((entry) => [entry.path, entry]))
  const missing = [...input.loaded].filter((filename) => !captured.has(filename))
  if (missing.length)
    throw new Error(
      `Native runtime compiler sources missing from inventory (${missing.length}): ${missing.slice(0, 32).join(", ")}`,
    )
  const changed = (
    await Promise.all(
      input.source.map(async (entry) => {
        const bytes = await fs.readFile(path.join(input.repository, entry.path))
        return bytes.length === entry.bytes && createHash("sha256").update(bytes).digest("hex") === entry.sha256
          ? undefined
          : entry.path
      }),
    )
  ).filter((filename) => filename !== undefined)
  if (changed.length)
    throw new Error(`Native runtime source inputs changed (${changed.length}): ${changed.slice(0, 32).join(", ")}`)
}
