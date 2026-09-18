import { describe, expect, test } from "bun:test"
import Ajv from "ajv"
import { Effect } from "effect"
import {
  MAX_SUBAGENT_CONCURRENCY,
  MAX_SUBAGENT_FANOUT,
  admitTaskCall,
  canRunInSharedWorkspace,
  inheritedTaskPermissions,
  resolveOutputSchema,
  taskLaunchRestriction,
  withTaskConcurrency,
} from "../src/tool/task-policy"

describe("Core V2 task policy", () => {
  test("resolves named and automatic orchestration schemas", () => {
    const review = resolveOutputSchema("ReviewResult", "reviewer")
    const automatic = resolveOutputSchema(undefined, "reviewer")
    const research = resolveOutputSchema(undefined, "researcher")

    expect(automatic).toEqual(review)
    expect(JSON.stringify(review)).toContain("findings")
    expect(JSON.stringify(review)).toContain("verdict")
    expect(JSON.stringify(research)).toContain("keyFiles")
    expect(resolveOutputSchema("missing", "reviewer")).toBeUndefined()
    expect(resolveOutputSchema(undefined, "explore")).toBeUndefined()
  })

  test("compiles and validates the named review contract with Ajv", () => {
    const schema = resolveOutputSchema("ReviewResult", "reviewer")
    expect(schema).toBeDefined()
    const validate = new Ajv({ allErrors: true, strict: false }).compile(schema!)
    expect(
      validate({
        findings: [
          {
            severity: "high",
            category: "correctness",
            file: "src/example.ts",
            line: 12,
            summary: "Incorrect result",
            failureScenario: "Given x, returns y instead of z",
            confidence: 0.9,
          },
        ],
        verdict: "revise",
      }),
    ).toBeTrue()
    expect(validate({ findings: [], verdict: "unknown" })).toBeFalse()
  })

  test("inherits only parent restrictions and makes approvals fail closed", () => {
    expect(
      inheritedTaskPermissions(
        [
          { action: "*", resource: "*", effect: "allow" },
          { action: "edit", resource: "*", effect: "deny" },
        ],
        [{ action: "read", resource: "*.env", effect: "ask" }],
      ),
    ).toEqual([
      { action: "edit", resource: "*", effect: "deny" },
      { action: "read", resource: "*.env", effect: "deny" },
    ])
  })

  test("permits read-only children and rejects shared-workspace writers", () => {
    expect(
      canRunInSharedWorkspace([
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "grep", resource: "*", effect: "allow" },
      ]),
    ).toBeTrue()
    expect(canRunInSharedWorkspace([{ action: "*", resource: "*", effect: "allow" }])).toBeFalse()
    expect(
      canRunInSharedWorkspace([
        { action: "*", resource: "*", effect: "deny" },
        { action: "custom_write", resource: "*", effect: "allow" },
      ]),
    ).toBeFalse()
  })

  test("rejects hidden and primary agents before launch", () => {
    expect(taskLaunchRestriction({ hidden: true, mode: "subagent", permissions: [] })).toBe("hidden")
    expect(taskLaunchRestriction({ hidden: false, mode: "primary", permissions: [] })).toBe("primary")
    expect(
      taskLaunchRestriction({
        hidden: false,
        mode: "subagent",
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      }),
    ).toBeUndefined()
  })

  test("enforces per-message fan-out while admitting exact retries", () => {
    const sessionID = `session-${crypto.randomUUID()}`
    const messageID = `message-${crypto.randomUUID()}`
    for (let index = 0; index < MAX_SUBAGENT_FANOUT; index++)
      expect(admitTaskCall(sessionID, messageID, `call-${index}`)).toBeTrue()
    expect(admitTaskCall(sessionID, messageID, "call-0")).toBeTrue()
    expect(admitTaskCall(sessionID, messageID, "overflow")).toBeFalse()
  })

  test("limits concurrent child drains per parent session", async () => {
    let active = 0
    let peak = 0
    const work = Effect.acquireUseRelease(
      Effect.sync(() => {
        active++
        peak = Math.max(peak, active)
      }),
      () => Effect.sleep("10 millis"),
      () =>
        Effect.sync(() => {
          active--
        }),
    )
    await Effect.runPromise(
      Effect.all(
        Array.from({ length: MAX_SUBAGENT_CONCURRENCY * 3 }, () => withTaskConcurrency("concurrency-test", work)),
        { concurrency: "unbounded" },
      ),
    )
    expect(peak).toBe(MAX_SUBAGENT_CONCURRENCY)
  })
})
