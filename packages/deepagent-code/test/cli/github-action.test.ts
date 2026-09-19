import { test, expect, describe } from "bun:test"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Git } from "@deepagent-code/core/git"
import { EventV2 } from "@deepagent-code/core/event"
import { ProjectV2 } from "@deepagent-code/core/project"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionStore } from "@deepagent-code/core/session/store"
import { SessionInputTable } from "@deepagent-code/core/session/sql"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { formatPromptTooLargeError } from "../../src/cli/cmd/github"
import { GitHubAgentExecution } from "@/github/github-agent-execution"
import { testEffect } from "../lib/effect"

// v2w-j4 durable-only GitHub ingress — the admission half (src/github/github-agent-execution.ts),
// mirroring test/im/im-agent-execution.test.ts. The durable execution record for a GitHub event
// delivery IS the `session_input` row: keyed by the deterministic prompt message id for
// (delivery, agent, turn), so a duplicate delivery of the same event reconciles as a SessionV2 exact
// retry (ONE row, never two) and a conflicting prompt under the same id fails typed. Session identity
// is stable per (lane, agent): follow-up events on the same issue/PR lane adopt the same session.

const root = mkdtempSync(`${os.tmpdir()}/github-agent-execution-`)
const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const projects = ProjectV2.layer.pipe(
  Layer.provide(database),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Git.defaultLayer),
)
// Noop execution: admission is durable; the advisory wake does not need a drain for these tests.
const v2Session = SessionV2.layer.pipe(
  Layer.provide(SessionExecution.noopLayer),
  Layer.provide(store),
  Layer.provide(projector),
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(projects),
  Layer.orDie,
)
const it = testEffect(Layer.mergeAll(database, events, projector, store, projects, v2Session))

const delivery = {
  laneID: "gh:acme/widgets#42",
  deliveryID: "comment:1234567890",
  turn: "work",
  agent: "auto",
  title: "GitHub acme/widgets#42",
  directory: root,
  prompt: new Prompt({ text: "/oc summarize" }),
}

const inputRowCount = (sessionID: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return (
      yield* db
        .select({ id: SessionInputTable.id })
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
    ).length
  })

describe("GitHubAgentExecution.admitTurn (durable admission)", () => {
  it.effect("a duplicate GitHub event delivery reconciles as an exact retry — exactly one session_input", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const first = yield* GitHubAgentExecution.admitTurn(session, delivery)
      const duplicate = yield* GitHubAgentExecution.admitTurn(session, delivery)

      // Same lane session, same admitted row — the second delivery is an exact-retry no-op.
      expect(duplicate.sessionID).toBe(first.sessionID)
      expect(duplicate.admitted.id).toBe(first.admitted.id)
      expect(duplicate.admitted.admittedSeq).toBe(first.admitted.admittedSeq)
      expect(yield* inputRowCount(first.sessionID)).toBe(1)
      expect(first.sessionID.startsWith("ses_gh_")).toBe(true)
    }),
  )

  it.effect("a conflicting prompt under the same delivery id fails typed instead of mutating the work", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      yield* GitHubAgentExecution.admitTurn(session, delivery)
      const conflict = yield* Effect.flip(
        GitHubAgentExecution.admitTurn(session, {
          ...delivery,
          prompt: new Prompt({ text: "/oc DIFFERENT context snapshot" }),
        }),
      )
      expect(conflict).toBeInstanceOf(SessionV2.PromptConflictError)
      expect(yield* inputRowCount(GitHubAgentExecution.githubSessionIDFor(delivery.laneID, delivery.agent))).toBe(1)
    }),
  )

  it.effect("a follow-up event on the same lane adopts the stable session; each turn is its own input", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const first = yield* GitHubAgentExecution.admitTurn(session, delivery)
      const followUp = yield* GitHubAgentExecution.admitTurn(session, {
        ...delivery,
        deliveryID: "comment:9876543210",
      })
      const summaryTurn = yield* GitHubAgentExecution.admitTurn(session, {
        ...delivery,
        turn: "title-summary",
      })

      // Same (lane, agent) conversation: one session, one durable input per (delivery, turn).
      expect(followUp.sessionID).toBe(first.sessionID)
      expect(summaryTurn.sessionID).toBe(first.sessionID)
      expect(yield* inputRowCount(first.sessionID)).toBe(3)

      // The session carries the GitHub binding.
      const info = yield* session.get(first.sessionID)
      expect(GitHubAgentExecution.githubSessionMetadata(info)).toEqual({
        laneID: delivery.laneID,
        agent: delivery.agent,
      })
    }),
  )

  it.effect("terminalReply reads the settled activity's newest assistant evidence", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { sessionID } = yield* GitHubAgentExecution.admitTurn(session, delivery)
      // No assistant message yet: nothing settled (admission-only under the noop execution layer).
      const before = yield* GitHubAgentExecution.terminalReply(session, sessionID)
      expect(before).toBeUndefined()
      // Sanity: the identity derivations are pure and stable.
      expect(GitHubAgentExecution.githubPromptIDFor(delivery.deliveryID, delivery.agent, "work")).toBe(
        GitHubAgentExecution.githubPromptIDFor(delivery.deliveryID, delivery.agent, "work"),
      )
      expect(GitHubAgentExecution.githubPromptIDFor(delivery.deliveryID, delivery.agent, "title-summary")).not.toBe(
        GitHubAgentExecution.githubPromptIDFor(delivery.deliveryID, delivery.agent, "work"),
      )
    }),
  )
})

describe("formatPromptTooLargeError", () => {
  test("formats error without files", () => {
    const result = formatPromptTooLargeError([])
    expect(result).toBe("PROMPT_TOO_LARGE: The prompt exceeds the model's context limit.")
  })

  test("formats error with files (base64 content)", () => {
    // Base64 is ~33% larger than original, so we multiply by 0.75 to get original size
    // 400 KB base64 = 300 KB original, 200 KB base64 = 150 KB original
    const files = [
      { filename: "screenshot.png", content: "a".repeat(400 * 1024) },
      { filename: "diagram.png", content: "b".repeat(200 * 1024) },
    ]
    const result = formatPromptTooLargeError(files)

    expect(result).toStartWith("PROMPT_TOO_LARGE: The prompt exceeds the model's context limit.")
    expect(result).toInclude("Files in prompt:")
    expect(result).toInclude("screenshot.png (300 KB)")
    expect(result).toInclude("diagram.png (150 KB)")
  })

  test("lists all files when multiple", () => {
    // Base64 sizes: 4KB -> 3KB, 8KB -> 6KB, 12KB -> 9KB
    const files = [
      { filename: "img1.png", content: "x".repeat(4 * 1024) },
      { filename: "img2.jpg", content: "y".repeat(8 * 1024) },
      { filename: "img3.gif", content: "z".repeat(12 * 1024) },
    ]
    const result = formatPromptTooLargeError(files)

    expect(result).toInclude("img1.png (3 KB)")
    expect(result).toInclude("img2.jpg (6 KB)")
    expect(result).toInclude("img3.gif (9 KB)")
  })
})
