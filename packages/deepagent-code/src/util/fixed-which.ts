export * as FixedWhich from "./fixed-which"

import fs from "node:fs/promises"
import path from "node:path"

/** Resolve only the supplied absolute PATH. Empty or relative search entries never imply cwd.
 * Windows profiles are unsupported: do not consult PATHEXT or turn .cmd/.bat into implicit shell execution. */
export async function find(command: string, options: { cwd: string; PATH: string; platform?: NodeJS.Platform }) {
  if (
    (options.platform ?? process.platform) === "win32" ||
    !options.cwd ||
    !path.isAbsolute(options.cwd) ||
    options.cwd.includes("\0") ||
    !command ||
    command.includes("\0") ||
    Buffer.byteLength(command) > 65_536 ||
    Buffer.byteLength(options.PATH) > 65_536
  )
    return undefined
  const entries = options.PATH.split(path.delimiter)
  if (entries.length > 32 || entries.some((item) => !item || !path.isAbsolute(item) || item.includes("\0")))
    return undefined
  const candidates = command.includes(path.sep)
    ? [path.resolve(options.cwd, command)]
    : entries.map((directory) => path.join(directory, command))
  for (const candidate of candidates) {
    const resolved = await fs.realpath(candidate).catch(() => undefined)
    if (!resolved) continue
    const stat = await fs.stat(resolved).catch(() => undefined)
    if (!stat?.isFile()) continue
    if (
      await fs.access(resolved, fs.constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return resolved
  }
  return undefined
}
