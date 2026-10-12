import { expect, test } from "bun:test"
import path from "node:path"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { NativeInstallationSchema } from "../../src/installation/native-installation.schema"
import { captureNativeRuntimeInventory, requireNativeRuntimeCoverage } from "../../script/native-runtime-inventory"

test("actual compiler sources have a complete immutable inventory in the runtime canonical order", async () => {
  const repository = path.resolve(import.meta.dirname, "../../../..")
  const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repository, stdout: "pipe" })
    .stdout.toString()
    .trim()
  const inventory = await captureNativeRuntimeInventory({
    repository,
    target: `${process.platform}-${process.arch}`,
    sourceCommit: commit,
    assets: [],
  })
  const paths = inventory.components.components.map((entry) => entry.path)
  expect(paths).toEqual(paths.toSorted())
  expect(new Set(paths).size).toBe(paths.length)
  expect(Buffer.byteLength(CanonicalJson.stringify(inventory.components))).toBeLessThanOrEqual(
    NativeInstallationSchema.COMPONENTS_LIMIT,
  )
  expect(paths).toContain("packages/im-kernel-sdk/lib/index.js")
  expect(paths).toContain("packages/deepagent-code/script/build-output.ts")
  expect(paths).toContain("packages/deepagent-code/script/sign-native-assets.ts")
  expect(paths).toContain("packages/deepagent-code/script/native-command-entitlements.plist")
  const build = await Bun.build({
    entrypoints: [path.join(import.meta.dirname, "fixture/native-node-installation-process.ts")],
    target: "node",
    format: "esm",
    plugins: [inventory.plugin],
  })
  expect(build.success).toBe(true)
  expect(inventory.loaded.size).toBeGreaterThan(0)
  console.log("Native runtime source coverage oracle", {
    captured: inventory.source.length,
    loaded: inventory.loaded.size,
    metadataBytes: Buffer.byteLength(CanonicalJson.stringify(inventory.components)),
  })
  await requireNativeRuntimeCoverage({ repository, source: inventory.source, loaded: inventory.loaded })
  const observed = [...inventory.loaded][0]!
  await expect(
    requireNativeRuntimeCoverage({
      repository,
      source: inventory.source.filter((entry) => entry.path !== observed),
      loaded: inventory.loaded,
    }),
  ).rejects.toThrow("missing from inventory")
}, 30_000)
