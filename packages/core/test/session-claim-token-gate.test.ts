import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

// Static gate for session.execution_claim_token (renamed from time_suspended): the column is the
// V2 execution claim CAS fence. SessionStore owns claim/release; the recovery stores may only
// release an authenticated, exact historical claim. A new write path outside those reviewed
// files fails here instead of silently racing the fence. Reads and the same-named
// session_provider_attempt column are NOT gated.

const coreRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src")
const ALLOWED_WRITERS = ["session/store.ts", "session/runner/recovery-durable-store.ts"]
const KNOWN_RELEASE_WRITERS = ["session/work-known-recovery.ts", "session/work-known-recovery-v2.ts"]

// Drizzle: an update(SessionTable) statement whose .set({...}) assigns execution_claim_token.
const drizzleWrite = /update\(\s*SessionTable\s*\)[\s\S]{0,300}?\.set\(\s*\{[\s\S]{0,300}?execution_claim_token/
// Raw SQL: UPDATE session SET / INSERT INTO session column lists carrying the column. The quoted
// table name cannot bleed into session_provider_attempt.
const sqlWrite = /\b(?:UPDATE\s+[`"]session[`"]\s+SET|INSERT\s+INTO\s+[`"]session[`"]\s*\()[^;]*execution_claim_token/i

const files = Array.from(new Bun.Glob("**/*.ts").scanSync({ cwd: coreRoot })).sort()

describe("session execution_claim_token write gate", () => {
  test("no file outside the reviewed claim writers touches the column", () => {
    const offenders = files
      .filter((file) => ![...ALLOWED_WRITERS, ...KNOWN_RELEASE_WRITERS].includes(file))
      .filter((file) => {
        const text = readFileSync(path.join(coreRoot, file), "utf8")
        return drizzleWrite.test(text) || sqlWrite.test(text)
      })
    expect(offenders).toEqual([])
  })

  test("known recovery only clears an authenticated exact claim in the receipt transaction", () => {
    for (const file of KNOWN_RELEASE_WRITERS) {
      const source = readFileSync(path.join(coreRoot, file), "utf8")
      expect(source.match(/update\(SessionTable\)/g)).toHaveLength(1)
      expect(source).toMatch(/update\(SessionTable\)\.set\(\{ execution_claim_token: null,[\s\S]*?eq\(SessionTable\.id, SessionSchema\.ID\.make\(request\.sessionID\)\),\s*eq\(SessionTable\.execution_claim_token, request\.expectedClaimToken\),/)
      expect(source).toMatch(/host\.authenticate\(tx, witness, record\)[\s\S]*?tx\.insert\(WorkKnownRecovery(?:V2)?Table\)[\s\S]*?tx\.update\(SessionTable\)/)
      expect(source).toContain('if (!changed) return yield* failure("RECOVERY_CONFLICT")')
      expect(source).toContain('{ behavior: "immediate" }')
    }
  })

  test("the whitelisted writers still write the column (the gate cannot pass vacuously)", () => {
    const missing = ALLOWED_WRITERS.filter(
      (file) => !drizzleWrite.test(readFileSync(path.join(coreRoot, file), "utf8")),
    )
    expect(missing).toEqual([])
  })
})
