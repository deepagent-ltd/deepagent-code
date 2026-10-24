import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { sharedBrowserWasmHash, type SharedBrowserComputationAsset } from "./shared-browser-compute-format"

const files = ["worker.cjs", "engine.wasm", "NOTICE", "asset.json"] as const
const source = fileURLToPath(new URL("../src/main/shared-browser-compute-worker.ts", import.meta.url))
const notice = fileURLToPath(new URL("../resources/shared-script/NOTICE", import.meta.url))

export async function prepareSharedBrowserComputationAsset(directory: string) {
  await mkdir(directory, { recursive: true })
  const build = await Bun.build({ entrypoints: [source], target: "node", format: "cjs", conditions: ["node"],
    outdir: directory, naming: "worker.cjs", minify: false, sourcemap: "none",
    plugins: [{ name: "dac-quickjs-worker-runtime-url", setup(build) {
      build.onLoad({ filter: /[/\\]emscripten-module\.mjs$/ }, async (args) => {
        const body = await readFile(args.path)
        if (digest(body) !== "3b0757e4b1051a5f344322ad6a02c075dadff70cdb50d37b7df6c120d4af77e9")
          throw new Error("Unreviewed QuickJS module factory")
        const source = body.toString("utf8")
        if (source.split("import.meta.url").length !== 4 || source.split('HOME:"/home/web_user"').length !== 2) throw new Error("Unexpected QuickJS runtime URL seam")
        // Keep createRequire and metadata relative to the actual verified worker,
        // never the machine that built the relocatable application asset.
        return { contents: source.replaceAll("import.meta.url", "globalThis.__DAC_SHARED_COMPUTE_RUNTIME_URL__").replace('HOME:"/home/web_user"', 'HOME:"/"'), loader: "js" }
      })
    } }] })
  if (!build.success) throw new Error("Computation worker build failed: " + build.logs.map(String).join("\n"))
  const wasm = await readFile(fileURLToPath(import.meta.resolve("@jitl/quickjs-wasmfile-release-sync/wasm")))
  if (wasm.length !== 503_134 || digest(wasm) !== sharedBrowserWasmHash) throw new Error("Unreviewed QuickJS engine bytes")
  const worker = await readAsset(path.join(directory, "worker.cjs"), 2_097_152)
  const license = await readFile(notice)
  const asset: SharedBrowserComputationAsset = { version: 1, workerHash: digest(worker), workerBytes: worker.length,
    wasmHash: sharedBrowserWasmHash, wasmBytes: wasm.length, noticeHash: digest(license) }
  await writeFile(path.join(directory, "engine.wasm"), wasm)
  await writeFile(path.join(directory, "NOTICE"), license)
  await writeFile(path.join(directory, "asset.json"), JSON.stringify(asset, null, 2) + "\n")
  await verifySharedBrowserComputationAsset(directory, asset)
  return asset
}

export async function copySharedBrowserComputationAsset(source: string, destination: string, expected: SharedBrowserComputationAsset) {
  await verifySharedBrowserComputationAsset(source, expected)
  await mkdir(destination, { recursive: true })
  await Promise.all(files.map((name) => copyFile(path.join(source, name), path.join(destination, name))))
  await verifySharedBrowserComputationAsset(destination, expected)
}

export async function verifySharedBrowserComputationAsset(directory: string, expected?: SharedBrowserComputationAsset) {
  const asset = JSON.parse((await readAsset(path.join(directory, "asset.json"), 4_096)).toString()) as SharedBrowserComputationAsset
  const worker = await readAsset(path.join(directory, "worker.cjs"), 2_097_152)
  const wasm = await readAsset(path.join(directory, "engine.wasm"), 1_048_576)
  const notice = await readAsset(path.join(directory, "NOTICE"), 131_072)
  if (asset.version !== 1 || asset.workerBytes !== worker.length || asset.workerHash !== digest(worker) ||
    asset.wasmBytes !== wasm.length || asset.wasmHash !== sharedBrowserWasmHash || digest(wasm) !== sharedBrowserWasmHash ||
    asset.noticeHash !== digest(notice) || expected && JSON.stringify(asset) !== JSON.stringify(expected))
    throw new Error("Computation asset verification failed")
  return asset
}

function digest(body: Buffer) { return createHash("sha256").update(body).digest("hex") }

async function readAsset(file: string, maximum: number) {
  if (await realpath(file) !== path.resolve(file)) throw new Error("Computation build asset must be physical")
  const body = await readFile(file)
  if (body.length <= 0 || body.length > maximum) throw new Error("Computation build asset size is invalid")
  return body
}
