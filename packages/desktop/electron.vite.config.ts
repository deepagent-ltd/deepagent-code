import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig, type UserConfig } from "electron-vite"
import appPlugin from "@deepagent-code/app/vite"
import { copyFile, cp, lstat, mkdir, readdir, rm } from "node:fs/promises"
import path from "node:path"
import { prepareManagedBrowserInputAsset } from "./scripts/managed-browser-input-assets"
import { prepareSharedBrowserComputationAsset, copySharedBrowserComputationAsset } from "./scripts/shared-browser-compute-assets"

const DEEPAGENT_CODE_SERVER_DIST = "../deepagent-code/dist/node"
const DOMAIN_PACKS_DIST = "../domain-packs"

const channel = (() => {
  const raw = process.env.DEEPAGENT_CODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.DEEPAGENT_CODE_CHANNEL === "latest") return "prod"
  return "dev"
})()

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./out/renderer/**",
          filesToDeleteAfterUpload: "./out/renderer/**/*.map",
        },
      })
    : false

export default defineConfig(async () => {
  const computationDirectory = path.resolve("node_modules/.cache/dac-shared-browser-compute")
  const computation = await prepareSharedBrowserComputationAsset(computationDirectory)
  const inputDirectory = path.resolve("node_modules/.cache/dac-managed-browser-input", `${process.platform}-${process.arch}`)
  await mkdir(inputDirectory, { recursive: true })
  const browserInput = await prepareManagedBrowserInputAsset({ directory: inputDirectory })
  const linuxManifest = await lstat(path.join(DEEPAGENT_CODE_SERVER_DIST, "linux-native-dev-assets.json")).then(
    () => true,
    (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error },
  )
  const linuxAssets = linuxManifest || process.env.DEEPAGENT_CODE_BUILD_LINUX_NATIVE_ASSETS === "1"
    ? await (async () => {
        const { verifyLinuxNativeAssets } = await import("./scripts/linux-native-assets")
        if (process.platform !== "linux" || process.arch !== "x64" && process.arch !== "arm64")
          throw new Error("Unsupported Linux Native asset target")
        return verifyLinuxNativeAssets({ directory: DEEPAGENT_CODE_SERVER_DIST, target: `linux-${process.arch}` })
      })()
    : undefined
  return {
  main: {
    define: {
      "import.meta.env.DEEPAGENT_CODE_CHANNEL": JSON.stringify(channel),
      __DAC_SHARED_BROWSER_COMPUTE_ASSET__: JSON.stringify(computation),
      __DAC_MANAGED_BROWSER_INPUT_ASSET__: browserInput ? JSON.stringify(browserInput) : "undefined",
    },
    build: {
      rollupOptions: {
        input: { index: "src/main/bootstrap.ts", sidecar: "src/main/sidecar.ts" },
        // Main modules locate preload and utility assets relative to import.meta.url.
        // Preserve out/main as their root when the bootstrap splits Main into a chunk.
        output: { chunkFileNames: "[name]-[hash].js" },
      },
      externalizeDeps: { exclude: ["@deepagent-code/core"], include: ["@lydell/node-pty"] },
    },
    plugins: [
      {
        name: "deepagent-code:virtual-server-module",
        enforce: "pre",
        resolveId(id) {
          if (id !== "virtual:deepagent-code-server") return
          return { id: "./chunks/node.js", external: true }
        },
      },
      {
        name: "deepagent-code:copy-server-assets",
        async writeBundle() {
          await copySharedBrowserComputationAsset(computationDirectory, "./out/main/shared-browser-compute", computation)
          await rm("./out/main/managed-browser-input", { recursive: true, force: true })
          if (browserInput) {
            await mkdir("./out/main/managed-browser-input", { recursive: true })
            await Promise.all([browserInput.filename, "managed-browser-input.asset.json", "LICENSE", "UPSTREAM.json"]
              .map((filename) => copyFile(path.join(inputDirectory, filename), `./out/main/managed-browser-input/${filename}`)))
          }
          await mkdir("./out/main/chunks", { recursive: true })
          await Promise.all([
            "linux-native-dev-assets.json", "runtime-closure", "linux-native-licenses",
            "node.js.native-components.json", "node.js.native-installation.json",
            "native-image-factory.node", "native-preloader.installation.json", "ed25519-dalek.LICENSE", "curve25519-dalek.LICENSE",
            "deepagent-work-file-helper", "deepagent-work-file-helper.exe", "deepagent-work-storage-cleanup",
            "deepagent-work-storage-cleanup.exe", "deepagent-work-process-supervisor", "bun-command-runtime",
            "deepagent-work-process-supervisor.exe", "bun-command-runtime.exe",
            "work-file-helper.LICENSE", "work-file-helper.NOTICE", "work-file-helper.UPSTREAM.json",
          ].map((name) => rm(path.join("./out/main/chunks", name), { recursive: true, force: true })))
          for (const file of await readdir(DEEPAGENT_CODE_SERVER_DIST)) {
            if (
              !file.endsWith(".wasm") &&
              !["node.js", "node.js.map", "auth-password-worker.node.js", "auth-password-worker.node.js.map", "typescript-index.worker.js", "typescript-index.worker.js.map", "NOTICE",
                "node.js.native-components.json", "node.js.native-installation.json", "deepagent-work-file-helper",
                "deepagent-work-file-helper.exe", "deepagent-work-storage-cleanup", "deepagent-work-storage-cleanup.exe",
                "deepagent-work-process-supervisor", "deepagent-work-process-supervisor.exe", "bun-command-runtime.exe", "linux-native-dev-assets.json",
                "bun-command-runtime", "work-file-helper.LICENSE", "work-file-helper.NOTICE",
                "work-file-helper.UPSTREAM.json", "native-image-factory.node", "ed25519-dalek.LICENSE", "curve25519-dalek.LICENSE"].includes(
                file,
              )
            )
              continue
            await copyFile(`${DEEPAGENT_CODE_SERVER_DIST}/${file}`, `./out/main/chunks/${file}`)
          }
          if (linuxAssets) {
            await Promise.all(["runtime-closure", "linux-native-licenses"].map((name) => cp(
              path.join(DEEPAGENT_CODE_SERVER_DIST, name), path.join("./out/main/chunks", name), { recursive: true },
            )))
            const { verifyLinuxNativeAssets } = await import("./scripts/linux-native-assets")
            await verifyLinuxNativeAssets({
              directory: "./out/main/chunks", target: linuxAssets.manifest.target,
              expectedManifestHash: linuxAssets.manifestHash,
            })
          }
          await rm("./out/main/domain-packs", { recursive: true, force: true })
          await cp(DOMAIN_PACKS_DIST, "./out/main/domain-packs", { recursive: true })
        },
      },
    ],
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    plugins: [appPlugin, sentry],
    publicDir: "../../../app/public",
    root: "src/renderer",
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
        },
      },
    },
  },
  } satisfies UserConfig
})
