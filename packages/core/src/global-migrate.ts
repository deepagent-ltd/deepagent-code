export * as GlobalMigrate from "./global-migrate"

import path from "path"
import fs from "fs/promises"
import { legacyDataHome, platformConfigHome, platformDataHome } from "./global-path"

// D-W1 one-time migration for native Windows installs that still carry the pre-split unified
// root (~/.deepagent/code, used by early previews and the WSL era). The tree moves to the
// machine-local data home (%LOCALAPPDATA%\deepagent-code); config-class entries — user config
// files and credential stores — relocate into the roaming config home (%APPDATA%\deepagent-code).
// The legacy directory is left behind holding only a MIGRATED.txt pointer, which also serves as
// the idempotency marker for subsequent starts. Best-effort by contract: startup must never fail
// because a migration step did.

// Top-level entries of the legacy unified root that belong to the roaming config home.
const CONFIG_ENTRIES = [
  "config.json",
  "config.jsonc",
  "deepagent-code.json",
  "deepagent-code.jsonc",
  "config",
  "tui.json",
  "tui.jsonc",
  "auth.json",
  "account.json",
  "mcp-auth.json",
  "mcp-secrets.json",
  "settings.json",
  // Config-root directories: themes, agent definitions (cli `agents`), and the global plugin
  // patch targets written under <config>/deepagent-code and <config>/tui.
  "themes",
  "agents",
  "deepagent-code",
  "tui",
]

export const NOTE = "MIGRATED.txt"

export type Report = {
  readonly migrated: boolean
  readonly skipped?: "not-win32" | "test-override" | "no-legacy-home" | "already-migrated" | "data-home-exists"
  readonly movedToConfig: readonly string[]
  readonly error?: string
}

const note = (data: string, config: string) =>
  [
    "DeepAgent Code data moved to the standard Windows locations.",
    "",
    `  Data, caches, worktrees, snapshots: ${data}`,
    `  Config and credentials:             ${config}`,
    "",
    "This directory (~/.deepagent/code) is no longer used and can be deleted.",
  ].join("\n")

// App-managed scaffold entries that may legitimately exist inside a FRESH data home before the
// first process able to migrate runs: the npm postinstall stages package installs under tmp/,
// and the desktop main bootstraps its Electron storage under desktop/ BEFORE the sidecar (the
// only process that loads the global module and its top-level migration hook) ever starts.
// A data home holding only these is not user data — the migration merges into it instead of
// refusing forever (the original data-home-exists refusal stranded preview-era users' data).
const SCAFFOLD_ENTRIES = new Set(["tmp", "desktop"])

const isDirectory = (value: string) =>
  fs
    .stat(value)
    .then((stat) => stat.isDirectory())
    .catch(() => false)

async function move(source: string, target: string) {
  try {
    await fs.rename(source, target)
  } catch (error) {
    // Cross-volume moves (redirected AppData) cannot rename; copy then remove instead.
    if (!(error instanceof Error && "code" in error && error.code === "EXDEV")) throw error
    await fs.cp(source, target, { recursive: true })
    await fs.rm(source, { recursive: true, force: true })
  }
}

// Paths are explicit parameters (not resolved from env/platform here) so the full migration logic
// is exercisable off-Windows; the win32-only gate lives in migrateLegacyHomeIfNeeded.
export async function migrateLegacyHome(input: {
  legacy: string
  data: string
  config: string
}): Promise<Report> {
  try {
    if (!(await isDirectory(input.legacy))) return { migrated: false, skipped: "no-legacy-home", movedToConfig: [] }
    const entries = await fs.readdir(input.legacy)
    if (entries.every((entry) => entry === NOTE)) return { migrated: false, skipped: "already-migrated", movedToConfig: [] }
    const dataExists = await isDirectory(input.data)
    if (dataExists) {
      // Only an app-scaffold-only data home is migratable (merge); anything else the user put
      // there is real data the migration must never overwrite.
      const dataEntries = await fs.readdir(input.data)
      if (!dataEntries.every((entry) => SCAFFOLD_ENTRIES.has(entry)))
        return { migrated: false, skipped: "data-home-exists", movedToConfig: [] }
    }

    if (dataExists) {
      // Merge mode: the legacy tree moves entry by entry into the scaffolded data home. A
      // scaffold dir colliding with a legacy entry is app-generated and disposable — drop the
      // scaffold copy so the user's entry lands; any other failure leaves that entry behind
      // (best-effort contract) and the MIGRATED.txt note still points at the new home.
      for (const entry of entries.filter((entry) => entry !== NOTE)) {
        const source = path.join(input.legacy, entry)
        const target = path.join(input.data, entry)
        if (SCAFFOLD_ENTRIES.has(entry)) await fs.rm(target, { recursive: true, force: true }).catch(() => {})
        await move(source, target).catch(() => {})
      }
    } else {
      await fs.mkdir(path.dirname(input.data), { recursive: true })
      await move(input.legacy, input.data)
    }

    const movedToConfig: string[] = []
    await fs.mkdir(input.config, { recursive: true })
    for (const entry of CONFIG_ENTRIES) {
      const source = path.join(input.data, entry)
      if (!(await fs.stat(source).catch(() => undefined))) continue
      try {
        await move(source, path.join(input.config, entry))
        movedToConfig.push(entry)
      } catch {
        // Leave the entry in the data home rather than fail startup over one file.
      }
    }

    await fs.mkdir(input.legacy, { recursive: true })
    await fs.writeFile(path.join(input.legacy, NOTE), note(input.data, input.config), "utf8")
    return { migrated: true, movedToConfig }
  } catch (error) {
    return { migrated: false, movedToConfig: [], error: String(error) }
  }
}

export async function migrateLegacyHomeIfNeeded(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<Report | undefined> {
  if (platform !== "win32") return undefined
  // The test/desktop boundary (DEEPAGENT_CODE_TEST_HOME) isolates all storage; never migrate there.
  if (env.DEEPAGENT_CODE_TEST_HOME) return undefined
  const legacy = legacyDataHome(env)
  const data = platformDataHome(env, platform)
  if (legacy === data) return undefined
  const report = await migrateLegacyHome({ legacy, data, config: platformConfigHome(env, platform) })
  if (report.skipped === "no-legacy-home") return undefined
  return report
}
