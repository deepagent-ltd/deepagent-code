import { chmod } from "node:fs/promises"
import path from "node:path"

// The release guards spawn a real executable. Windows does not execute a POSIX shebang.
export async function jsonCommand(directory: string, name: string, filename: string) {
  const executable = path.join(directory, process.platform === "win32" ? `${name}.exe` : name)
  if (process.platform !== "win32") {
    await Bun.write(executable, `#!/bin/sh\ncat '${filename.replaceAll("'", "'\\''")}'\n`)
    await chmod(executable, 0o755)
    return executable
  }
  const source = path.join(directory, `${name}.ts`)
  await Bun.write(source, `console.log(await Bun.file(${JSON.stringify(filename)}).text())`)
  const built = Bun.spawnSync([process.execPath, "build", "--compile", source, "--outfile", executable], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (built.exitCode !== 0) throw new Error(built.stderr.toString())
  return executable
}
