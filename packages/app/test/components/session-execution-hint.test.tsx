import { afterEach, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import type { SessionStatus } from "@deepagent-code/sdk/client"
import { SessionExecutionHint } from "@/pages/session/composer/session-execution-hint"
import { dict } from "@/i18n/en"

vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
afterEach(cleanup)

it("replaces the steer hint with explicit recovery guidance based on typed authority", () => {
  const [state, setState] = createStore<{ status?: SessionStatus }>({ status: { type: "busy" } })
  const result = render(() => <SessionExecutionHint status={state.status} />)
  expect(screen.getByText(dict["composer.steer.hint"])).toBeTruthy()
  for (const blockedReason of [undefined, "recovery_required", "authority_conflict", "owned_elsewhere"] as const) {
    setState("status", { type: "recovery_required", message: "not a recovery phrase", blockedReason })
    expect(screen.queryByText(dict["composer.steer.hint"])).toBeNull()
    expect(screen.getByRole("status").textContent).toBe(dict["composer.recovery.hint"])
    expect(result.container.querySelector("button")).toBeNull()
  }
  setState("status", { type: "retry", attempt: 1, message: "retry", next: 1000 })
  expect(screen.getByText(dict["composer.steer.hint"])).toBeTruthy()
  expect(screen.queryByRole("status")).toBeNull()
  setState("status", { type: "idle" })
  expect(result.container.textContent).toBe("")
})
