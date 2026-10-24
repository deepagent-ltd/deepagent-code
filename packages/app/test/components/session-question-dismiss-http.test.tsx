import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import type { QuestionRequest } from "@deepagent-code/sdk/client"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { SessionQuestionDock } from "@/pages/session/composer/session-question-dock"
import { dict } from "@deepagent-code/ui/i18n/en"

const wiring = vi.hoisted((): { client?: ReturnType<typeof createDeepAgentCodeClient> } => ({}))
vi.mock("@/context/sdk", () => ({ useSDK: () => ({ client: wiring.client }) }))
vi.mock("@/context/server-sdk", () => ({ useServerSDK: () => ({ scope: "local" }) }))
vi.mock("@/context/sync", () => ({
  useSync: () => ({ data: { question_v2: { ses_plan_dismiss: { que_plan_dismiss: true } } } }),
}))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] ?? key }) }))
afterEach(cleanup)

it("copies the original plan bytes and explicitly dismisses only its original V2 question over HTTP", async () => {
  const body = JSON.stringify({
    plan_id: "plan_original_dismiss",
    session_id: "ses_plan_dismiss",
    goal: "Read only the owned example",
    assumptions: ["No model dispatch or workspace changes"],
    steps: [{ step_id: "one", title: "Original step", status: "pending", acceptance: "Original scope" }],
    active_step_id: null,
    created_at: "2026-10-16",
  })
  const hash = createHash("sha256").update(body).digest("hex")
  const request: QuestionRequest = {
    id: "que_plan_dismiss",
    sessionID: "ses_plan_dismiss",
    questions: [
      {
        header: "Execute plan",
        question: `Approve plan plan_original_dismiss, version 1 (${hash})? Approval queues this exact version in the same Session. Later drafts will not replace it.\n\n${body}`,
        custom: false,
        options: [{ label: "Execute this version", description: "Execute" }],
      },
    ],
  }
  const requests: { method?: string; path?: string; bytes: number }[] = []
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type")
    if (request.method === "OPTIONS") {
      response.writeHead(204).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push({ method: request.method, path: request.url, bytes: Buffer.concat(chunks).length })
    response.writeHead(204).end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Owned HTTP peer unavailable")
  wiring.client = createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}` })
  const copied: string[] = []
  const descriptor = Object.getOwnPropertyDescriptor(document, "execCommand")
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: () => {
      copied.push((document.body.querySelector("textarea[readonly]") as HTMLTextAreaElement).value)
      return true
    },
  })
  const submitted = vi.fn()
  try {
    render(() => (
      <QueryClientProvider client={new QueryClient()}>
        <SessionQuestionDock request={request} onSubmit={submitted} />
      </QueryClientProvider>
    ))
    await waitFor(() => expect(document.querySelector('[data-component="plan-approval"]')).not.toBeNull())
    fireEvent.click(screen.getByRole("button", { name: dict["ui.planApproval.view"] }))
    await waitFor(() => expect(document.querySelector('[data-slot="plan-approval-snapshot"]')?.textContent).toBe(body))
    fireEvent.click(screen.getByRole("button", { name: dict["ui.planApproval.copy"] }))
    expect(copied).toEqual([body])
    expect(requests).toEqual([])
    fireEvent.click(screen.getByRole("button", { name: dict["ui.common.dismiss"] }))
    await waitFor(() => expect(submitted).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(requests).toEqual([
        { method: "POST", path: "/api/session/ses_plan_dismiss/question/que_plan_dismiss/reject", bytes: 0 },
      ]),
    )
  } finally {
    cleanup()
    if (descriptor) Object.defineProperty(document, "execCommand", descriptor)
    else Reflect.deleteProperty(document, "execCommand")
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})
