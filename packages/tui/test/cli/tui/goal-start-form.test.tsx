/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { GoalClient } from "@deepagent-code/core/deepagent/goal-client"
import { openGoalStart } from "../../../src/component/dialog-goal-start"
import { useDialog } from "../../../src/ui/dialog"
import { useTuiI18n } from "../../../src/context/i18n"
import { mountIM, until } from "../../fixture/im-environment"
import { tmpdir } from "../../fixture/fixture"

test("actual TUI Goal form captures workspace source and custom tests without inserting diagnostics", async () => {
  await using tmp = await tmpdir()
  const state = { result: undefined as Omit<GoalClient.StartInput, "sessionID" | "requestID"> | undefined }
  function View() {
    const dialog = useDialog()
    const i18n = useTuiI18n()
    onMount(
      () =>
        void openGoalStart({
          dialog,
          current: () => true,
          text: (key) => i18n.t(`tui.goal.start.${key}` as keyof typeof import("../../../src/i18n/en").dict),
        }).then((value) => {
          state.result = value
        }),
    )
    return <text>Goal form harness</text>
  }
  using ui = await mountIM(tmp.path, "http://127.0.0.1:1", View, 140)
  await ui.frame("Start continuous execution")
  await ui.choose("source")
  await ui.frame("Standard workspace goal+plan.md")
  await ui.choose("preset")
  await ui.frame("Custom: plan complete")
  await ui.choose("commands")
  await ui.type("bun test affected.test.ts")
  ui.app.mockInput.pressEnter()
  await ui.frame("Start continuous execution")
  await ui.choose("start")
  await until(() => state.result !== undefined, "Goal form result")
  expect(state.result).toEqual({
    planSource: "workspace-file",
    codeRefs: [],
    criteria: [{ kind: "plan_complete" }, { kind: "tests_pass", commands: ["bun test affected.test.ts"] }],
  })
})

test("closing the TUI Goal form admits no execution", async () => {
  await using tmp = await tmpdir()
  const state = { resolved: false, result: undefined as unknown }
  function View() {
    const dialog = useDialog()
    const i18n = useTuiI18n()
    onMount(
      () =>
        void openGoalStart({
          dialog,
          current: () => true,
          text: (key) => i18n.t(`tui.goal.start.${key}` as keyof typeof import("../../../src/i18n/en").dict),
        }).then((value) => {
          state.result = value
          state.resolved = true
        }),
    )
    return <text>Goal form harness</text>
  }
  using ui = await mountIM(tmp.path, "http://127.0.0.1:1", View, 140)
  await ui.frame("Start continuous execution")
  ui.app.mockInput.pressEscape()
  await until(() => state.resolved, "Goal cancellation")
  expect(state.result).toBeUndefined()
})
