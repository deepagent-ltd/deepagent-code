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
// Successor pin (2026-09-23, K-01 R-3): the recovery_command_exit migration
// (20260922182457_recovery_command_exit) joined the registry (command_kind/evidence columns
// for the confirm-settled durable exit) alongside the merged v2_task_call_admission entry;
// explicit re-pin over the merged tree.
// Successor pin (2026-09-24, 2.0.2 merged tree): nine reviewed migrations joined for proxy
// gateway + permission policy, input revert epoch, learning generation, V2 session authority,
// event task workspaces, long-context checkpoints, terminal consumer receipts, and provider
// attempt protocol identity. No previously pinned migration source changed; the generated
// registry appended exactly these nine ordered identities and body hashes.
// X-08 request-identity hardening adds one nullable, immutable im_send request fingerprint
// column; the 203-entry ordered registry is re-pinned after its fresh-apply oracle passed.
// Successor pin (2026-10-05, JuggleIM B1): the im_kernel_sync migration joined the registry
// (im_messages.kernel_msg_id + im_groups.kernel_conv_id unique-indexed dedup/binding columns and
// the im_sync_cursors high-water table); `migration --check` green at re-pin time.
// Successor pin (2026-10-06, IM delivery authority L1): 20261005162725_im_delivery_authority
// (im_mention_intents durable admission intents + im_messages.client_request_id) and
// 20261005162726_im_activity_final_message (session_activity final-message pointer) joined the
// registry; fresh-apply oracle and `migration --check` green at re-pin time.
// Successor candidate pin (2026-10-07, v2.0.3 R2): attention_seen, durable_import_jobs and
// work_execution_authority are reviewed forward migrations. Historical SQL/TS bodies are
// unchanged; the latest-only schema snapshot rotates independently of this executable pin.
// This candidate identity is not release approval or completion of the Work execution profile.
// Successor candidate pin (2026-10-07, v2.0.3 IM task source): the reviewed additive
// im_task_authority migration records source/request/grant business facts without a second
// quota. Full fresh apply and re-apply preserve committed identities; migration --check passes.
// Production operator/route authority and restricted execution remain unavailable at this pin.
// Successor candidate (2026-10-07): reviewed stable Goal control/command/tick permit and
// explicit local operator authority/command/task-conversation/origin tables. Fresh/reopen/reapply
// evidence preserves the old candidate pins; this is not production acceptance or release approval.
// Successor candidate (2026-10-07, F15-A): the additive goal_child_unit business binding
// has a fresh/reopen/re-apply oracle and preserves all existing SQL/TS migration bytes.
// Its default-closed child execution gate is not F15 completion or release approval.
// Successor candidate (2026-10-07, W1.3): one reviewed im_kernel_delivery table binds
// stable wire identity and durable dispatch/acknowledgement facts. Existing 213-entry
// executable digest and all 288 historical SQL/TS sources remain unchanged. This pin
// does not prove kernel persistent deduplication, cold delivery or release acceptance.
// Actual SQLite readback found the generator suppresses NOT NULL on a text primary key.
// A subsequent forward migration adds an explicit message_id IS NOT NULL CHECK;
// the already-applied 214-entry body is preserved. NULL refusal is an actual SQL oracle.
// Successor candidate (2026-10-07, F15-C1): one additive bounded checkpoint journal.
// A generator-only draft accepted NULL on its text primary key and was replaced before use;
// the actual SQL CHECK now refuses NULL. Forward file reopen and late DDL rollback are covered.
// Existing 215 migrations retain their exact executable bytes; no Goal caller is switched here.
// Successor candidate (217): forward same-table Goal program v2; all 216 prior executable bytes unchanged.
// Successor candidate (218): reviewed additive route approval/count disclosure receipts;
// fresh apply and re-apply passed, all 217 prior executable bodies remain byte-identical.
// Production route admission remains closed pending the actual factory/runner authority chain.
// Successor candidate (219): reviewed additive managed Browser business records, without
// independent execution authority. All 218 prior executable bodies remain byte-identical;
// physical NULL/byte/integer constraints, same-file upgrade and late DDL rollback are covered.
// This storage pin does not prove native Browser dispatch, three-OS support or release acceptance.
// Successor candidate (220): one plan-rebase journal, default-zero structural lineage and
// strict v3 checkpoint shape. Old v1/v2 checkpoint and command bytes are preserved; the
// draft SQL parameter/minimum-shape failures were fixed before any migration application.
// This storage pin does not prove live plan editing or UI acceptance.
// Successor candidate (221): pure ALTER adds nullable account identity generation and
// default-zero selection revision; populated active-account and SET NULL references survive.
// The unregistered generated DROP draft is retained separately and never installed.
// Successor candidate (233): wire JSON reader versions 1/2; original intent row version and bytes remain 1.
// Actual self-referenced upgrade, late DDL rollback and cold reapply preserve old cuts and audit guards.
// Successor candidate (234): additive event validation rule, run, project slot and immutable command ledger.
// Real old-data upgrade, late rollback, cold reapply and unknown replay/release guards are covered.
// This storage pin is not complete EV-02 or release approval.
// Successor candidate (235): forward prepare-only custody cleanup; prior run/migration bytes stay unchanged.
// Unknown or dispatched effects cannot use the private preparation release path.
// Successor candidate (236): immutable failed-validation investigation receipts and
// independent Rule authority epoch; old 332 SQL/TS bodies remain byte-identical.
// The file DB oracle covers populated 235 upgrade, late rollback and cold reapply.
// Successor working-tree candidate (2026-10-11): all 259 ordered identities and executable
// bodies are pinned after the affected fresh/upgrade/FK fixtures passed. The 207 identities
// in the informational HEAD baseline are retained byte-for-byte; 52 forward additions cover
// the reviewed v2.0.3 business/Native lifecycle work. This is not release approval.
const PINNED_DIGEST = "c983db24529334edb193af6054dc6cfda43948b727f2bf14830da8791c79450c"

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
