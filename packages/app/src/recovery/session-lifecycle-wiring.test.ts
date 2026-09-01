import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

// C6-11 route-contract check (repo pattern: source-level wiring assertions): the session page
// mounts the pump provider, and the pump module exposes the real-event mapping + subscription.
// The state matrix itself is fixture-tested in ux-matrix-invariants.test.ts.

const here = import.meta.dir

describe("C6-11 session lifecycle wiring", () => {
  test("the session page mounts SessionLifecycle around the session surface", async () => {
    const page = await readFile(path.join(here, "../pages/session.tsx"), "utf8")

    expect(page).toContain('import { SessionLifecycle } from "@/recovery/session-lifecycle"')
    expect(page).toContain("<SessionLifecycle>")
    expect(page).toContain("</SessionLifecycle>")
    // The pump wraps the session surface that renders the composer/recovery dock.
    const open = page.indexOf("<SessionLifecycle>")
    const composer = page.indexOf('{composerRegion("dock")}')
    const close = page.indexOf("</SessionLifecycle>")
    expect(open).toBeGreaterThanOrEqual(0)
    expect(composer).toBeGreaterThan(open)
    expect(close).toBeGreaterThan(composer)
  })

  test("the pump module maps SessionEvent.Execution.* and exposes the live subscription", async () => {
    const pump = await readFile(path.join(here, "lifecycle-execution-pump.ts"), "utf8")

    for (const type of ["session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]) {
      expect(pump).toContain(`"${type}"`)
    }
    expect(pump).toContain("toLifecycleEvent")
    expect(pump).toContain("subscribeExecutionEvents")
  })

  test("the lifecycle reducer accepts the execution event vocabulary", async () => {
    const reducer = await readFile(path.join(here, "recovery-lifecycle-state.ts"), "utf8")

    for (const event of ["execution-started", "execution-succeeded", "execution-failed", "execution-interrupted"]) {
      expect(reducer).toContain(`type: "${event}"`)
    }
    expect(reducer).toContain("lastExecution")
  })
})
