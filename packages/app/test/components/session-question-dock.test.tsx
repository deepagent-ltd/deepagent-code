import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { QuestionRequest } from "@deepagent-code/sdk/client"
import { SessionQuestionDock } from "@/pages/session/composer/session-question-dock"
import { dict } from "@deepagent-code/ui/i18n/en"
import { PlanApproval } from "@deepagent-code/ui/plan-approval"
import { createSignal } from "solid-js"
import { createHash } from "node:crypto"

vi.mock("@/context/sdk", () => ({ useSDK: () => ({ client: {} }) }))
vi.mock("@/context/server-sdk", () => ({ useServerSDK: () => ({ scope: "local" }) }))
vi.mock("@/context/sync", () => ({ useSync: () => ({ data: { question_v2: {} } }) }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] ?? key }) }))
afterEach(cleanup)

function fixture(id: string, custom?: boolean, question = "Approve this exact version?") {
  const request: QuestionRequest = {
    id,
    sessionID: "ses_question_contract",
    questions: [
      {
        header: "Execute plan",
        question,
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

function originalPlan() {
  const body = JSON.stringify({
    plan_id: "approved-original",
    session_id: "ses_question_contract",
    goal: "Update only original.ts",
    assumptions: ["No permission changes"],
    steps: [{ step_id: "one", title: "Original step", status: "pending", acceptance: "Original test" }],
    active_step_id: null,
    created_at: "2026-10-14",
  })
  const hash = createHash("sha256").update(body).digest("hex")
  return {
    body,
    hash,
    question: `Approve plan approved-original, version 1 (${hash})? Approval queues this exact version in the same Session. Later drafts will not replace it.\n\n${body}`,
    approved: `The user approved the exact plan below for execution under the existing permissions. This approved snapshot is the execution request; later drafts are observations, not substitutes for the approved scope.\nPlan: approved-original; version: 1; SHA256: ${hash}\n\n${body}`,
  }
}

it("plan approval shows complete readable scope and declared decisions while original snapshot stays available", async () => {
  const original = originalPlan()
  const shown = fixture("que_readable_plan", false, original.question)
  await waitFor(() => expect(shown.container.querySelector('[data-component="plan-approval"]')).not.toBeNull())
  expect(shown.container.textContent).toContain("Update only original.ts")
  expect(shown.container.textContent).toContain("No permission changes")
  expect(shown.container.textContent).toContain("Original test")
  expect(shown.container.textContent).toContain(original.hash)
  expect(screen.getAllByRole("radio")).toHaveLength(2)
  fireEvent.click(screen.getByRole("button", { name: dict["ui.planApproval.view"] }))
  await waitFor(() =>
    expect(shown.container.querySelector('[data-slot="plan-approval-snapshot"]')?.textContent).toBe(original.body),
  )
})

it("queued plan can copy exact original body and a changed message cannot retain stale approval presentation", async () => {
  const original = originalPlan()
  const [text, setText] = createSignal(original.approved)
  const copied: string[] = []
  const descriptor = Object.getOwnPropertyDescriptor(document, "execCommand")
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: () => {
      copied.push((document.body.querySelector("textarea[readonly]") as HTMLTextAreaElement).value)
      return true
    },
  })
  try {
    const shown = render(() => (
      <PlanApproval
        text={text()}
        sessionID="ses_question_contract"
        kind="approved"
        approval={{ documentID: "doc-original", planID: "approved-original", version: 1, hash: original.hash }}
        fallback={<span>{text()}</span>}
      />
    ))
    await waitFor(() => expect(shown.container.querySelector('[data-component="plan-approval"]')).not.toBeNull())
    fireEvent.click(screen.getByRole("button", { name: dict["ui.planApproval.copy"] }))
    expect(copied).toEqual([original.body])
    setText("ordinary later message")
    expect(shown.container.querySelector('[data-component="plan-approval"]')).toBeNull()
    await waitFor(() => expect(shown.container.textContent).toBe("ordinary later message"))
    expect(shown.container.querySelector('[data-component="plan-approval"]')).toBeNull()
  } finally {
    if (descriptor) Object.defineProperty(document, "execCommand", descriptor)
    else Reflect.deleteProperty(document, "execCommand")
  }
})
