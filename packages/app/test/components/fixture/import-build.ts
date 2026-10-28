import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"

/** Compile current source only; readiness and all product work still run in the original child. */
export async function buildImportFixture(entry: "import-gui-job-server.ts" | "import-history-lifecycle-server.ts") {
  if (entry !== "import-gui-job-server.ts" && entry !== "import-history-lifecycle-server.ts")
    throw new Error("Unknown current import fixture entry")
  const startedAt = Date.now()
  const host = path.resolve(process.cwd(), "../deepagent-code")
  const parent = path.join(host, ".artifacts", "unit")
  if (process.platform === "win32" && path.win32.parse(parent).root.toUpperCase() !== "D:\\")
    throw new Error("Windows import fixture builds must remain on D:")
  await fs.mkdir(parent, { recursive: true })
  const root = await fs.mkdtemp(path.join(parent, "import-source-"))
  const outfile = path.join(root, "server.js")
  await new Promise<void>((resolve, reject) => {
    execFile(
      "bun",
      [
        "build",
        path.join(host, "test", "fixture", entry),
        "--target=bun",
        "--format=esm",
        "--outdir=" + root,
        "--entry-naming=server.js",
      ],
      { cwd: host, timeout: 110_000, maxBuffer: 65_536, windowsHide: true },
      (error, _stdout, stderr) =>
        error ? reject(new Error("Current import fixture bundle failed: " + stderr, { cause: error })) : resolve(),
    )
  })
  const stat = await fs.stat(outfile)
  if (!stat.isFile()) throw new Error("Current import fixture bundle is missing")
  console.info(
    "IMPORT_FIXTURE_BUILD",
    JSON.stringify({ entry, outfile, bytes: stat.size, elapsedMs: Date.now() - startedAt }),
  )
  return outfile
}
