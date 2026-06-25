import path from "path"
import fs from "fs/promises"
import { Effect } from "effect"
import { Global } from "@deepagent-code/core/global"
import { Glob } from "@deepagent-code/core/util/glob"
import { InstallationVersion } from "@deepagent-code/core/installation/version"
import { ZipWriter, BlobWriter, BlobReader } from "@zip.js/zip.js"
import { effectCmd, fail } from "../../effect-cmd"

const WINDOWS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
}

const stamp = () =>
  new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")

interface Collected {
  readonly name: string
  readonly data: Buffer
}

export const LogsCommand = effectCmd({
  command: "logs",
  describe: "package recent logs into a zip for troubleshooting",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("since", {
        type: "string",
        choices: ["1h", "4h", "1d"] as const,
        default: "4h" as const,
        description: "how far back to include logs",
      })
      .option("out", {
        type: "string",
        description: "output zip path (defaults to ./deepagent-code-logs-<stamp>.zip)",
      }),
  handler: Effect.fn("Cli.debug.logs")(function* (args) {
    const windowMs = WINDOWS[args.since] ?? WINDOWS["4h"]
    const cutoff = Date.now() - windowMs
    const logDir = Global.Path.log

    const collected = yield* Effect.promise(() => collect(logDir, cutoff))
    if (collected.length === 0) {
      return yield* fail(`No log files modified in the last ${args.since} under ${logDir}`)
    }

    const manifest = {
      generated: new Date().toISOString(),
      version: InstallationVersion,
      platform: process.platform,
      arch: process.arch,
      since: args.since,
      logDir,
      files: collected.map((entry) => entry.name),
    }

    const output = path.resolve(args.out ?? `deepagent-code-logs-${stamp()}.zip`)
    yield* Effect.promise(() =>
      writeZip(output, [
        { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2)) },
        ...collected,
      ]),
    )
    console.log(output)
  }),
})

async function collect(dir: string, cutoff: number): Promise<Collected[]> {
  const files = await Glob.scan("*.log", { cwd: dir, absolute: false, include: "file" }).catch(() => [])
  const result: Collected[] = []
  for (const rel of files) {
    const file = path.join(dir, rel)
    try {
      const info = await fs.stat(file)
      if (info.mtimeMs < cutoff) continue
      result.push({ name: path.join("log", rel).replace(/\\/g, "/"), data: await fs.readFile(file) })
    } catch {
      continue
    }
  }
  return result
}

async function writeZip(output: string, entries: ReadonlyArray<Collected>) {
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  for (const entry of entries) {
    await writer.add(entry.name, new BlobReader(new Blob([new Uint8Array(entry.data)])))
  }
  const zip = await writer.close()
  await fs.writeFile(output, Buffer.from(await zip.arrayBuffer()))
}
