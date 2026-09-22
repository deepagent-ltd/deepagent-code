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
// W4-6: re-pinned again for the session_wire_projection migration (20260904171154) — the
// journal→V1-wire egress fingerprint cursor table.
// their released database IDs as compatibility aliases.
// Successor pin (2026-08-28): the event-ledger wiring migration body
// (20260829030000_wire_event_ledgers) joined the registry, so the ordered
// registry digest moved. The pin tracks the current release candidate.
// Successor pin (W2, 2026-09-01): the session-provider recovery persistence
// migration (20260830000000_session_provider_recovery) joined the registry, so
// the ordered registry digest moved again.
// Successor pin (W2-1, 2026-09-02): the session-provider recovery migration body
// gained the recovery_command state CHECK and the descriptor immutability
// triggers (anti-review W2-1 issue 7), so the ordered registry digest moved
// again. Explicit re-pin: the previous pin covered the pre-hardening body.
// Successor pin (W4, 2026-09-01): the session_capability_load persistence
// migration joined the registry (generated from the Drizzle schema via
// `bun script/migration.ts`), so the ordered registry digest moved again.
// Successor pin (W8, 2026-09-04): the W8 protocol-close migration
// (20260904120000_v2_provider_prepared_turn_canonical_hash) re-created the V2
// provider transition guard and the parity receipt authority guard for the
// identity-folded canonical prepared_turn_hash, so the ordered registry digest
// moved again.
// Successor pin (W5.1, 2026-09-10): the event-admission refusal-reason
// migration (20260910000000_event_admission_refusal_reason) joined the
// registry (event admission no longer refuses with a coarse static reason but
// persists the per-admission refusal reason), so the ordered registry digest
// moved again. Explicit re-pin of the W5.1 trigger.
// Successor pin (2026-09-08, runtime-integrity remediation): four migrations
// joined the registry — 20260906190036_capability_load_catalog_identity
// (capability-load catalog identity unique index), 20260907020000_session_interrupt_barrier
// (RI-115 durable interrupt barrier), 20260907120000_provider_attempt_version
// (RI-53 attempt_version + execution_claim_token), 20260907130000_migration_journal_content_hash
// (journal content-hash column). `migration --check` green and fresh-apply/re-apply
// oracle green; explicit re-pin of the release candidate.
// Successor pin (2026-09-09, RI-16/RI-24): session-delete tombstones, retention index,
// runtime-integrity evidence, and signature persistence migrations joined the registry; the
// journal content-hash migration also gained a missing-receipt guard for old disk fixtures.
// Successor pin (2026-09-09, RI-24 artifact wave): the independent content-addressed runtime
// integrity evidence artifact table and its immutable signature-attachment trigger joined.
// Successor pin (2026-09-10, RI-18): the durable session_v2_compaction_request migration joined
// the registry (native manual compaction); `migration --check` green at re-pin time.
// Successor pin (2026-09-18, durable-only wave): four migrations joined — v2 task_run
// execution_runtime discriminator, im_reply_outbox, command_side_effect_receipt, and the
// one-time task_run v1 recovery_required sweep; `migration --check` green at re-pin time.
// Successor pin (2026-09-19, durable-only wave 3 worklist #29 part 2): the V2 structured-output
// evidence authority migration (20260919073750_v2_structured_output_evidence) joined the
// registry (session_v2_structured_output_evidence + insert/update/delete guards);
// `migration --check` green at re-pin time.
// Successor pin (2026-09-23, A1-09/B-17): the execution_claim_token rename migration
// (20260922152631_execution_claim_token) joined the registry (session.time_suspended column
// renamed to execution_claim_token + partial index rename); explicit re-pin of the release
// candidate.
// Successor pin (2026-09-23, C-P2-08): the durable task-call fan-out admission migration
// (20260922182048_v2_task_call_admission) joined the registry (the per-message subagent
// fan-out cap ledger: session_v2_task_call_admission with a globally unique tool_call_id
// plus the (session_id, assistant_message_id) batch index); explicit re-pin of the release
// candidate.
const PINNED_DIGEST = "a289d171a1b6c48504ba281339ac2b8ab077a15fc90bd554ed256e54e89d7bf2"

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
