import fs from "node:fs/promises"
import path from "node:path"

/** Builds start with an empty owned directory and retain the exact previous candidate.
 * An explicit output is always fresh, so a typo cannot replace an existing install. */
export async function prepareBuildOutput(directory: string, args: readonly string[]) {
  const index = args.indexOf("--outdir")
  if (index >= 0 && (!args[index + 1] || args[index + 1]!.startsWith("--")))
    throw new Error("--outdir requires a new output directory")
  const output = path.resolve(directory, index >= 0 ? args[index + 1]! : "dist")
  const relative = path.relative(output, directory)
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)))
    throw new Error("Build output cannot replace the source directory or its ancestor")
  const prior = await fs.lstat(output).then(
    (value) => value,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return
      throw error
    },
  )
  if (index >= 0 && prior) throw new Error("--outdir must name a directory that does not exist")
  if (prior && (!prior.isDirectory() || prior.isSymbolicLink()))
    throw new Error("Previous build output must be a real directory")
  const previous = prior ? `${output}.previous-${Date.now()}-${process.pid}-${crypto.randomUUID()}` : undefined
  if (previous) await fs.rename(output, previous)
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.mkdir(output)
  return { output, previous }
}
