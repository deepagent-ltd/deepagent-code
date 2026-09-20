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

  test("the pump module maps SessionEvent.Execution.* and exposes the journal subscription", async () => {
    const pump = await readFile(path.join(here, "lifecycle-execution-pump.ts"), "utf8")

    for (const type of ["session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]) {
      expect(pump).toContain(`"${type}"`)
    }
    expect(pump).toContain("toLifecycleEvent")
    expect(pump).toContain("createExecutionJournalSubscription")
    // W9.6 — the SSE fallback subscription was removed: the journal is the SOLE execution source
    // in both admission modes (SessionExecution publishes through EventV2 unconditionally;
    // event-v2-bridge only gates the SSE mirror, so the mirror never adds rows the journal lacks).
    expect(pump).not.toContain("subscribeExecutionEvents")
  })

  test("the pump drains the durable journal (versioned types + seq-resumed cursor poll + resync notice)", async () => {
    const pump = await readFile(path.join(here, "lifecycle-execution-pump.ts"), "utf8")

    // W9.5 + W9.6 — the durable journal is the only source (the GlobalBus SSE mirror is gated by
    // event-v2-bridge and always duplicates journal rows), and journal row types are versioned
    // (`session.execution.started.1`).
    expect(pump).toContain("createExecutionJournalSubscription")
    expect(pump).toContain("eventsCursor")
    expect(pump).toContain("context.events")
    expect(pump).toContain("eventBaseType")
    expect(pump).toContain("cursor_gap_exceeded")
    // W9.6 — the bounded resync surfaces a typed notice (history-compacted semantics).
    expect(pump).toContain("onResync")
  })

  test("the session lifecycle mounts the journal as the sole source", async () => {
    const lifecycle = await readFile(path.join(here, "session-lifecycle.tsx"), "utf8")

    expect(lifecycle).toContain("createExecutionJournalSubscription({")
    expect(lifecycle).toContain("onConnectionChange")
    expect(lifecycle).toContain('lifecycle().onEvent(connected ? { type: "reconnect" } : { type: "disconnect" })')
    // W9.6 — single-source contract: no SSE fallback subscription survives in the wiring.
    expect(lifecycle).not.toContain("subscribeExecutionEvents")
    expect(lifecycle).toContain("onResync")
  })

  test("the lifecycle reducer accepts the execution event vocabulary", async () => {
    const reducer = await readFile(path.join(here, "recovery-lifecycle-state.ts"), "utf8")

    for (const event of ["execution-started", "execution-succeeded", "execution-failed", "execution-interrupted"]) {
      expect(reducer).toContain(`type: "${event}"`)
    }
    expect(reducer).toContain("lastExecution")
  })
})
