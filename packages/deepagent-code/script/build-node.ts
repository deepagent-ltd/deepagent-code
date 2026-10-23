#!/usr/bin/env bun

import { Script } from "@deepagent-code/script"
import path from "path"
import fs from "node:fs/promises"
import { fileURLToPath } from "url"
import { buildWorkFileHelper } from "./build-work-file-helper"
import { nativeNodeDefines } from "./build-native-node"
import { buildWorkStorageCleanup } from "./build-work-storage-cleanup"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)
await fs.mkdir(path.join(dir, "dist"), { recursive: true })

// A rebuilt module must never inherit a publisher receipt for older bytes.
await fs.rm(path.join(dir, "dist/node/node.js.native-installation.json"), { force: true })
// Physical Linux assets can be tested without configuring a release publisher.
// Their data-only inventory does not enable installed Native authority.
await Promise.all(
  [
    "linux-native-dev-assets.json",
    "runtime-closure",
    "linux-native-licenses",
    "deepagent-work-file-helper",
    "deepagent-work-file-helper.exe",
    "deepagent-work-storage-cleanup",
    "deepagent-work-storage-cleanup.exe",
    "deepagent-work-process-supervisor",
    "bun-command-runtime",
    "deepagent-work-process-supervisor.exe",
    "bun-command-runtime.exe",
    "work-file-helper.LICENSE",
    "work-file-helper.NOTICE",
    "work-file-helper.UPSTREAM.json",
    "native-image-factory.node",
    "native-preloader.installation.json",
    "ed25519-dalek.LICENSE",
    "curve25519-dalek.LICENSE",
  ].map((name) => fs.rm(path.join(dir, "dist/node", name), { recursive: true, force: true })),
)
const linuxAssets =
  process.platform === "linux" && process.env.DEEPAGENT_CODE_BUILD_LINUX_NATIVE_ASSETS === "1"
    ? await (async () => {
        const { buildLinuxNativeAssets, inspectLinuxNativeAssets } = await import("./build-linux-native-assets")
        const staging = await fs.mkdtemp(path.join(dir, "dist/.linux-node-assets-"))
        try {
          const built = await buildLinuxNativeAssets({ destination: path.join(staging, "cohort") })
          await fs.mkdir(path.join(dir, "dist/node"), { recursive: true })
          await fs.cp(path.dirname(built.manifestPath), path.join(dir, "dist/node"), { recursive: true })
          await inspectLinuxNativeAssets({
            directory: path.join(dir, "dist/node"),
            target: built.target,
            expectedManifestHash: built.manifestHash,
          })
          return built
        } finally {
          await fs.rm(staging, { recursive: true, force: true })
        }
      })()
    : undefined
const windowsAssets =
  process.platform === "win32" && process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY?.trim()
    ? await (async () => {
        const { buildWindowsNativeBootstrap } = await import("./build-windows-native-bootstrap")
        const raw = process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY!.trim()
        const staging = await fs.mkdtemp(path.join(dir, "dist/.windows-node-assets-"))
        try {
          const built = await buildWindowsNativeBootstrap({
            repository: path.resolve(dir, "../.."),
            staging,
            publicKey: raw.includes("-----BEGIN") ? raw : await fs.readFile(raw, "utf8"),
          })
          await fs.mkdir(path.join(dir, "dist/node"), { recursive: true })
          await Promise.all(
            [
              "native-image-factory.node",
              "deepagent-work-process-supervisor.exe",
              "bun-command-runtime.exe",
              "ed25519-dalek.LICENSE",
              "curve25519-dalek.LICENSE",
            ].map((name) => fs.copyFile(path.join(staging, name), path.join(dir, "dist/node", name))),
          )
          return [built, ...built.assets, ...built.licenses.filter((entry) => !entry.path.endsWith("/NOTICE"))]
        } finally {
          await fs.rm(staging, { recursive: true, force: true })
        }
      })()
    : []
const nativeDefines = process.env.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY?.trim()
  ? await nativeNodeDefines({
      repository: path.resolve(dir, "../.."),
      destination: path.join(dir, "dist/node"),
      helper:
        linuxAssets?.assets.find((asset) => asset.path.endsWith("/deepagent-work-file-helper")) ??
        (await buildWorkFileHelper({
          os: process.platform,
          arch: process.arch,
          destination: path.join(dir, "dist/node"),
        })),
      assets: linuxAssets
        ? linuxAssets.assets.filter((asset) => !asset.path.endsWith("/deepagent-work-file-helper"))
        : [
            ...windowsAssets,
            await buildWorkStorageCleanup({
              os: process.platform,
              arch: process.arch,
              destination: path.join(dir, "dist/node"),
            }),
          ],
    })
  : {}
if (!nativeDefines.DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST)
  await fs.rm(path.join(dir, "dist/node/node.js.native-components.json"), { force: true })

// Desktop uses the same per-release owner issuance pin as the compiled CLI.
const ownerKeyInput = process.env.DEEPAGENT_CODE_RELEASE_OWNER_PUBLIC_KEY?.trim()
if (
  (process.env.DEEPAGENT_CODE_RELEASE_NATIVE_REQUIRED === "1" && !ownerKeyInput) ||
  Boolean(ownerKeyInput) !== Boolean(process.env.DEEPAGENT_CODE_RELEASE_OWNER_AUTHORIZATION_FILE?.trim())
)
  throw new Error("Release owner public key and authorization file must be supplied together")
const ownerPublicKey = ownerKeyInput
  ? ownerKeyInput.includes("-----BEGIN")
    ? ownerKeyInput
    : await fs.readFile(ownerKeyInput, "utf8")
  : undefined
if (ownerKeyInput && !ownerPublicKey?.includes("-----BEGIN PUBLIC KEY-----"))
  throw new Error("DEEPAGENT_CODE_RELEASE_OWNER_PUBLIC_KEY is neither an inline PEM nor a path to one")

const result = await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts", "./src/im/auth-password-worker.node.ts"],
  outdir: "./dist/node",
  naming: "[name].[ext]",
  format: "esm",
  sourcemap: "linked",
  external: ["@lydell/node-pty", "jsonc-parser", "bun"],
  define: {
    // Windows compiled Bun entries inspect their virtual main before Native
    // verifies the EXE receipt. Node sidecars use their separate fixed entry
    // and must not retain a dependency on Bun's interpreter-only API.
    "Bun.main": '""',
    // W0.5 (major-6): same semantics as script/build.ts — the node sidecar must ship the REAL
    // installation version (Script.version; CI passes the release version via DEEPAGENT_CODE_VERSION)
    // instead of falling back to InstallationVersion "local". The V2 owner chain derives its build
    // identity from InstallationVersion, so a sidecar built without this define can never match the
    // minted v2-owner-<version> authorization row.
    DEEPAGENT_CODE_VERSION: `'${Script.version}'`,
    DEEPAGENT_CODE_CHANNEL: `'${Script.channel}'`,
    ...(ownerPublicKey ? { DEEPAGENT_CODE_RELEASE_OWNER_PUBLIC_KEY: JSON.stringify(ownerPublicKey) } : {}),
    ...nativeDefines,
  },
  files: {
    "deepagent-code-web-ui.gen.ts": "",
  },
})
if (!result.success) throw new AggregateError(result.logs, "Failed to build the Node server")

if (nativeDefines.DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST) {
  const { Schema } = await import("effect")
  const { createHash } = await import("node:crypto")
  const { NativeInstallationSchema } = await import("../src/installation/native-installation.schema")
  const components = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.fromJsonString(NativeInstallationSchema.Components)),
  )(nativeDefines.DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST)
  // A concurrent writer may not make the attested inventory disagree with this build.
  // Asset records use their installed paths and are verified by the runtime separately.
  const changed = (
    await Promise.all(
      components.components
        .filter((entry) => !entry.path.startsWith("packages/work-file-helper/bin/"))
        .map(async (entry) => {
          const bytes = await fs.readFile(path.resolve(dir, "../..", entry.path))
          return bytes.length === entry.bytes && createHash("sha256").update(bytes).digest("hex") === entry.sha256
            ? undefined
            : entry.path
        }),
    )
  ).filter((entry) => entry !== undefined)
  const changedWindowsAssets = (
    await Promise.all(
      windowsAssets.map(async (entry) => {
        const bytes = await fs.readFile(path.join(dir, "dist/node", path.basename(entry.path)))
        return bytes.length === entry.bytes && createHash("sha256").update(bytes).digest("hex") === entry.sha256
          ? undefined
          : entry.path
      }),
    )
  ).filter((entry) => entry !== undefined)
  if (changedWindowsAssets.length)
    throw new Error(`Windows Native build assets changed: ${changedWindowsAssets.join(", ")}`)
  if (changed.length) throw new Error(`Native Node build inputs changed: ${changed.join(", ")}`)
}

// Bun preserves CommonJS __dirname/__filename values for bundled dependencies. Those values point
// at the build machine and are unusable after installation, so make the bundle reproducible and
// keep local usernames/workspace paths out of release artifacts.
const buildRoot = path.resolve(dir, "../..")
for (const output of result.outputs.filter((item) => item.path.endsWith(".js"))) {
  const bundle = Bun.file(output.path)
  const source = await bundle.text()
  // The plugin context exposes Bun.$ only behind a `typeof Bun` guard. Every other direct Bun API
  // in this Node-targeted bundle is an unreviewed runtime dependency and must fail the desktop build.
  const unsupportedBunAPIs = [...new Set(source.match(/\bBun\.[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [])].filter(
    (api) => api !== "Bun.$",
  )
  if (unsupportedBunAPIs.length > 0) {
    throw new Error(`Node server bundle contains Bun-only runtime APIs: ${unsupportedBunAPIs.join(", ")}`)
  }
  // A literal bun: specifier is rejected by Node's ESM loader ("Only URLs with a scheme in:
  // file, data, node, and electron are supported") and crashes the desktop sidecar utility
  // process. Platform-specific code must go through a conditional import (packages/core
  // imports map) so the node target resolves to a node implementation.
  const bunSpecifiers = [...new Set(source.match(/from\s*"bun:[a-z-]+"/g) ?? [])]
  if (bunSpecifiers.length > 0) {
    throw new Error(`Node server bundle contains bun: specifiers: ${bunSpecifiers.join(", ")}`)
  }
  if (path.basename(output.path) === "node.js" && !source.includes('from "@lydell/node-pty"')) {
    throw new Error("Node server bundle does not import the node-pty platform selector")
  }
  if (path.basename(output.path) === "node.js" && !source.includes('from "jsonc-parser"')) {
    throw new Error("Node server bundle does not import the external jsonc-parser runtime dependency")
  }
  await Bun.write(
    bundle,
    source
      .replaceAll(buildRoot, "/__deepagent_build__")
      .replaceAll(buildRoot.replaceAll("\\", "/"), "/__deepagent_build__")
      .replaceAll(buildRoot.replaceAll("\\", "\\\\"), "/__deepagent_build__"),
  )
}

// Include third-party copyright and fixed source provenance with the distributable bundle.
await Bun.write("./dist/node/NOTICE", Bun.file(path.join(buildRoot, "NOTICE")))

console.log("Build complete")
