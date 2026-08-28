import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "electron-vite"
import appPlugin from "@deepagent-code/app/vite"
import { copyFile, cp, mkdir, readdir, rm } from "node:fs/promises"

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

export default defineConfig({
  main: {
    define: {
      "import.meta.env.DEEPAGENT_CODE_CHANNEL": JSON.stringify(channel),
    },
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts", sidecar: "src/main/sidecar.ts" },
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
          await mkdir("./out/main/chunks", { recursive: true })
          for (const file of await readdir(DEEPAGENT_CODE_SERVER_DIST)) {
            if (!file.endsWith(".wasm") && !["node.js", "node.js.map", "models-dev.build.json"].includes(file))
              continue
            await copyFile(`${DEEPAGENT_CODE_SERVER_DIST}/${file}`, `./out/main/chunks/${file}`)
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
})
