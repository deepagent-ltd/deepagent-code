// FEAT-001: pinned domain packs (docs/34 §9 S10) persist per-workspace as a small JSON file under
// the gateway memory dir (`<baseDir>/memory/pinned-packs.json`). The GUI writes it via the HTTP
// handlers; the agent gateway reads it so pins actually shape retrieval. This module is the single
// fault-tolerant reader/writer shared by both sides — missing or corrupt files degrade to "no pins",
// never an error. It lives in core because the gateway (core) must read it and cannot import
// deepagent-code; the handlers (deepagent-code) import it from core.

import path from "node:path"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"

/** File name of the pinned-pack list inside the workspace memory dir. */
export const PINNED_PACKS_FILE = "pinned-packs.json"

/** Absolute path of the pinned-pack file for a given memory dir. */
export const pinnedPacksFile = (memoryDir: string): string => path.join(memoryDir, PINNED_PACKS_FILE)

/**
 * Read the pinned pack ids from `<memoryDir>/pinned-packs.json`.
 * Fault-tolerant: a missing file, unreadable file, invalid JSON, or a non-array payload all yield
 * an empty list (no pins). Non-string entries inside a valid array are dropped.
 */
export const readPinnedPacks = (memoryDir: string): string[] => {
  try {
    const raw = readFileSync(pinnedPacksFile(memoryDir), "utf8")
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []
  } catch {
    return []
  }
}

/**
 * Write the pinned pack ids (deduplicated, sorted) to `<memoryDir>/pinned-packs.json`,
 * creating the memory dir when absent.
 */
export const writePinnedPacks = (memoryDir: string, ids: readonly string[]): void => {
  mkdirSync(memoryDir, { recursive: true })
  writeFileSync(pinnedPacksFile(memoryDir), JSON.stringify([...new Set(ids)].sort(), null, 2), "utf8")
}
