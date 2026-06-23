import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")

async function signWindows(configuration: { path: string }) {
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
const macSigningAvailable = Boolean(
  process.env.CSC_LINK ||
    process.env.CSC_NAME ||
    (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID) ||
    process.env.APPLE_API_KEY,
)

const getBase = (): Configuration => ({
  artifactName: "deepagent-code-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "resources/**/*"],
  extraResources: [
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
  ],
  mac: {
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
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    target: ["AppImage", "deb", "rpm"],
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
        rpm: { packageName: "deepagent-code-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId: "ai.deepagent-code.desktop.beta",
        productName: "DeepAgent Code Beta",
        protocols: { name: "DeepAgent Code Beta", schemes: ["deepagent-code"] },
        publish: { provider: "github", owner: "anomalyco", repo: "deepagent-code-beta", channel: "latest" },
        rpm: { packageName: "deepagent-code-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId: "ai.deepagent-code.desktop",
        productName: "DeepAgent Code",
        protocols: { name: "DeepAgent Code", schemes: ["deepagent-code"] },
        publish: { provider: "github", owner: "anomalyco", repo: "deepagent-code", channel: "latest" },
        rpm: { packageName: "deepagent-code" },
      }
    }
  }
}

export default getConfig()
