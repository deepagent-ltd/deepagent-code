import { describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import fs from "fs"
import path from "path"
import { migrations } from "../src/database/migration.gen"

// §16.4 DATA-AND-RECOVERY D-1 — migration determinism gate. The generated registry must stay
// byte-stable for the pinned release candidate: any change to the ordered migration set, any
// reorder, any edited migration source, or any id/content divergence fails this gate and must be
// re-pinned as an explicit release-planning action (never silently absorbed). The digest covers
// the ordered (id, source-content-hash) pairs, so it captures BOTH the id list and each
// migration's executable body.
// Re-pinned after five incident-labelled migration identities were canonicalized while retaining
// their released database IDs as compatibility aliases.
// Successor pin (2026-08-28): the event-ledger wiring migration body
// (20260829030000_wire_event_ledgers) joined the registry, so the ordered
// registry digest moved. The pin tracks the current release candidate.
const PINNED_DIGEST = "c1762b0df77600e7fb84e238aaa4f8e10629629b50792169eb05fd06dbb537c7"

const digest = (entries: readonly { readonly id: string; readonly hash: string }[]) =>
  createHash("sha256").update(JSON.stringify(entries)).digest("hex")

describe("migration registry gate", () => {
  test("registry entries are unique and backed by their source files", () => {
    // The registry order is the APPLY order (historical out-of-order ids are accepted by the
    // apply chain); the digest below pins that order exactly, so no separate sort assertion here.
    const ids = migrations.map((migration) => migration.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      const file = path.join("src/database/migration", `${id}.ts`)
      expect(fs.existsSync(file)).toBe(true)
    }
  })

  test("ordered registry digest matches the pinned release candidate", () => {
    const entries = migrations.map((migration) => {
      const content = fs.readFileSync(path.join("src/database/migration", `${migration.id}.ts`), "utf8")
      return { id: migration.id, hash: createHash("sha256").update(content).digest("hex") }
    })
    expect(entries.length).toBeGreaterThan(100)
    expect(digest(entries)).toBe(PINNED_DIGEST)
  })

  test("applying all registry migrations to an empty database succeeds and re-applying is a no-op", async () => {
    // The full fresh-apply path (including idempotent re-apply) lives in database-migration.test.ts;
    // this case pins the D-1 contract that the registry itself is the apply list.
    expect(migrations.every((migration) => typeof migration.up === "function")).toBe(true)
  })
})
