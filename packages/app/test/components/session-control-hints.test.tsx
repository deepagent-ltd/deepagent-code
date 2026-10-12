import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { GoalClient } from "@deepagent-code/core/deepagent/goal-client"
import { sessionControls } from "@/utils/session-controls"
import { PromptSubmitControl } from "@/components/prompt-input/submit-control"
import { dict } from "@/i18n/en"

vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
afterEach(cleanup)

const goal = (patch: Partial<GoalClient.Snapshot> = {}): GoalClient.Snapshot => ({
  goalId: "goal-original",
  planDocId: "plan-original",
  phase: "done",
  running: false,
  revision: 1,
  requestedPhase: "done",
  preparation: "ready",
  inFlight: false,
  recoveryRequired: false,
  wakeState: "published",
  replayed: false,
  ...patch,
})

it("only the scoped GET boolean enables existing-session modifications, without guessing from IDs or metadata", () => {
  const scope = { sessionID: "ses_imtask_ordinary", directory: "/original" }
  const session = { id: scope.sessionID, directory: scope.directory, ordinaryEligible: true }
  expect(sessionControls({ ...scope, session })).toBe("editable")
  expect(sessionControls({ ...scope, session: { ...session, ordinaryEligible: false } })).toBe("controlled")
  expect(sessionControls({ ...scope, session: { id: session.id, directory: session.directory } })).toBe("pending")
  expect(sessionControls({ ...scope, session: { ...session, directory: "/another" } })).toBe("pending")
  expect(sessionControls({ ...scope, session: { ...session, id: "another" } })).toBe("pending")
  expect(sessionControls(scope)).toBe("pending")
  expect(sessionControls({ directory: scope.directory })).toBe("editable")
})

it("Goal phase alone cannot enable modifications before confirmed terminal control", () => {
  const scope = {
    sessionID: "original",
    directory: "/original",
    session: {
      id: "original",
      directory: "/original",
      ordinaryEligible: true,
    },
  }
  expect(sessionControls({ ...scope, goal: {} })).toBe("goal")
  expect(sessionControls({ ...scope, goal: { control: goal({ inFlight: true }) } })).toBe("goal")
  expect(sessionControls({ ...scope, goal: { control: goal({ recoveryRequired: true }) } })).toBe("goal")
  expect(sessionControls({ ...scope, goal: { control: goal({ phase: "running", running: true }) } })).toBe("goal")
  expect(sessionControls({ ...scope, goal: { control: goal() } })).toBe("editable")
})

it("the same hint blocks ordinary submit and preserves the original Stop while work remains active", () => {
  const [state, setState] = createStore({ ordinaryEligible: false, working: false, stopping: false })
  const calls: string[] = []
  render(() => (
    <form
      id="controlled-composer"
      onSubmit={(event) => {
        event.preventDefault()
        calls.push(state.stopping ? "stop" : "send")
      }}
    >
      <PromptSubmitControl
        form="controlled-composer"
        disabled={false}
        finished={false}
        preparing={false}
        working={state.working}
        blank={false}
        stopping={state.stopping}
        recovery={false}
        selectionRequired={false}
        blockedReason={
          sessionControls({
            sessionID: "original",
            directory: "/original",
            session: {
              id: "original",
              directory: "/original",
              ordinaryEligible: state.ordinaryEligible,
            },
          }) === "editable"
            ? undefined
            : dict["composer.sessionControl.fixed"]
        }
        mode="normal"
        tip="Original action"
      />
    </form>
  ))
  const send = screen.getByRole("button", { name: dict["prompt.action.send"] })
  expect(send.hasAttribute("disabled")).toBe(true)
  fireEvent.click(send)
  expect(calls).toEqual([])
  expect(screen.getByRole("status").textContent).toBe(dict["composer.sessionControl.fixed"])
  setState({ working: true, stopping: true })
  const stop = screen.getByRole("button", { name: dict["prompt.action.stop"] })
  expect(stop.hasAttribute("disabled")).toBe(false)
  fireEvent.click(stop)
  expect(calls).toEqual(["stop"])
  setState({ ordinaryEligible: true, working: false, stopping: false })
  expect(screen.queryByRole("status")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: dict["prompt.action.send"] }))
  expect(calls).toEqual(["stop", "send"])
})
