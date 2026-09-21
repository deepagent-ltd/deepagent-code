import path from "path"
import { access } from "node:fs/promises"

/**
 * Filesystem companions for transcript exports (node/Bun runtimes only — transcript.ts
 * itself stays isomorphic so the web app can import it). Shared by the TUI and CLI
 * export paths.
 */

const exists = (filepath: string) => access(filepath).then(
  () => true,
  () => false,
)

/** Never overwrite an existing export: auto-suffix `-2`, `-3`, ... before the extension. */
export async function uniqueExportPath(filepath: string): Promise<string> {
  if (!(await exists(filepath))) return filepath
  const ext = path.extname(filepath)
  const stem = filepath.slice(0, filepath.length - ext.length)
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`
    if (!(await exists(candidate))) return candidate
  }
}
