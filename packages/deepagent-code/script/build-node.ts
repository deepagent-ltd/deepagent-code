#!/usr/bin/env bun

import { Script } from "@deepagent-code/script"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

const result = await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "linked",
  external: ["jsonc-parser", "@lydell/node-pty"],
  define: {
    DEEPAGENT_CODE_MODELS_DEV: generated.modelsData,
    DEEPAGENT_CODE_CHANNEL: `'${Script.channel}'`,
  },
  files: {
    "deepagent-code-web-ui.gen.ts": "",
  },
})
if (!result.success) throw new AggregateError(result.logs, "Failed to build the Node server")

// Bun preserves CommonJS __dirname/__filename values for bundled dependencies. Those values point
// at the build machine and are unusable after installation, so make the bundle reproducible and
// keep local usernames/workspace paths out of release artifacts.
const buildRoot = path.resolve(dir, "../..")
const bundle = Bun.file("./dist/node/node.js")
await Bun.write(
  bundle,
  (await bundle.text())
    .replaceAll(buildRoot, "/__deepagent_build__")
    .replaceAll(buildRoot.replaceAll("\\", "/"), "/__deepagent_build__")
    .replaceAll(buildRoot.replaceAll("\\", "\\\\"), "/__deepagent_build__"),
)

console.log("Build complete")
