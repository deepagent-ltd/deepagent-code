import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { sharedBrowserWasmHash, type SharedBrowserComputationAsset } from "../../scripts/shared-browser-compute-format"
declare const __DAC_SHARED_BROWSER_COMPUTE_ASSET__: SharedBrowserComputationAsset | undefined

/** The trusted build embeds the expected worker digest. Neither a mutable manifest,
 * a package search path nor an external URL supplies executable authority. */
export function sharedBrowserComputationAsset() {
  if (typeof __DAC_SHARED_BROWSER_COMPUTE_ASSET__ === "undefined") throw new Error("Computation asset unavailable")
  const expected = __DAC_SHARED_BROWSER_COMPUTE_ASSET__
  const directory = fileURLToPath(new URL("./shared-browser-compute/", import.meta.url))
    .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
  const worker = path.join(directory, "worker.cjs")
  const body = readSharedBrowserComputationAsset(worker, 2_097_152)
  const wasm = readSharedBrowserComputationAsset(path.join(directory, "engine.wasm"), 1_048_576)
  if (expected.version !== 1 || expected.wasmHash !== sharedBrowserWasmHash || body.length !== expected.workerBytes ||
    digest(body) !== expected.workerHash || wasm.length !== expected.wasmBytes || digest(wasm) !== sharedBrowserWasmHash)
    throw new Error("Computation assets do not match the trusted build")
  return { worker, code: `Object.defineProperty(globalThis,"__DAC_SHARED_COMPUTE_RUNTIME_URL__",{value:${JSON.stringify(pathToFileURL(worker).href)}});\n` + body.toString("utf8"), wasm }
}

export function readSharedBrowserComputationAsset(file: string, maximum: number) {
  if (realpathSync(file) !== path.resolve(file) || !lstatSync(file).isFile()) throw new Error("Computation asset must be physical")
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.size <= 0 || before.size > maximum) throw new Error("Computation asset size is invalid")
    const body = Buffer.alloc(before.size)
    if (readSync(fd, body, 0, body.length, 0) !== body.length) throw new Error("Computation asset read was incomplete")
    const after = fstatSync(fd)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Computation asset changed during read")
    return body
  } finally { closeSync(fd) }
}

function digest(body: Buffer) { return createHash("sha256").update(body).digest("hex") }
