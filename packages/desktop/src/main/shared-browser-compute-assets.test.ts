import { expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { auditPackageInputs } from "../../scripts/audit-package"
import { copySharedBrowserComputationAsset, prepareSharedBrowserComputationAsset, verifySharedBrowserComputationAsset } from "../../scripts/shared-browser-compute-assets"

test("fixed computation assets relocate with notices and reject changed worker, WASM or manifest bytes", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "dac-shared-compute-pack-")))
  const source = path.join(root, "build")
  const destination = path.join(root, "app.asar.unpacked/out/main/shared-browser-compute")
  const asset = await prepareSharedBrowserComputationAsset(source)
  await copySharedBrowserComputationAsset(source, destination, asset)
  expect(await verifySharedBrowserComputationAsset(destination, asset)).toEqual(asset)
  expect(asset.wasmBytes).toBe(503_134)
  await auditPackageInputs(path.join(root, "app.asar.unpacked"))
  const notice = await readFile(path.join(destination, "NOTICE"), "utf8")
  expect(notice).toContain("LLVM Exceptions")
  expect(notice).toContain("2017-2025")
  expect(notice).toContain("2024 Fabrice Bellard")
  for (const filename of ["worker.cjs", "engine.wasm", "asset.json"]) {
    const file = path.join(destination, filename)
    const original = await readFile(file)
    await writeFile(file, Buffer.concat([original, Buffer.from(" ")]))
    // JSON whitespace is semantically unchanged, but the independent expected
    // manifest still pins all executable fields. Change one executable digest.
    if (filename === "asset.json") await writeFile(file, JSON.stringify({ ...asset, workerHash: "0".repeat(64) }))
    await expect(verifySharedBrowserComputationAsset(destination, asset)).rejects.toThrow()
    await writeFile(file, original)
  }
  console.log("SHARED_COMPUTE_PACK_EVIDENCE", root)
}, 10_000)
