/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent } from "@deepagent-code/sdk"
import { GoalClient } from "@deepagent-code/core/deepagent/goal-client"
import { tmpdir } from "../../../fixture/fixture"
import { mount, wait, json, directory } from "./sync-fixture"

const snapshot = (patch: Partial<GoalClient.Snapshot> = {}): GoalClient.Snapshot => ({
  goalId: "goal-a",
  planDocId: "plan-a",
  phase: "running",
  running: true,
  revision: 1,
  requestedPhase: "running",
  preparation: "ready",
  inFlight: false,
  recoveryRequired: false,
  wakeState: "published",
  replayed: false,
  ...patch,
})
function hint(goalId = "goal-a"): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: {
      id: crypto.randomUUID(),
      type: "goal.updated",
      properties: {
        sessionID: "session-a",
        goalId,
        planDocId: "plan-a",
        phase: "stopped",
        ledger: { ticks: 4, tokens: 100, cost: 0, wallclockMs: 20 },
        stallCount: 0,
        gaps: [],
      },
    },
  } as GlobalEvent
}

test("real TUI sync treats old terminal events as ledger hints and coalesces status reads", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const response = Promise.withResolvers<void>()
  let reads = 0
  const value = snapshot({ revision: 2, phase: "stopped", requestedPhase: "stopped", inFlight: true })
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname !== "/deepagent/goal/status") return
    reads++
    return response.promise.then(() => json({ goal: value }))
  }, tmp.path)
  try {
    emit(hint())
    await wait(() => reads === 1)
    expect(sync.data.session_goal["session-a"].phase).toBe("unknown")
    expect(sync.data.session_goal["session-a"].control).toBeUndefined()
    for (let i = 0; i < 30; i++) emit(hint())
    await Bun.sleep(30)
    expect(reads).toBe(1)
    response.resolve()
    await wait(() => reads === 2 && sync.data.session_goal["session-a"].control?.revision === 2)
    expect(sync.data.session_goal["session-a"].tokens).toBe(100)
    expect(GoalClient.confirmedTerminal(sync.data.session_goal["session-a"].control!)).toBe(false)
    expect(GoalClient.canControl(sync.data.session_goal["session-a"].control, "resume")).toBe(false)
    // This used to delete any Goal at the same session key after eight seconds, even a successor.
    sync.goal.set("session-a", snapshot({ goalId: "successor", revision: 1 }))
    await Bun.sleep(8100)
    expect(sync.data.session_goal["session-a"].goalId).toBe("successor")
  } finally {
    app.renderer.destroy()
  }
}, 15000)

test("pending TUI GET cannot overwrite a newer control write or different Goal", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const response = Promise.withResolvers<void>()
  let reads = 0
  const { app, sync } = await mount((url) => {
    if (url.pathname !== "/deepagent/goal/status") return
    reads++
    return response.promise.then(() =>
      json({ goal: snapshot({ revision: 2, phase: "paused", requestedPhase: "paused" }) }),
    )
  }, tmp.path)
  try {
    sync.goal.set("session-a", snapshot())
    const pending = sync.goal.sync("session-a")
    await wait(() => reads === 1)
    sync.goal.set("session-a", snapshot({ revision: 5 }))
    response.resolve()
    await pending
    expect(sync.data.session_goal["session-a"].control?.revision).toBe(5)
    sync.goal.set("session-a", snapshot({ goalId: "successor", revision: 1 }))
    sync.goal.set("session-a", snapshot({ goalId: "successor", revision: 0 }))
    expect(sync.data.session_goal["session-a"].control?.revision).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})
