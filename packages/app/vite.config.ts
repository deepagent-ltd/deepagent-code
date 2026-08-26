import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "vite"
import desktopPlugin from "./vite"

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
          assets: "./dist/**",
          filesToDeleteAfterUpload: "./dist/**/*.map",
        },
      })
    : false

export default defineConfig({
  plugins: [desktopPlugin, sentry] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
    watch: {
      // SST regenerates workspace bindings (sst-env.d.ts) and re-touches package.json /
      // tsconfig.json across every package as a background step. The content is unchanged
      // but the mtime bump trips Vite's watcher → a full page reload that looks like the app
      // "restarting" on its own. None of these are app sources, so ignore them.
      ignored: ["**/sst-env.d.ts", "**/.sst/**"],
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      jsx: "automatic",
    },
  },
  build: {
    target: "esnext",
    sourcemap: true,
  },
})
