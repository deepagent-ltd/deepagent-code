import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { QuestionRequest } from "@deepagent-code/sdk/client"
import { SessionQuestionDock } from "@/pages/session/composer/session-question-dock"
import { dict } from "@deepagent-code/ui/i18n/en"

vi.mock("@/context/sdk", () => ({ useSDK: () => ({ client: {} }) }))
vi.mock("@/context/server-sdk", () => ({ useServerSDK: () => ({ scope: "local" }) }))
vi.mock("@/context/sync", () => ({ useSync: () => ({ data: { question_v2: {} } }) }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] ?? key }) }))
afterEach(cleanup)

function fixture(id: string, custom?: boolean) {
  const request: QuestionRequest = {
    id,
    sessionID: "ses_question_contract",
    questions: [
      {
        header: "Execute plan",
        question: "Approve this exact version?",
        custom,
        options: [
          { label: "Execute this version", description: "Execute" },
          { label: "Keep designing", description: "Design" },
        ],
      },
    ],
  }
  return render(() => (
    <QueryClientProvider client={new QueryClient()}>
      <SessionQuestionDock request={request} onSubmit={() => undefined} />
    </QueryClientProvider>
  ))
}

it("custom false keeps only the declared choices and keyboard focus cannot reach a phantom free-form choice", async () => {
  fixture("que_custom_disabled", false)
  const choices = screen.getAllByRole("radio")
  expect(choices).toHaveLength(2)
  expect(screen.queryByText(dict["ui.messagePart.option.typeOwnAnswer"])).toBeNull()
  expect(screen.queryByRole("textbox")).toBeNull()
  fireEvent.keyDown(choices[0]!, { key: "End" })
  await waitFor(() => expect(document.activeElement).toBe(choices[1]))
  fireEvent.click(choices[1]!)
  expect(choices[1]?.getAttribute("aria-checked")).toBe("true")
  expect(screen.queryByRole("textbox")).toBeNull()
})

it("legacy default allows free-form input, while a later closed question ignores cached free-form answers", async () => {
  const first = fixture("que_custom_cache")
  expect(screen.getAllByRole("radio")).toHaveLength(3)
  fireEvent.click(screen.getByRole("radio", { name: new RegExp(dict["ui.messagePart.option.typeOwnAnswer"]) }))
  const input = await screen.findByRole("textbox")
  fireEvent.input(input, { target: { value: "cached free-form answer" } })
  first.unmount()
  const closed = fixture("que_custom_cache", false)
  expect(screen.getAllByRole("radio")).toHaveLength(2)
  expect(screen.queryByRole("textbox")).toBeNull()
  expect(closed.container.querySelector('[data-slot="question-progress-segment"]')?.getAttribute("data-answered")).toBe(
    "false",
  )
  expect(screen.getAllByRole("radio").every((choice) => choice.getAttribute("aria-checked") === "false")).toBe(true)
})
