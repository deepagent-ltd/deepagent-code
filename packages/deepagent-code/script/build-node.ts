#!/usr/bin/env bun

import { Script } from "@deepagent-code/script"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

await Bun.build({
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

console.log("Build complete")
