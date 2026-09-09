import { describe, expect, test } from "bun:test"
import { shouldExecuteLegacyAgentMentions } from "../src/server/routes/instance/httpapi/handlers/im"
import { EVENT_V2_ADMISSION_ENV } from "../src/runtime-defaults"
import { createRuntimeFeatureRegistry } from "@deepagent-code/core/flag/runtime-features"

// P1/P2 (design v2.0-design.md W0.4 note 4) — the legacy synchronous @mention executor gate. The legacy
// path runs ONLY when the Event Dispatcher's mention branch will NOT dispatch/receipt the mention: v4
// event-driven IM is OFF (the event never reaches the dispatcher), OR V2 event admission is OFF (the
// explicit fall-back-to-legacy matrix — production `applyRuntimeDefaults` sets admission ON, so the
// DEFAULT production regime is dispatcher-owned; an operator's explicit `=false` falls back to the legacy
// executor as the single authority, never a double execution). v4 ON ∧ admission ON ⇒ the dispatcher owns
// the mention (dispatch or receipt) and the legacy path MUST be skipped — the P1 double-execution
// regression is closed from both sides with the SAME predicate (`isEventV2AdmissionEnabled()`).
//
// Note (P2): the admission-OFF combo writes NO dispatcher receipt and runs NO dispatcher dispatch — that
// is the documented "explicitly disabled admission = fall back to legacy" semantic (the legacy executor
// RUNS, so the mention is not silent; it just answers through its own reply path).

const admissionOn = createRuntimeFeatureRegistry(undefined, { [EVENT_V2_ADMISSION_ENV]: "true" })
const admissionOff = createRuntimeFeatureRegistry(undefined, { [EVENT_V2_ADMISSION_ENV]: "false" })

describe("W0.4/P1 legacy @mention executor gate (v4 × admission matrix)", () => {
  test("v4 ON + admission ON: the legacy @mention path is SKIPPED (dispatcher is the single writer)", () => {
    expect(shouldExecuteLegacyAgentMentions(2, true, admissionOn)).toBe(false)
    expect(shouldExecuteLegacyAgentMentions(0, true, admissionOn)).toBe(false)
  })

  test("v4 ON + admission OFF: the legacy @mention path RUNS (explicit fall-back-to-legacy, never silent)", () => {
    expect(shouldExecuteLegacyAgentMentions(2, true, admissionOff)).toBe(true)
  })

  test("v4 OFF: the legacy @mention path RUNS regardless of admission (event never reaches the dispatcher)", () => {
    expect(shouldExecuteLegacyAgentMentions(2, false, admissionOn)).toBe(true)
    expect(shouldExecuteLegacyAgentMentions(2, false, admissionOff)).toBe(true)
  })

  test("no mentions: the legacy executor never runs", () => {
    expect(shouldExecuteLegacyAgentMentions(0, true, admissionOff)).toBe(false)
  })
})
