import { describe, expect } from "bun:test"
import { and, eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { EventTable, EventSequenceTable } from "@deepagent-code/core/event/sql"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { Project } from "@deepagent-code/core/project"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { V2ProviderTurnReceiptTable } from "@deepagent-code/core/session/runner/v2-provider-turn.sql"
import { V2ToolEffectTable, V2ToolEffectAdmissionTable } from "@deepagent-code/core/session/runner/v2-tool-effect.sql"
import { SessionProviderOwnerLeaseTable } from "@deepagent-code/core/context-federation/session-sql"
import { activityTouchedPaths, harvestActivityValidation } from "@/deepagent/learning-runtime"
import { finalizeSessionWork } from "@/deepagent/session-finalizer"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { durableType } from "@deepagent-code/core/event/define"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { execSync } from "node:child_process"
import path from "node:path"
import { testEffect } from "../lib/effect"
import { tmpRoot, tmpRootShared } from "../fixture/fixture"

// Seeds must write the type the DURABLE log actually stores (version-suffixed). Hardcoding the bare
// definition name here is what let these tests stay green while production's harvest matched zero
// rows; resolving from the definition keeps the fixture honest if the version ever moves.
const TOOL_CALLED_TYPE = durableType(SessionEvent.Tool.Called)
const TOOL_SUCCESS_TYPE = durableType(SessionEvent.Tool.Success)

// Review round 3: integration test over the REAL table shapes the V2 runner writes —
// receipt (activity binding) → tool_effect (settled call) → tool.success events (structured
// resource paths). No sequence arithmetic anywhere; multi-activity isolation is asserted by
// seeding two activities in one session.

const database = Database.layerFromPath(":memory:")
const it = testEffect(database)

const root = "/tmp/activity-attribution-test"
const sessionID = SessionSchema.ID.make("ses_attribution_it")

const seedBase = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(EventSequenceTable)
    .values({ aggregate_id: sessionID, seq: 0 })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make(root), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: sessionID,
      directory: root,
      title: "attribution",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

// Real lifecycle: the INSERT guard requires a LIVE owner lease and state 'preparing'; the
// transition guard then allows preparing → settled.
const insertReceipt = Effect.fn("test.insertReceipt")(function* (
  db: Database.Interface["db"],
  receiptId: string,
  activityId: string,
  ordinal: number,
) {
  // The lease guard requires registered_at to equal the DATABASE clock — the only reliable way
  // is to let SQLite compute it inside the INSERT itself (same pattern as core's
  // session-wire-egress test). The receipt's created_at reuses the same expression; its lease
  // liveness check compares against julianday('now') at insert time, so computing both clocks
  // in ONE statement keeps them consistent.
  const databaseNow = sql`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`
  yield* db
    .insert(SessionProviderOwnerLeaseTable)
    .values({
      owner_token: `owner_${receiptId}`,
      registered_at: databaseNow,
      heartbeat_at: databaseNow,
      lease_expires_at: sql`${databaseNow} + 600000`,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(V2ProviderTurnReceiptTable)
    .values({
      receipt_id: receiptId,
      session_id: sessionID,
      request_ordinal: ordinal,
      activity_id: activityId,
      provider_turn_seq: ordinal,
      user_message_id: `msg_${ordinal}`,
      history_prompt_epoch: 0,
      request_input_hash: "h".repeat(64),
      provider_id: "p",
      model_id: "m",
      protocol: "openai-compatible.chat",
      owner_mode: "v2",
      owner_token: `owner_${receiptId}`,
      state: "preparing",
      created_at: databaseNow,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .update(V2ProviderTurnReceiptTable)
    .set({ state: "failed", error_code: "provider_stream_failed", terminal_at: sql`${databaseNow} + 1` })
    .where(eq(V2ProviderTurnReceiptTable.receipt_id, receiptId))
    .run()
    .pipe(Effect.orDie)
  // preparing → failed is the one legal shortcut that terminalizes a receipt without the full
  // dispatch dance (hash-consistent prepared_turn etc.); attribution only reads receipt_id and
  // activity_id, so a terminal failed receipt exercises the same join the runner produces.
})

const insertEffect = Effect.fn("test.insertEffect")(function* (
  db: Database.Interface["db"],
  effectId: string,
  receiptId: string,
  callId: string,
  toolName: string,
  state: "settled" | "failed",
) {
  // Real order: the admission row precedes the terminal effect row (the runner admits before
  // settlement); the insert guard cross-checks admission vs effect identity.
  yield* db
    .insert(V2ToolEffectAdmissionTable)
    .values({
      admission_id: `admission_${effectId}`,
      session_id: sessionID,
      provider_attempt_id: `attempt_${effectId}`,
      receipt_id: receiptId,
      tool_call_id: callId,
      tool_name: toolName,
      effect_kind: "mutating",
      owner_token: `owner_${receiptId}`,
      time_created: 1_999,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(V2ToolEffectTable)
    .values({
      effect_id: effectId,
      session_id: sessionID,
      provider_attempt_id: `attempt_${effectId}`,
      receipt_id: receiptId,
      tool_call_id: callId,
      tool_name: toolName,
      effect_kind: "mutating",
      state,
      // Trigger contract: a failed effect REQUIRES error_code, a settled one must not have it.
      ...(state === "failed" ? { error_code: "provider_failure" } : {}),
      outcome_hash: "a1b2c3d4".repeat(8),
      owner_token: `owner_${receiptId}`,
      time_created: 2_000,
    })
    .run()
    .pipe(Effect.orDie)
})

let eventSeqCounter = 0
const insertToolSuccess = Effect.fn("test.insertToolSuccess")(function* (
  db: Database.Interface["db"],
  callId: string,
  structured: unknown,
) {
  yield* db
    .insert(EventSequenceTable)
    .values({ aggregate_id: sessionID, seq: 0 })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(EventTable)
    .values({
      id: `evt_${callId}` as never,
      aggregate_id: sessionID,
      seq: Math.floor(Math.random() * 1_000_000),
      sync_seq: ++eventSeqCounter,
      type: TOOL_SUCCESS_TYPE,
      data: {
        sessionID,
        assistantMessageID: `msg_${callId}`,
        callID: callId,
        structured,
        content: [],
      },
    })
    .run()
    .pipe(Effect.orDie)
})

describe("activityTouchedPaths (real tables)", () => {
  it.effect("attributes only THIS activity's settled mutating calls", () =>
    Effect.gen(function* () {
      yield* seedBase
      const { db } = yield* Database.Service
      yield* db
        .insert(EventSequenceTable)
        .values({ aggregate_id: sessionID, seq: 0 })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      // Activity A (old): writes shared.go. Activity B (new): writes feature.go via write and
      // a chunked patch commit; shared.go's author is A alone. A FAILED edit in B attributes
      // nothing (failed calls changed nothing durable).
      yield* insertReceipt(db, "rcpt_A", "act_A", 1)
      yield* insertReceipt(db, "rcpt_B1", "act_B", 2)
      yield* insertReceipt(db, "rcpt_B2", "act_B", 3)
      yield* insertEffect(db, "fx_A1", "rcpt_A", "call_A1", "write", "settled")
      yield* insertEffect(db, "fx_B1", "rcpt_B1", "call_B1", "write", "settled")
      yield* insertEffect(db, "fx_B2", "rcpt_B2", "call_B2", "apply_patch_chunk", "settled")
      yield* insertEffect(db, "fx_B3", "rcpt_B2", "call_B3", "edit", "failed")
      yield* insertToolSuccess(db, "call_A1", {
        operation: "write",
        target: "shared.go",
        resource: "shared.go",
        existed: true,
      })
      yield* insertToolSuccess(db, "call_B1", {
        operation: "write",
        target: "feature.go",
        resource: "feature.go",
        existed: false,
      })
      yield* insertToolSuccess(db, "call_B2", {
        applied: [{ type: "update", resource: "pkg/generated.go", target: `${root}/pkg/generated.go` }],
      })

      const touched = [...activityTouchedPaths({ db } as never, sessionID, "act_B")].sort()
      expect(touched).toEqual(["feature.go", "pkg/generated.go"])
      // Activity A sees only its own file.
      expect(activityTouchedPaths({ db } as never, sessionID, "act_A")).toEqual(["shared.go"])
    }),
  )

  it.effect("unknown activity yields nothing (never guesses)", () =>
    Effect.gen(function* () {
      yield* seedBase
      const { db } = yield* Database.Service
      yield* db
        .insert(EventSequenceTable)
        .values({ aggregate_id: sessionID, seq: 0 })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* insertReceipt(db, "rcpt_A", "act_A", 1)
      yield* insertEffect(db, "fx_A1", "rcpt_A", "call_A1", "write", "settled")
      yield* insertToolSuccess(db, "call_A1", { resource: "x.go" })
      expect(activityTouchedPaths({ db } as never, sessionID, "act_missing")).toEqual([])
    }),
  )

  it.effect("archive outputPaths on a mutating call surface as an anomaly, never as touched paths", () =>
    // Review round 4: outputPaths is produced by the tool-output OVERFLOW store — the paths
    // point into the .deepagent data dir, not the workspace. A mutating call whose success
    // carries ONLY archive outputPaths must contribute NOTHING to the touched set (committing
    // archive files would pollute the tree); the extractor flags it as an observation instead.
    Effect.gen(function* () {
      yield* seedBase
      const { db } = yield* Database.Service
      yield* db
        .insert(EventSequenceTable)
        .values({ aggregate_id: sessionID, seq: 0 })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* insertReceipt(db, "rcpt_C", "act_C", 7)
      yield* insertEffect(db, "fx_C1", "rcpt_C", "call_C1", "write", "settled")
      yield* db
        .insert(EventSequenceTable)
        .values({ aggregate_id: sessionID, seq: 0 })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(EventTable)
        .values({
          id: "evt_archive" as never,
          aggregate_id: sessionID,
          seq: 9_000_001,
          sync_seq: ++eventSeqCounter,
          type: TOOL_SUCCESS_TYPE,
          data: {
            sessionID,
            assistantMessageID: "msg_call_C1",
            callID: "call_C1",
            structured: { ok: true },
            content: [],
            outputPaths: ["/root/.deepagent/tool_overflow_abc.txt"],
          },
        })
        .run()
        .pipe(Effect.orDie)
      expect(activityTouchedPaths({ db } as never, sessionID, "act_C")).toEqual([])
    }),
  )
})

// Review round 5: the V2 validation harvester + three-state finalizer contract, over the same
// real guard chain. A workspace fixture with package.json {scripts:{test}} makes
// "bun run test" inferable; a bash tool.called + tool.success pair with structured exitCode
// exercises the harvest; SessionState carries the activity binding the finalizer checks.
describe("harvestActivityValidation + three-state verdict", () => {
  const wsRoot = mkdtempSync(tmpRootShared())
  const writeWorkspace = () => {
    writeFileSync(path.join(wsRoot, "package.json"), JSON.stringify({ scripts: { test: "echo ok" } }))
  }

  it.effect("harvests THIS activity's bash validation and binds the activity", () =>
    Effect.gen(function* () {
      writeWorkspace()
      const { db } = yield* Database.Service
      yield* seedBase
      yield* insertReceipt(db, "rcpt_V", "act_V", 1)
      yield* insertEffect(db, "fx_V1", "rcpt_V", "call_V1", "bash", "settled")
      // tool.called carries the command; tool.success carries structured exitCode 0.
      yield* db
        .insert(EventTable)
        .values({
          id: "evt_v_called" as never,
          aggregate_id: sessionID,
          seq: 8_000_001,
          sync_seq: ++eventSeqCounter,
          type: TOOL_CALLED_TYPE,
          data: {
            sessionID,
            assistantMessageID: "msg_v",
            callID: "call_V1",
            tool: "bash",
            input: { command: "bun run test" },
            provider: { executed: false },
          },
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(EventTable)
        .values({
          id: "evt_v_success" as never,
          aggregate_id: sessionID,
          seq: 8_000_002,
          sync_seq: ++eventSeqCounter,
          type: TOOL_SUCCESS_TYPE,
          data: {
            sessionID,
            assistantMessageID: "msg_v",
            callID: "call_V1",
            structured: { command: "bun run test", exitCode: 0, output: "ok", truncated: false },
            content: [],
          },
        })
        .run()
        .pipe(Effect.orDie)
      // manual replication of harvester steps
      harvestActivityValidation({ db } as never, sessionID, "act_V", wsRoot)
      const state = AgentGateway.DeepAgentSessionState.get(sessionID)
      expect(state?.lastValidationResults.length).toBe(1)
      expect(state?.lastValidationResults[0]?.passed).toBe(true)
      expect(state?.lastValidationActivityId).toBe("act_V")
    }),
  )

  it.effect("rejects a command that mutates after validation", () =>
    Effect.gen(function* () {
      writeWorkspace()
      const { db } = yield* Database.Service
      yield* seedBase
      yield* insertReceipt(db, "rcpt_TRAILING_MUTATION", "act_TRAILING_MUTATION", 61)
      yield* insertEffect(
        db,
        "fx_TRAILING_MUTATION",
        "rcpt_TRAILING_MUTATION",
        "call_TRAILING_MUTATION",
        "bash",
        "settled",
      )
      const command = "bun run test && printf mutated > feature.ts"
      yield* db
        .insert(EventTable)
        .values([
          {
            id: "evt_trailing_mutation_called" as never,
            aggregate_id: sessionID,
            seq: 8_010_001,
            sync_seq: ++eventSeqCounter,
            type: TOOL_CALLED_TYPE,
            data: {
              sessionID,
              assistantMessageID: "msg_trailing_mutation",
              callID: "call_TRAILING_MUTATION",
              tool: "bash",
              input: { command },
              provider: { executed: false },
            },
          },
          {
            id: "evt_trailing_mutation_success" as never,
            aggregate_id: sessionID,
            seq: 8_010_002,
            sync_seq: ++eventSeqCounter,
            type: TOOL_SUCCESS_TYPE,
            data: {
              sessionID,
              assistantMessageID: "msg_trailing_mutation",
              callID: "call_TRAILING_MUTATION",
              structured: { command, exitCode: 0, output: "ok", truncated: false },
              content: [],
            },
          },
        ])
        .run()
        .pipe(Effect.orDie)

      expect(
        harvestActivityValidation({ db } as never, sessionID, "act_TRAILING_MUTATION", wsRoot),
      ).toEqual([])
    }),
  )

  it.effect("harvests go test evidence for a Go workspace", () =>
    Effect.gen(function* () {
      const goRoot = mkdtempSync(tmpRootShared())
      writeFileSync(path.join(goRoot, "go.mod"), "module example.test/project\n\ngo 1.24\n")
      const { db } = yield* Database.Service
      yield* seedBase
      yield* insertReceipt(db, "rcpt_GO", "act_GO", 1)
      yield* insertEffect(db, "fx_GO1", "rcpt_GO", "call_GO1", "bash", "settled")
      yield* db
        .insert(EventTable)
        .values({
          id: "evt_go_called" as never,
          aggregate_id: sessionID,
          seq: 8_050_001,
          sync_seq: ++eventSeqCounter,
          type: TOOL_CALLED_TYPE,
          data: {
            sessionID,
            assistantMessageID: "msg_go",
            callID: "call_GO1",
            tool: "bash",
            input: { command: "go test ./..." },
            provider: { executed: false },
          },
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(EventTable)
        .values({
          id: "evt_go_success" as never,
          aggregate_id: sessionID,
          seq: 8_050_002,
          sync_seq: ++eventSeqCounter,
          type: TOOL_SUCCESS_TYPE,
          data: {
            sessionID,
            assistantMessageID: "msg_go",
            callID: "call_GO1",
            structured: { command: "go test ./...", exitCode: 0, output: "ok", truncated: false },
            content: [],
          },
        })
        .run()
        .pipe(Effect.orDie)

      harvestActivityValidation({ db } as never, sessionID, "act_GO", goRoot)
      const state = AgentGateway.DeepAgentSessionState.get(sessionID)
      expect(state?.lastValidationResults[0]?.command).toBe("go test ./...")
      expect(state?.lastValidationResults[0]?.passed).toBe(true)
      expect(state?.lastValidationActivityId).toBe("act_GO")
    }),
  )

  it.effect("does not treat a Go subpackage test as whole-module validation", () =>
    Effect.gen(function* () {
      const goRoot = mkdtempSync(tmpRootShared())
      writeFileSync(path.join(goRoot, "go.mod"), "module example.test/project\n\ngo 1.24\n")
      const { db } = yield* Database.Service
      yield* seedBase
      yield* insertReceipt(db, "rcpt_GOSUB", "act_GOSUB", 1)
      yield* insertEffect(db, "fx_GOSUB1", "rcpt_GOSUB", "call_GOSUB1", "bash", "settled")
      yield* db
        .insert(EventTable)
        .values({
          id: "evt_go_sub_called" as never,
          aggregate_id: sessionID,
          seq: 8_060_001,
          sync_seq: ++eventSeqCounter,
          type: TOOL_CALLED_TYPE,
          data: {
            sessionID,
            assistantMessageID: "msg_go_sub",
            callID: "call_GOSUB1",
            tool: "bash",
            input: { command: "go test ./pkg/..." },
            provider: { executed: false },
          },
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(EventTable)
        .values({
          id: "evt_go_sub_success" as never,
          aggregate_id: sessionID,
          seq: 8_060_002,
          sync_seq: ++eventSeqCounter,
          type: TOOL_SUCCESS_TYPE,
          data: {
            sessionID,
            assistantMessageID: "msg_go_sub",
            callID: "call_GOSUB1",
            structured: { command: "go test ./pkg/...", exitCode: 0, output: "ok", truncated: false },
            content: [],
          },
        })
        .run()
        .pipe(Effect.orDie)

      expect(harvestActivityValidation({ db } as never, sessionID, "act_GOSUB", goRoot)).toEqual([])
    }),
  )

  it.effect("activity mismatch NEVER authorizes: verdict collapses to unverified, no commit", () =>
    Effect.gen(function* () {
      writeWorkspace()
      const { db } = yield* Database.Service
      // Activity OLD ran validation and passed (bound to act_OLD).
      yield* seedBase
      yield* insertReceipt(db, "rcpt_OLD", "act_OLD", 1)
      yield* insertEffect(db, "fx_O1", "rcpt_OLD", "call_O1", "bash", "settled")
      yield* db
        .insert(EventTable)
        .values({
          id: "evt_o_called" as never,
          aggregate_id: sessionID,
          seq: 8_100_001,
          sync_seq: ++eventSeqCounter,
          type: TOOL_CALLED_TYPE,
          data: {
            sessionID,
            assistantMessageID: "msg_o",
            callID: "call_O1",
            tool: "bash",
            input: { command: "bun run test" },
            provider: { executed: false },
          },
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(EventTable)
        .values({
          id: "evt_o_success" as never,
          aggregate_id: sessionID,
          seq: 8_100_002,
          sync_seq: ++eventSeqCounter,
          type: TOOL_SUCCESS_TYPE,
          data: {
            sessionID,
            assistantMessageID: "msg_o",
            callID: "call_O1",
            structured: { command: "bun run test", exitCode: 0, output: "ok", truncated: false },
            content: [],
          },
        })
        .run()
        .pipe(Effect.orDie)
      harvestActivityValidation({ db } as never, sessionID, "act_OLD", wsRoot)
      expect(AgentGateway.DeepAgentSessionState.get(sessionID)?.lastValidationActivityId).toBe("act_OLD")
      // The NEW activity settles: it produced a file edit but NO validation of its own.
      yield* insertReceipt(db, "rcpt_NEW", "act_NEW", 2)
      yield* insertEffect(db, "fx_N1", "rcpt_NEW", "call_N1", "write", "settled")
      yield* db
        .insert(EventTable)
        .values({
          id: "evt_n_success" as never,
          aggregate_id: sessionID,
          seq: 8_100_003,
          sync_seq: ++eventSeqCounter,
          type: TOOL_SUCCESS_TYPE,
          data: {
            sessionID,
            assistantMessageID: "msg_n",
            callID: "call_N1",
            structured: { operation: "write", target: "feature.go", resource: "feature.go", existed: false },
            content: [],
          },
        })
        .run()
        .pipe(Effect.orDie)
      // Harvest for the NEW activity finds no validation of its own — the OLD pass must NOT
      // carry over (lastValidationActivityId stays bound to act_OLD ≠ act_NEW).
      harvestActivityValidation({ db } as never, sessionID, "act_NEW", wsRoot)
      const state = AgentGateway.DeepAgentSessionState.get(sessionID)
      const verdict =
        !state || state.lastValidationResults.length === 0
          ? "unverified"
          : state.lastValidationActivityId !== "act_NEW"
            ? "unverified"
            : state.lastValidationResults.every((r) => r.passed)
              ? "validated"
              : "validation_failed"
      expect(verdict).toBe("unverified")
      // And the finalizer with that verdict produces NO commit on a real repo.
      const repo = mkdtempSync(tmpRootShared())
      execSync("git init -q -b main", { cwd: repo })
      execSync("git -c user.name=t -c user.email=t@t commit --no-gpg-sign --allow-empty -m base -q", { cwd: repo })
      writeFileSync(path.join(repo, "feature.go"), "package x")
      const outcome = yield* Effect.promise(() =>
        finalizeSessionWork({
          directory: repo,
          validation: "unverified",
          touchedPaths: activityTouchedPaths({ db } as never, sessionID, "act_NEW"),
        }),
      )
      expect(outcome.kind).toBe("unverified")
      expect(execSync("git log --oneline", { cwd: repo, stdio: "pipe" }).toString().trim().split("\n")).toHaveLength(1)
      expect(execSync("git status --porcelain", { cwd: repo, stdio: "pipe" }).toString().trim()).not.toBe("")
    }),
  )
})
