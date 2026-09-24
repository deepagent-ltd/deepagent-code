import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

// Static gate for session.execution_claim_token (renamed from time_suspended): the column is the
// V2 execution claim CAS fence, so exactly two writers may touch it — SessionStore.claim/release
// and the durable recovery store's claim-matched release. A new write path outside those two
// files fails here instead of silently racing the fence. Reads and the same-named
// session_provider_attempt column are NOT gated.

const coreRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src")
const ALLOWED_WRITERS = ["session/store.ts", "session/runner/recovery-durable-store.ts"]

// Drizzle: an update(SessionTable) statement whose .set({...}) assigns execution_claim_token.
const drizzleWrite = /update\(\s*SessionTable\s*\)[\s\S]{0,300}?\.set\(\s*\{[\s\S]{0,300}?execution_claim_token/
// Raw SQL: UPDATE session SET / INSERT INTO session column lists carrying the column. The quoted
// table name cannot bleed into session_provider_attempt.
const sqlWrite = /\b(?:UPDATE\s+[`"]session[`"]\s+SET|INSERT\s+INTO\s+[`"]session[`"]\s*\()[^;]*execution_claim_token/i

const files = Array.from(new Bun.Glob("**/*.ts").scanSync({ cwd: coreRoot })).map((file) => file.replaceAll("\\", "/")).sort()

describe("session execution_claim_token write gate", () => {
  test("no file outside the two claim writers touches the column", () => {
    const offenders = files
      .filter((file) => !ALLOWED_WRITERS.includes(file))
      .filter((file) => {
        const text = readFileSync(path.join(coreRoot, file), "utf8")
        return drizzleWrite.test(text) || sqlWrite.test(text)
      })
    expect(offenders).toEqual([])
  })

  test("the whitelisted writers still write the column (the gate cannot pass vacuously)", () => {
    const missing = ALLOWED_WRITERS.filter(
      (file) => !drizzleWrite.test(readFileSync(path.join(coreRoot, file), "utf8")),
    )
    expect(missing).toEqual([])
  })
})
