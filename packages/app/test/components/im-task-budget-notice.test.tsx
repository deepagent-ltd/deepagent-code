import { afterEach, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { TaskBudgetNotice } from "@/components/im/task-budget-notice"
import { dict } from "@/i18n/en"
vi.mock("@/context/language", () => ({ useLanguage: () => ({
  t: (key: keyof typeof dict, values: Record<string, string | number>) => Object.entries(values).reduce(
    (text, [key, value]) => text.replace(`{{${key}}}`, String(value)), dict[key]),
}) }))
afterEach(cleanup)
it("the approved conservative profile explains the current per-turn reserve without claiming usage or billing", () => {
  const [target, setTarget] = createStore({ profile: { id: "project_deepseek_context_bound_v1" }, budget: {
    maxInputTokens: 1048576, maxCompletionTokens: 4096, maxTotalTokens: 2105344, hourTokensMax: 2105344,
  } })
  const view = render(() => <TaskBudgetNotice target={target} />)
  expect(screen.getByText(/conservatively reserves 1048576 input tokens/).textContent).toContain("1052672 total per call")
  expect(screen.getByText(/not consumed tokens or a bill/).textContent).toContain("Actual usage comes from the execution receipt")
  setTarget("profile", "id", "project_work_v1")
  expect(view.container.querySelector("[data-im-task-budget-notice]")).toBeNull()
})
