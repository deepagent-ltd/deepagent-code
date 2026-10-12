import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { lstat } from "node:fs/promises"

import { Arch } from "electron-builder"
import type { Configuration } from "electron-builder"
import { auditPackageInputs } from "./scripts/audit-package"
import { prepareWindowsNativeNodePackage, sealInstalledNativeNode, signMacWithNativeNode } from "./scripts/native-node-artifact"
import { verifyManagedBrowserInputPackAsset } from "./scripts/managed-browser-input-assets"
import { verifyLinuxNativeAssets } from "./scripts/linux-native-assets"
import { prepareLinuxWorkProvisioning } from "./scripts/linux-work-provisioning"

const execFileAsync = promisify(execFile)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
const linuxNativeCohorts = new Map<string, string>()

async function signWindows(configuration: { path: string }) {
  if (process.env.DEEPAGENT_CODE_ALLOW_UNSIGNED === "1" || process.env.DEEPAGENT_CODE_ALLOW_UNSIGNED === "true") return
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.DEEPAGENT_CODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

// Mac signing is opt-in by environment. A Developer ID Application certificate (for
// distributing a .dmg outside the App Store) plus notarization credentials are only
// present on release machines/CI. When they are absent — e.g. a local beta build — we
// produce an UNSIGNED package instead of failing the build. The signed path is the same
// config; it just flips on when the credentials appear, so adding a cert later needs no
// code change.
//
// electron-builder 26 rejects a CSC_NAME that still carries the "Developer ID Application: "
// prefix; it wants the subject name only. scripts/package.ts strips it, but CI invokes
// electron-builder directly (bypassing package.ts), so strip here too to be safe.
if (process.env.CSC_NAME) {
  process.env.CSC_NAME = process.env.CSC_NAME.replace(/^Developer ID Application:\s*/i, "")
}

const macSigningAvailable =
  process.env.DEEPAGENT_CODE_ALLOW_UNSIGNED !== "1" &&
  process.env.DEEPAGENT_CODE_ALLOW_UNSIGNED !== "true" &&
  Boolean(
    process.env.CSC_LINK ||
      process.env.CSC_NAME ||
      (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID) ||
      process.env.APPLE_API_KEY,
  )

function managedBrowserInputTarget(arch: Arch) {
  if (arch === Arch.arm64) return "darwin-arm64" as const
  if (arch === Arch.x64) return "darwin-x64" as const
  throw new Error("Managed browser input assets require a native Darwin arm64 or x64 package")
}

function linuxNativeTarget(arch: Arch) {
  if (arch === Arch.arm64) return "linux-arm64" as const
  if (arch === Arch.x64) return "linux-x64" as const
  throw new Error("Linux Native assets require a native arm64 or x64 package")
}

const getBase = (): Configuration => ({
  artifactName: "deepagent-code-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: [
    "out/**/*",
    "!out/**/*.map",
    "resources/icons/**/*",
    "resources/entitlements.plist",
    "resources/*.metainfo.xml",
  ],
  asarUnpack: [
    "out/main/chunks/node.js",
    "out/main/sidecar.js",
    "out/main/chunks/native-image-factory.node",
    "out/main/chunks/native-preloader.installation.json",
    "out/main/chunks/ed25519-dalek.LICENSE",
    "out/main/chunks/curve25519-dalek.LICENSE",
    "out/main/chunks/auth-password-worker.node.js",
    "out/main/chunks/node.js.native-installation.json",
    "out/main/chunks/node.js.native-components.json",
    "out/main/chunks/deepagent-work-file-helper{,.exe}",
    "out/main/chunks/bun-command-runtime",
    "out/main/chunks/bun-command-runtime.exe",
    "out/main/chunks/deepagent-work-storage-cleanup{,.exe}",
    "out/main/chunks/deepagent-work-process-supervisor",
    "out/main/chunks/deepagent-work-process-supervisor.exe",
    "out/main/chunks/linux-native-dev-assets.json",
    "out/main/chunks/runtime-closure/**",
    "out/main/chunks/linux-native-licenses/**",
    "out/main/chunks/work-file-helper.*",
    "out/main/managed-browser-input/**",
    // ESM resolution starts from the physical entry, outside app.asar. Its
    // external selector and parser must have complete adjacent package trees.
    "node_modules/jsonc-parser/**",
    "node_modules/@lydell/node-pty/**",
    "node_modules/@lydell/node-pty-*/**",
  ],
  beforePack: async (context) => {
    const directory = path.dirname(fileURLToPath(import.meta.url))
    await auditPackageInputs(directory)
    const linuxManifest = await lstat(path.join(directory, "out/main/chunks/linux-native-dev-assets.json")).then(
      () => true,
      (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error },
    )
    if (linuxManifest || process.env.DEEPAGENT_CODE_BUILD_LINUX_NATIVE_ASSETS === "1") {
      if (context.electronPlatformName !== "linux") throw new Error("Linux assets cannot enter another platform package")
      const captured = await verifyLinuxNativeAssets({ directory: path.join(directory, "out/main/chunks"), target: linuxNativeTarget(context.arch) })
      if (!linuxNativeCohorts.has(context.appOutDir) && linuxNativeCohorts.size >= 8)
        throw new Error("Too many concurrent Linux package stages")
      linuxNativeCohorts.set(context.appOutDir, captured.manifestHash)
    }
    if (context.electronPlatformName === "darwin") await verifyManagedBrowserInputPackAsset({
      directory: path.join(directory, "out/main/managed-browser-input"),
      target: managedBrowserInputTarget(context.arch),
    })
  },
  afterPack: async (context) => {
    const linuxManifestHash = linuxNativeCohorts.get(context.appOutDir)
    if (linuxManifestHash) {
      try {
        const source = await verifyLinuxNativeAssets({
          directory: path.join(path.dirname(fileURLToPath(import.meta.url)), "out/main/chunks"),
          target: linuxNativeTarget(context.arch), expectedManifestHash: linuxManifestHash,
        })
        await verifyLinuxNativeAssets({
          directory: path.join(context.appOutDir, "resources/app.asar.unpacked/out/main/chunks"),
          target: source.manifest.target, expectedManifestHash: linuxManifestHash,
        })
        if (!("executableName" in context.packager) || typeof context.packager.executableName !== "string")
          throw new Error("Linux package executable layout is unavailable")
        await prepareLinuxWorkProvisioning({
          appOutDir: context.appOutDir, productName: context.packager.appInfo.sanitizedProductName,
          executable: context.packager.executableName, manifest: source.manifest,
          resources: path.join(path.dirname(fileURLToPath(import.meta.url)), "resources/linux-work-provisioning"),
        })
      } finally {
        linuxNativeCohorts.delete(context.appOutDir)
      }
    }
    if (context.electronPlatformName === "darwin") await verifyManagedBrowserInputPackAsset({
      directory: path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`,
        "Contents/Resources/app.asar.unpacked/out/main/managed-browser-input"),
      target: managedBrowserInputTarget(context.arch),
    })
    if (context.electronPlatformName === "win32") {
      await prepareWindowsNativeNodePackage(context)
      return
    }
    if (!macSigningAvailable) await sealInstalledNativeNode(context)
  },
  afterSign: async (context) => {
    // WinPackager edits resources before emitting this event, including unsigned QA.
    if (context.electronPlatformName === "win32") await sealInstalledNativeNode(context)
  },
  extraResources: [
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
  ],
  mac: {
    ...(macSigningAvailable ? { sign: signMacWithNativeNode } : {}),
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: macSigningAvailable,
    identity: macSigningAvailable ? undefined : null,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: macSigningAvailable,
  },
  protocols: {
    name: "DeepAgent Code",
    schemes: ["deepagent-code"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    // electron-updater's default Windows signature verification compares the
    // update publisher against a Windows cert-store identity, which never
    // matches Azure Trusted Signing certificates — the installer signature is
    // still enforced by the SHA512 in latest.yml.
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    // Guided (assisted) installer per D-W3/§2.2.6: welcome → install dir →
    // install → finish (with launch checkbox). Per-user install, no elevation;
    // installer.nsh adds the app dir to the USER Path only (VSCode behavior).
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    include: "resources/installer.nsh",
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    target: ["deb"],
  },
  deb: {
    afterInstall: "resources/linux-work-provisioning/after-install.tpl",
    afterRemove: "resources/linux-work-provisioning/after-remove.tpl",
  },
})

function getConfig() {
  const base = getBase()

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId: "ai.deepagent-code.desktop.dev",
        productName: "DeepAgent Code Dev",
        linux: { ...base.linux, executableName: "deepagent-code-dev" },
        rpm: { packageName: "deepagent-code-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId: "ai.deepagent-code.desktop.beta",
        productName: "DeepAgent Code Beta",
        linux: { ...base.linux, executableName: "deepagent-code-beta" },
        protocols: { name: "DeepAgent Code Beta", schemes: ["deepagent-code"] },
        publish: { provider: "github", owner: "deepagent-ltd", repo: "deepagent-code", channel: "latest" },
        rpm: { packageName: "deepagent-code-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId: "ai.deepagent-code.desktop",
        productName: "DeepAgent Code",
        linux: { ...base.linux, executableName: "deepagent-code" },
        protocols: { name: "DeepAgent Code", schemes: ["deepagent-code"] },
        publish: { provider: "github", owner: "deepagent-ltd", repo: "deepagent-code", channel: "latest" },
        rpm: { packageName: "deepagent-code" },
      }
    }
  }
}

export default getConfig()
