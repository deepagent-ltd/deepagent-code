import { describe, expect, test, beforeAll, beforeEach } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdtempSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { maybeRunRounds, multiRoundEnabled, type MultiRoundOps } from "../../src/session/deepagent-multiround"
import { runValidationCommands } from "../../src/deepagent/validation-exec"
import { Snapshot } from "../../src/snapshot"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { testEffect } from "../lib/effect"
import { testInstanceStoreLayer, TestInstance } from "../fixture/fixture"

const Orchestrator = AgentGateway.DeepAgentOrchestrator
const env = { os: "darwin", shell: "zsh", cwd: "/tmp", homedir: "/h", gitBranch: "m", gitRoot: "/tmp", isGitRepo: true, date: "d", platform: "darwin" }
const tools = { availableTools: [], mcpServers: [], totalToolCount: 0 }
const live = testEffect(Layer.mergeAll(Snapshot.defaultLayer, FSUtil.defaultLayer, testInstanceStoreLayer))

beforeAll(() => {
  AgentGateway.DeepAgentKnowledgeSource.configure(mkdtempSync(path.join(tmpdir(), "mr-mem-")))
})

// Pin the global gateway config (agentMode + an isolated runsDir/state dir) so diagnosis
// budgets/thresholds and the session-state store are deterministic regardless of which other
// deepagent test file ran configure() before this one. The gateway config — including the
// SessionState directory — is a process-global singleton; without re-pinning here, a prior file's
// configure({runsDir}) repoints the session store and changes this test's diagnosis rollback round.
const mrRunsDir = mkdtempSync(path.join(tmpdir(), "mr-runs-"))
beforeEach(() => {
  AgentGateway.configure({ agentMode: "max", runsDir: path.join(mrRunsDir, "runs") })
})

let sid = 0
// Unique per-process session ID prefix so IDs never collide with sessions persisted to the global
// SessionState store by a prior test file (collisions leak diagnosis history and change the
// diagnosis rollback round — the cause of the cross-file `all fail` flake).
const sidPrefix = `ses_mr_${process.pid}_${Date.now()}`
function setup() {
  const sessionID = `${sidPrefix}_${sid++}`
  Orchestrator.initSession({ sessionId: sessionID, mode: "max", environment: env as any, tools: tools as any, userRequest: "fix it", workspacePath: "/tmp" })
  return sessionID
}
const vr = (command: string, passed: boolean) => ({ command, passed, output: passed ? "ok" : "FAIL: npm test failed", duration_ms: 1 })

function ops(sessionID: string, over: Partial<MultiRoundOps<string>>): MultiRoundOps<string> {
  return {
    sessionID, agentMode: "max", enabled: true, maxRounds: 3, first: "turn-1",
    validationCommands: ["npm test"],
    ensureSession: () => Orchestrator.ensureSession(sessionID, "max"),
    runValidation: () => Effect.succeed([vr("npm test", true)]),
    track: () => Effect.succeed("cp"),
    restore: () => Effect.void,
    reviseTurn: () => Effect.succeed("revised"),
    ...over,
  }
}

describe("A6 multi-round loop (Effect)", () => {
  test("disabled -> returns first turn unchanged (no regression path)", async () => {
    const sessionID = setup()
    const out = await Effect.runPromise(maybeRunRounds(ops(sessionID, { enabled: false })))
    expect(out).toBe("turn-1")
  })

  test("general mode -> returns first turn unchanged", async () => {
    const sessionID = setup()
    const out = await Effect.runPromise(maybeRunRounds(ops(sessionID, { agentMode: "general" })))
    expect(out).toBe("turn-1")
  })

  test("high mode runs validation and diagnosis workflow", async () => {
    const sessionID = setup()
    let validationRounds = 0
    const out = await Effect.runPromise(maybeRunRounds(ops(sessionID, {
      agentMode: "high",
      runValidation: () => { validationRounds++; return Effect.succeed([vr("npm test", true)]) },
    })))
    expect(out).toBe("turn-1")
    expect(validationRounds).toBe(1)
  })

  test("env opt-out disables the mode-driven loop", () => {
    const previous = process.env.DEEPAGENT_MULTIROUND
    process.env.DEEPAGENT_MULTIROUND = "0"
    expect(multiRoundEnabled()).toBe(false)
    if (previous === undefined) delete process.env.DEEPAGENT_MULTIROUND
    else process.env.DEEPAGENT_MULTIROUND = previous
  })

  test("validation passes first round -> no revise", async () => {
    const sessionID = setup()
    let revises = 0
    const out = await Effect.runPromise(maybeRunRounds(ops(sessionID, {
      runValidation: () => Effect.succeed([vr("npm test", true)]),
      reviseTurn: () => { revises++; return Effect.succeed("revised") },
    })))
    expect(out).toBe("turn-1")
    expect(revises).toBe(0)
  })

  test("fail then pass -> revises once, rolls back before revise", async () => {
    const sessionID = setup()
    let round = 0, revises = 0, restores = 0
    const out = await Effect.runPromise(maybeRunRounds(ops(sessionID, {
      runValidation: () => { round++; return Effect.succeed([vr("npm test", round >= 2)]) },
      restore: () => { restores++; return Effect.void },
      reviseTurn: () => { revises++; return Effect.succeed("revised") },
    })))
    expect(revises).toBe(1)
    expect(restores).toBeGreaterThanOrEqual(1)
    expect(out).toBe("revised")
  })

  test("no-progress gate: identical failing rounds stop the loop before maxRounds", async () => {
    const sessionID = setup()
    let revises = 0
    // Always fails the same way with no diff change -> stagnant. Default K for non-ultra is 3,
    // so the loop should stop well before maxRounds=10 and not thrash indefinitely.
    await Effect.runPromise(maybeRunRounds(ops(sessionID, {
      maxRounds: 10,
      runValidation: () => Effect.succeed([vr("npm test", false)]),
      diffFingerprint: () => Effect.succeed("no-change"),
      reviseTurn: () => { revises++; return Effect.succeed("revised") },
    })))
    // K=3 consecutive identical rounds: rounds 1,2,3 build up the stagnant counter; the loop
    // stops at the gate rather than running all 10 rounds.
    expect(revises).toBeLessThanOrEqual(3)
  })

  test("no-progress gate: ultra is stricter (smaller K)", async () => {
    const sessionID = setup()
    let ultraRevises = 0
    await Effect.runPromise(maybeRunRounds(ops(sessionID, {
      agentMode: "ultra",
      maxRounds: 10,
      runValidation: () => Effect.succeed([vr("npm test", false)]),
      diffFingerprint: () => Effect.succeed("no-change"),
      reviseTurn: () => { ultraRevises++; return Effect.succeed("revised") },
    })))
    // ultra K=2 < non-ultra K=3.
    expect(ultraRevises).toBeLessThanOrEqual(2)
  })

  test("no-progress gate: progress (changing diff) does not trip the stagnation stop", async () => {
    const sessionID = setup()
    let round = 0, revises = 0
    // Each failing round has a DIFFERENT diff fingerprint (real progress), so the no-progress
    // gate must never fire — the loop continues until validation passes or another gate stops it.
    await Effect.runPromise(maybeRunRounds(ops(sessionID, {
      maxRounds: 5,
      runValidation: () => { round++; return Effect.succeed([vr("npm test", round >= 4)]) },
      diffFingerprint: () => Effect.succeed(`change-${round}`),
      reviseTurn: () => { revises++; return Effect.succeed("revised") },
    })))
    // With changing fingerprints the stagnation counter never accumulates; the loop revises more
    // than the ultra stagnation cap (2) would allow if the gate had fired on identical rounds.
    expect(revises).toBeGreaterThanOrEqual(2)
  })

  test("all fail -> revises until diagnosis rollback, then restores and stops", async () => {
    const sessionID = setup()
    let revises = 0, restores = 0
    await Effect.runPromise(maybeRunRounds(ops(sessionID, {
      maxRounds: 5,
      runValidation: () => Effect.succeed([vr("npm test", false)]),
      restore: () => { restores++; return Effect.void },
      reviseTurn: () => { revises++; return Effect.succeed("revised") },
    })))
    // determineAction: revise, revise, then rollback (>=2 same-root diagnoses) -> stops
    expect(revises).toBe(2)
    expect(restores).toBeGreaterThanOrEqual(1)
  })
})

describe("A3 real validation executor", () => {
  test("captures pass/fail from real shell commands", async () => {
    const results = await runValidationCommands(["true", "false"], "/tmp")
    expect(results[0]!.passed).toBe(true)
    expect(results[1]!.passed).toBe(false)
    expect(results.length).toBe(2)
  })
})

describe("A6 multi-round loop integration", () => {
  live.instance(
    "uses real validation commands and real git snapshot restore before revise",
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const snapshot = yield* Snapshot.Service
      const target = path.join(tmp.directory, "answer.txt")
      yield* Effect.promise(() => writeFile(target, "good\n", "utf8"))
      const sessionID = setup()
      let revises = 0
      let validationRounds = 0

      const out = yield* maybeRunRounds(
        ops(sessionID, {
          first: "first-bad-turn",
          validationCommands: [`test "$(cat answer.txt)" = good`],
          track: () => snapshot.track(),
          restore: (checkpoint) => snapshot.restore(checkpoint),
          runValidation: (commands) =>
            Effect.gen(function* () {
              validationRounds++
              if (validationRounds === 1) yield* Effect.promise(() => writeFile(target, "bad\n", "utf8"))
              return yield* Effect.promise(() => runValidationCommands(commands, tmp.directory))
            }),
          reviseTurn: () =>
            Effect.gen(function* () {
              revises++
              yield* Effect.promise(() => writeFile(target, "good\n", "utf8"))
              return "revised-good-turn"
            }),
        }),
      )

      expect(out).toBe("revised-good-turn")
      expect(revises).toBe(1)
      expect(validationRounds).toBe(2)
      expect(yield* Effect.promise(() => readFile(target, "utf8"))).toBe("good\n")
    }),
    { git: true },
  )
})

describe("A3 macro-round suggestion ({status,body}, objective)", () => {
  test("converged pass -> status done", async () => {
    const sessionID = setup()
    let emitted: { status: string; body: string } | undefined
    await Effect.runPromise(
      maybeRunRounds(
        ops(sessionID, {
          runValidation: () => Effect.succeed([vr("npm test", true)]),
          onMacroRound: (s) => Effect.sync(() => { emitted = s }),
        }),
      ),
    )
    expect(emitted?.status).toBe("done")
    expect(typeof emitted?.body).toBe("string")
  })

  test("model lies (claims pass) but runner fails -> status needs_human", async () => {
    const sessionID = setup()
    let emitted: { status: string; body: string } | undefined
    await Effect.runPromise(
      maybeRunRounds(
        ops(sessionID, {
          maxRounds: 1,
          runValidation: () => Effect.succeed([vr("npm test", false)]),
          // model claims validation passed; ground truth says it failed -> reconciliation mismatch
          declarationsFor: () => ({
            completion_claim: "complete",
            implementation_summary: "done",
            claimed_change_surface: [],
            claimed_doc_updates: [],
            claimed_validation_passed: true,
          }),
          onMacroRound: (s) => Effect.sync(() => { emitted = s }),
        }),
      ),
    )
    expect(emitted?.status).toBe("needs_human")
  })
})
