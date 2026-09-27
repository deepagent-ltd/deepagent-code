import path from "node:path"

export async function verifySdkBuild(directory: string): Promise<void> {
  const pkg = (await Bun.file(path.join(directory, "package.json")).json()) as {
    files?: string[]
    exports?: Record<string, string>
  }
  if (!pkg.files?.includes("dist")) throw new Error("SDK package excludes dist")
  const exports = Object.values(pkg.exports ?? {})
  if (!exports.length || exports.some((file) => !file.startsWith("./src/") || !file.endsWith(".ts")))
    throw new Error("SDK package exports cannot be verified")
  const targets = exports.flatMap((file) => {
    const stem = file.replace("./src/", "dist/").replace(/\.ts$/, "")
    return [`${stem}.js`, `${stem}.d.ts`]
  })
  const missing = (
    await Promise.all(
      targets.map(async (file) => (!(await Bun.file(path.join(directory, file)).exists()) ? file : undefined)),
    )
  ).filter((file): file is string => file !== undefined)
  if (missing.length) throw new Error(`SDK build is missing ${missing.join(", ")}`)
}

if (import.meta.main) await verifySdkBuild(path.resolve(import.meta.dir, ".."))
