import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { MultiRoundOps } from "../../src/session/deepagent-multiround"
import { maybeRunRounds } from "../../src/session/deepagent-multiround"

// docs/34 §9 S9 (DAP-13): ultra must not silently continue when the active domain pack set
// changes between macro-rounds. The gate forces needs_human on pack-set shift so a human reviews
// risk/scope elevation before autonomy resumes. The invariant under test is:
//   - pack-change gate message ONLY appears when agentMode===ultra AND snapshots differ
//   - same snapshots → no pack-change message, regardless of other gate decisions
//   - high mode with different snapshots → no pack-change message (high already requires human)

const makeOps = (over: Partial<MultiRoundOps<number>> = {}): MultiRoundOps<number> => ({
  sessionID: `test-s9-${Math.random()}`,
  agentMode: "ultra",
  enabled: true,
  maxRounds: 1,
  first: 1,
  validationCommands: [],
  ensureSession: () => {},
  runValidation: () => Effect.succeed([]),
  track: () => Effect.succeed("ckpt-1"),
  restore: () => Effect.succeed(undefined),
  reviseTurn: () => Effect.succeed(1),
  ...over,
})

describe("S9 ultra pack-change gate (DAP-13)", () => {
  test("no pack fields — gate is absent, loop runs without pack-change message", async () => {
    let body: string | undefined
    const ops = makeOps({
      onMacroRound: (s) =>
        Effect.sync(() => {
          body = s.body
        }),
    })
    await Effect.runPromise(maybeRunRounds(ops))
    expect(body ?? "").not.toContain("pack set changed")
  })

  test("same snapshot id — pack-change gate does NOT add its message", async () => {
    let body: string | undefined
    const ops = makeOps({
      baselinePackSnapshotId: "pack_snapshot:abc123",
      packSnapshotId: "pack_snapshot:abc123",
      onMacroRound: (s) =>
        Effect.sync(() => {
          body = s.body
        }),
    })
    await Effect.runPromise(maybeRunRounds(ops))
    // Same snapshots: pack-change gate must not be the reason for any status escalation.
    expect(body ?? "").not.toContain("pack set changed")
  })

  test("ultra + different snapshot ids — gate forces needs_human with pack-change message (DAP-13)", async () => {
    let suggestion: { status: string; body: string } | undefined
    const ops = makeOps({
      agentMode: "ultra",
      baselinePackSnapshotId: "pack_snapshot:abc",
      packSnapshotId: "pack_snapshot:xyz", // changed — risk/scope shifted
      onMacroRound: (s) =>
        Effect.sync(() => {
          suggestion = s
        }),
    })
    await Effect.runPromise(maybeRunRounds(ops))
    expect(suggestion?.status).toBe("needs_human")
    expect(suggestion?.body).toContain("pack set changed")
    expect(suggestion?.body).toContain("pack_snapshot:abc")
    expect(suggestion?.body).toContain("pack_snapshot:xyz")
  })

  test("high mode + different snapshots — pack-change gate does NOT fire (only ultra)", async () => {
    let body: string | undefined
    const ops = makeOps({
      agentMode: "high",
      baselinePackSnapshotId: "pack_snapshot:abc",
      packSnapshotId: "pack_snapshot:xyz",
      onMacroRound: (s) =>
        Effect.sync(() => {
          body = s.body
        }),
    })
    await Effect.runPromise(maybeRunRounds(ops))
    // The pack-change gate is ultra-only; high must not inject its message.
    expect(body ?? "").not.toContain("pack set changed")
  })
})
