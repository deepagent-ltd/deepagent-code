import { lstat, readdir, readFile } from "node:fs/promises"
import path from "node:path"

const forbiddenNames = new Set([
  "account.json",
  "auth.json",
  "deepagent-code.db",
  "deepagent-code-local.db",
  "deepagent.global.dat",
  "settings.json",
])

const forbiddenExtensions = [".dat", ".db", ".db-shm", ".db-wal", ".sqlite", ".log", ".jsonl"]
const absoluteHome = /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)/
const runtimeDataPath =
  /(?:Library\/Application Support\/ai\.deepagent-code|\.deepagent\/code|AppData\\Roaming\\ai\.deepagent-code)/
const textExtensions = new Set([".cjs", ".js", ".json", ".md", ".mjs", ".plist", ".txt", ".xml", ".yaml", ".yml"])

async function files(directory: string): Promise<string[]> {
  return (
    await Promise.all(
      (await readdir(directory, { withFileTypes: true }).catch(() => []))
        .map((entry) => {
          const file = path.join(directory, entry.name)
          if (entry.isSymbolicLink()) return [file]
          return entry.isDirectory() ? files(file) : [file]
        }),
    )
  ).flat()
}

export async function auditPackageInputs(desktopDir: string) {
  const failures = (
    await Promise.all(
      (await Promise.all([files(path.join(desktopDir, "out")), files(path.join(desktopDir, "resources"))]))
        .flatMap((entries) => entries)
        .map(async (file) => {
          const relative = path.relative(desktopDir, file).replaceAll("\\", "/")
          const lower = path.basename(file).toLowerCase()
          const symbolicLink = (await lstat(file)).isSymbolicLink()
          const reasons = [
            symbolicLink ? "symbolic link" : undefined,
            forbiddenNames.has(lower) || forbiddenExtensions.some((extension) => lower.endsWith(extension))
              ? "runtime user-data file"
              : undefined,
          ]
          if (!symbolicLink && textExtensions.has(path.extname(lower)) && !lower.endsWith(".map")) {
            const contents = await readFile(file, "utf8").catch(() => "")
            if (absoluteHome.test(contents)) reasons.push("absolute user home path")
            if (
              (relative.startsWith("out/main/domain-packs/") || relative.startsWith("resources/")) &&
              runtimeDataPath.test(contents)
            )
              reasons.push("runtime user-data path")
          }
          return reasons.filter((reason): reason is string => !!reason).map((reason) => `${relative}: ${reason}`)
        }),
    )
  ).flat()
  if (failures.length === 0) return
  throw new Error(`Refusing to package unsafe files:\n${failures.join("\n")}`)
}
