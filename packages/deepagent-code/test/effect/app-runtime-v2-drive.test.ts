import { describe, expect, test } from "bun:test"
import type { SessionV2 } from "@deepagent-code/core/session"
import type { AppServices } from "../../src/effect/app-runtime"

// §16.3 order 3 composition lock: the flag-gated subagent V2 drive resolves `SessionV2.Service` via
// `serviceOption` from the ROOT composition scope (goal-manager / facade-activity run through the
// AppRuntime graph). If the root graph ever stops exporting the shared SessionV2.liveLayer, the flag
// silently degrades to the legacy path — this compile-time assertion fails the typecheck instead.
// Type-only on purpose: importing the runtime value would build the whole app graph.
type RootExportsV2Session = SessionV2.Service extends AppServices ? true : never

describe("AppRuntime composition exports the V2 session stack (§16.3 order 3 wiring gate)", () => {
  test("SessionV2.Service is part of the AppRuntime service context", () => {
    const lock: RootExportsV2Session = true
    expect(lock).toBe(true)
  })
})
