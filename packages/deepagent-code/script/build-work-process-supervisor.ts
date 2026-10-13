import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"

/** Native Linux builds only. No caller executable or runtime PATH selection.
 * The reviewed interpreter's actual loader/library closure becomes inventory. */
export async function buildWorkProcessSupervisor(input: { os: string; arch: string; destination: string }) {
  if (input.os !== "linux" || process.platform !== "linux" || input.arch !== process.arch || !["arm64", "x64"].includes(input.arch))
    throw new Error("Native Linux supervisor build required")
  const target = input.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"
  const directory = path.resolve(import.meta.dirname, "../dist/work-supervisor-build")
  const child = Bun.spawn(["cargo", "build", "--locked", "--release", "--bin", "deepagent-work-process-supervisor", "--target", target], {
    cwd: path.resolve(import.meta.dirname, "../../work-file-helper"), env: { ...process.env, CARGO_TARGET_DIR: directory },
    stdin: "ignore", stdout: "inherit", stderr: "inherit",
  })
  if (await child.exited !== 0) throw new Error("Work supervisor build failed")
  await fs.mkdir(input.destination, { recursive: true })
  await fs.copyFile(path.join(directory, target, "release/deepagent-work-process-supervisor"), path.join(input.destination, "deepagent-work-process-supervisor"))
  await fs.chmod(path.join(input.destination, "deepagent-work-process-supervisor"), 0o755)
  const runtime = await fs.realpath(process.execPath)
  const binary = await fs.readFile(runtime)
  if (binary.length < 20 || binary.length > 268_435_456 || !binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    binary[4] !== 2 || binary[5] !== 1 || binary.readUInt16LE(18) !== (input.arch === "arm64" ? 183 : 62))
    throw new Error("Command runtime does not match the actual Linux target")
  await fs.writeFile(path.join(input.destination, "bun-command-runtime"), binary, { flag: "wx", mode: 0o755 })
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("/usr/bin/ldd", [runtime], { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] })
    const state = { text: "", error: "" }
    child.stdout.on("data", (chunk: Buffer) => { state.text += chunk.toString("utf8"); if (Buffer.byteLength(state.text) > 32_768) child.kill("SIGKILL") })
    child.stderr.on("data", (chunk: Buffer) => { state.error += chunk.toString("utf8"); if (Buffer.byteLength(state.error) > 8192) child.kill("SIGKILL") })
    child.on("error", reject)
    child.on("close", (code) => code === 0 && state.error.length === 0 && !state.text.includes("not found") ? resolve(state.text) : reject(new Error("Runtime closure unavailable")))
  })
  const libraries = [...new Set(output.split("\n").flatMap((line) => {
    const match = /(?:=>\s*)?(\/(?:lib|lib64|usr\/lib|usr\/lib64)\/[^\s]+)\s+\(0x[0-9a-f]+\)/.exec(line)
    return match ? [match[1]!] : []
  }))]
  if (libraries.length === 0 || libraries.length > 128) throw new Error("Explicit runtime closure required")
  const assets = ["deepagent-work-process-supervisor", "bun-command-runtime"]
  for (const library of libraries) {
    const relative = `runtime-closure${library}`
    if (relative.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Unsafe runtime closure path")
    await fs.mkdir(path.dirname(path.join(input.destination, relative)), { recursive: true })
    const source = await fs.realpath(library)
    const mode = (await fs.stat(source)).mode & 0o111
    await fs.copyFile(source, path.join(input.destination, relative))
    // The ELF interpreter must remain executable. Preserve that reviewed
    // source property while removing every write bit except owner write.
    await fs.chmod(path.join(input.destination, relative), mode ? 0o755 : 0o644)
    assets.push(relative)
  }
  return await Promise.all(assets.map(async (relative) => {
    const bytes = await fs.readFile(path.join(input.destination, relative))
    return { path: `packages/work-file-helper/bin/${input.os}-${input.arch}/${relative}`, bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") }
  }))
}
