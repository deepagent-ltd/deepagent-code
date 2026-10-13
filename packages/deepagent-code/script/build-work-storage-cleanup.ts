import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"

/** Independent asset: never rebuilds or replaces the historical Work helper. */
export async function buildWorkStorageCleanup(input: { os: string; arch: string; abi?: string; destination: string }) {
  const mappedTarget = Object.entries({
    "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin",
    "linux-arm64": "aarch64-unknown-linux-gnu", "linux-x64": "x86_64-unknown-linux-gnu",
    "linux-arm64-musl": "aarch64-unknown-linux-musl", "linux-x64-musl": "x86_64-unknown-linux-musl",
    "win32-arm64": "aarch64-pc-windows-msvc", "win32-x64": "x86_64-pc-windows-msvc",
  }).find(([name]) => name === `${input.os}-${input.arch}${input.abi === "musl" ? "-musl" : ""}`)?.[1]
  if (!mappedTarget) throw new Error("Unsupported Work storage cleanup build target")
  const nativeWindows = input.os === "win32" && process.platform === "win32" && input.arch === process.arch
  const target = nativeWindows ? (() => {
    const observed = Bun.spawnSync(["rustc", "--version", "--verbose"], { stdout: "pipe", stderr: "ignore" })
    const host = /^host: (\S+)$/m.exec(observed.stdout.toString())?.[1]
    const architecture = input.arch === "arm64" ? "aarch64" : "x86_64"
    if (observed.exitCode !== 0 || !host || ![`${architecture}-pc-windows-msvc`, `${architecture}-pc-windows-gnu`].includes(host))
      throw new Error("Work storage cleanup requires the original matching Windows Rust host")
    return host
  })() : mappedTarget
  const directory = path.resolve(import.meta.dirname, "../dist/work-storage-cleanup-build")
  const result = Bun.spawn(["cargo", "build", "--locked", "--release", "--bin", "deepagent-work-storage-cleanup", ...(nativeWindows ? [] : ["--target", target])], {
    cwd: path.resolve(import.meta.dirname, "../../work-file-helper"),
    env: { ...process.env, CARGO_TARGET_DIR: directory }, stdin: "ignore", stdout: "inherit", stderr: "inherit",
  })
  if (await result.exited !== 0) throw new Error("Work storage cleanup build failed")
  const name = `deepagent-work-storage-cleanup${input.os === "win32" ? ".exe" : ""}`
  await fs.mkdir(input.destination, { recursive: true })
  await fs.copyFile(path.join(directory, ...(nativeWindows ? [] : [target]), "release", name), path.join(input.destination, name))
  await fs.chmod(path.join(input.destination, name), 0o755)
  const bytes = await fs.readFile(path.join(input.destination, name))
  return { path: `packages/work-file-helper/bin/${input.os}-${input.arch}/${name}`, bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") }
}
