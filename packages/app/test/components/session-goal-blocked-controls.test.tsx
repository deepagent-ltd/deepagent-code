import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { createServer } from "node:http"
import { createDeepAgentCodeClient, type PermissionRequest, type QuestionRequest } from "@deepagent-code/sdk"
import { GoalClient } from "@deepagent-code/core/deepagent/goal-client"
import type { SessionGoal } from "@/context/global-sync/types"
import { SessionComposerRegion } from "@/pages/session/composer/session-composer-region"
import { dict } from "@/i18n/en"

const wiring = vi.hoisted(() => ({
  sdk: {} as object,
  sync: {} as object,
  route: {} as object,
  serverSync: {} as object,
}))
vi.mock("@/context/sdk", () => ({ useSDK: () => wiring.sdk }))
vi.mock("@/context/sync", () => ({ useSync: () => wiring.sync }))
vi.mock("@/context/server-sync", () => ({ useServerSync: () => wiring.serverSync }))
vi.mock("@/pages/session/session-layout", () => ({ useSessionKey: () => wiring.route }))
vi.mock("@solidjs/router", () => ({ useNavigate: () => vi.fn() }))
vi.mock("@/context/layout", () => ({
  useLayout: () => ({ view: () => ({ todoCollapsed: { get: () => false, set: vi.fn() } }) }),
}))
vi.mock("@/context/prompt", () => ({ usePrompt: () => ({ ready: () => true, current: () => [] }) }))
vi.mock("@/context/server", () => ({ useServer: () => ({ current: undefined }) }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
vi.mock("@deepagent-code/ui/context/dialog", () => ({ useDialog: () => ({ show: vi.fn(), close: vi.fn() }) }))
vi.mock("@deepagent-code/ui/motion-spring", () => ({ useSpring: () => () => 0 }))
vi.mock("@/components/prompt-input", () => ({ PromptInput: () => <div data-testid="ordinary-prompt" /> }))
vi.mock("@/components/deepagent/goal-start-button", () => ({ GoalStartButton: () => null }))
vi.mock("@/components/deepagent/goal-plan-edit-dialog", () => ({ GoalPlanEditDialog: () => null }))
vi.mock("@/pages/session/composer/session-question-dock", () => ({
  SessionQuestionDock: () => <div data-testid="question-dock" />,
}))
vi.mock("@/pages/session/composer/session-provider-recovery-dock", () => ({ SessionProviderRecoveryDock: () => null }))
vi.mock("@/recovery/RecoveryDock", () => ({ RecoveryDock: () => null }))
vi.mock("@/utils/toast", () => ({ showToast: vi.fn() }))

const snapshot = (patch: Partial<GoalClient.Snapshot> = {}): GoalClient.Snapshot => ({
  goalId: "goal-current",
  planDocId: "plan-current",
  phase: "running",
  running: true,
  revision: 3,
  requestedPhase: "running",
  preparation: "ready",
  inFlight: false,
  recoveryRequired: false,
  wakeState: "published",
  replayed: false,
  ...patch,
})

afterEach(cleanup)

async function fixture(kind: "permission" | "question", initial: GoalClient.Snapshot | null = snapshot()) {
  const requests: { method: string; url: string; directory?: string; body: unknown }[] = []
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,x-deepagent-code-directory")
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString()
      requests.push({
        method: request.method ?? "GET",
        url: request.url ?? "",
        directory: request.headers["x-deepagent-code-directory"]?.toString(),
        body: text ? JSON.parse(text) : undefined,
      })
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end(
        JSON.stringify(
          request.url?.endsWith("/abort")
            ? true
            : snapshot({ revision: 4, phase: "stopped", requestedPhase: "stopped", inFlight: true }),
        ),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("The original Goal HTTP peer was not bound")
  const client = createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}`, directory: "/goal-project" })
  const [view, setView] = createStore({ blocked: true, working: initial === null })
  const [data, setData] = createStore<{ session_goal: Record<string, SessionGoal | undefined> }>({
    session_goal: initial
      ? {
          "goal-session": {
            goalId: initial.goalId,
            planDocId: initial.planDocId,
            phase: initial.phase,
            control: initial,
            ledger: { ticks: 0, tokens: 0, cost: 0, wallclockMs: 0 },
            stallCount: 0,
            gaps: [],
          },
        }
      : {},
  })
  wiring.sdk = { client, scope: "captured-server", url: `http://127.0.0.1:${address.port}`, directory: "/goal-project" }
  wiring.route = { params: { id: "goal-session", dir: "captured-directory" }, sessionKey: () => "captured-session" }
  wiring.sync = {
    data: { session_status: {}, session_working: () => view.working },
    session: { get: () => ({ parentID: undefined }) },
  }
  wiring.serverSync = {
    data,
    goal: {
      sync: () => Promise.resolve(),
      set: (sessionID: string, value?: SessionGoal) => setData("session_goal", sessionID, value),
    },
  }
  const permission: PermissionRequest = {
    id: "permission-current",
    sessionID: "goal-session",
    permission: "bash",
    patterns: ["pwd"],
    always: [],
    metadata: {},
  }
  const question: QuestionRequest = { id: "question-current", sessionID: "goal-session", questions: [] }
  const mount = () =>
    render(() => (
      <SessionComposerRegion
        state={{
          blocked: () => view.blocked,
          permissionRequest: () => (kind === "permission" && view.blocked ? permission : undefined),
          questionRequest: () => (kind === "question" && view.blocked ? question : undefined),
          permissionResponding: () => false,
          decide: vi.fn(),
          todos: () => [],
          dock: () => false,
          closing: () => false,
          opening: () => false,
        }}
        ready
        centered={false}
        inputRef={() => {}}
        newSessionWorktree=""
        onNewSessionWorktreeReset={() => {}}
        onSubmit={() => {}}
        onResponseSubmit={() => {}}
        setPromptDockRef={() => {}}
      />
    ))
  const close = async () => {
    cleanup()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
  return { requests, setView, mount, close }
}

it.each(["permission", "question"] as const)(
  "keeps one original Goal control reachable while the %s dock blocks the composer",
  async (kind) => {
    const f = await fixture(kind)
    try {
      f.mount()
      const bar = document.querySelector("[data-component='goal-status-bar']")
      if (!(bar instanceof HTMLElement)) throw new Error("The original Goal control is not visible")
      expect(document.querySelectorAll("[data-component='goal-status-bar']")).toHaveLength(1)
      expect(screen.queryByTestId("ordinary-prompt")).toBeNull()
      fireEvent.click(within(bar).getByRole("button", { name: dict["composer.goal.stop"] }))
      await waitFor(() => expect(f.requests).toHaveLength(1))
      expect(f.requests[0]).toEqual({
        method: "POST",
        url: "/deepagent/goal/stop",
        directory: "%2Fgoal-project",
        body: { sessionID: "goal-session", goalId: "goal-current", expectedRevision: 3, requestID: expect.any(String) },
      })
      await screen.findByText(dict["goal.control.stopRequested"])
      f.setView("blocked", false)
      expect(screen.getByTestId("ordinary-prompt")).toBeTruthy()
      expect(document.querySelector("[data-component='goal-status-bar']")).toBe(bar)
      expect(document.querySelectorAll("[data-component='goal-status-bar']")).toHaveLength(1)
      expect(within(bar).queryByRole("button", { name: dict["composer.goal.dismiss"] })).toBeNull()
      expect(f.requests).toHaveLength(1)
    } finally {
      await f.close()
    }
  },
)

it("keeps recovery-required Goal controls read-only while permission is pending", async () => {
  const f = await fixture("permission", snapshot({ recoveryRequired: true, preparation: "recovery_required" }))
  try {
    f.mount()
    expect(screen.getByText(dict["goal.control.recovery"])).toBeTruthy()
    expect(screen.queryByRole("button", { name: dict["composer.goal.stop"] })).toBeNull()
    expect(screen.queryByTestId("ordinary-prompt")).toBeNull()
    expect(f.requests).toHaveLength(0)
  } finally {
    await f.close()
  }
})

it("preserves the original blocked ordinary Session stop without creating Goal controls", async () => {
  const f = await fixture("permission", null)
  try {
    f.mount()
    expect(document.querySelector("[data-component='goal-status-bar']")).toBeNull()
    expect(screen.queryByTestId("ordinary-prompt")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: dict["prompt.action.stop"] }))
    await waitFor(() => expect(f.requests).toHaveLength(1))
    expect(f.requests[0].url).toBe("/session/goal-session/abort")
    expect(f.requests[0].directory).toBe("%2Fgoal-project")
  } finally {
    await f.close()
  }
})
