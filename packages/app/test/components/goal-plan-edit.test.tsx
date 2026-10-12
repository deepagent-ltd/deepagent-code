import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import type { JSX } from "solid-js"
import { createStore } from "solid-js/store"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { GoalPlanClient } from "@deepagent-code/core/deepagent/goal-plan-client"
import { GoalPlanEditDialog } from "@/components/deepagent/goal-plan-edit-dialog"
import { dict } from "@/i18n/en"

const fixture = vi.hoisted(() => ({
  directory: "",
  pending: new Set<Promise<unknown>>(),
  hold: undefined as undefined | (() => Promise<void>),
}))
vi.mock("@/utils/goal-plan-draft", async () => {
  const sibling = "../../../tui/src/util/goal-plan-draft"
  const { createGoalPlanDraftStore } = (await import(/* @vite-ignore */ sibling)) as {
    createGoalPlanDraftStore(directory: string): GoalPlanClient.Store
  }
  return {
    createGoalPlanDraftStore: () => {
      const store = createGoalPlanDraftStore(fixture.directory)
      return {
        ...store,
        put: (...args: Parameters<typeof store.put>) => {
          const operation = (async () => {
            if (args[0].phase === "sending") await fixture.hold?.()
            return store.put(...args)
          })()
          fixture.pending.add(operation)
          void operation.finally(() => fixture.pending.delete(operation)).catch(() => undefined)
          return operation
        },
        close() {},
      }
    },
  }
})
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
vi.mock("@/context/server", () => ({ useServer: () => ({ current: { http: { username: "fixture-operator" } } }) }))
// Keep the actual editor, SDK, HTTP and disk store; dialog portal/focus is exercised in Chrome.
vi.mock("@deepagent-code/ui/v2/dialog-v2", () => ({
  Dialog: (props: { children: JSX.Element }) => <div>{props.children}</div>,
  DialogFooter: (props: { children: JSX.Element }) => <footer>{props.children}</footer>,
}))
const hash = (value: unknown) => createHash("sha256").update(GoalPlanClient.canonical(value)).digest("hex")
const plan = {
  plan_id: "plan",
  session_id: "ses_ui",
  goal: "Preserve completed work",
  created_at: "2026-10-07T00:00:00Z",
  assumptions: [],
  active_step_id: null,
  steps: [
    {
      step_id: "done",
      title: "Completed source",
      status: "done",
      acceptance: "verified",
      evidence: ["original-proof"],
    },
    { step_id: "next", title: "Future source", status: "pending", acceptance: "future check" },
  ],
}
function response(
  command: GoalPlanClient.Command,
  id: string,
  state: GoalPlanClient.Response["current"]["state"] = "ready",
): GoalPlanClient.Response {
  const receipt = {
    version: 1 as const,
    requestID: command.request.requestID,
    requestHash: hash(command),
    action: command.action,
    editID: id,
    goalID: command.request.goalID,
    sessionID: command.request.sessionID,
    revision: state === "ready" ? 2 : 3,
    state,
    sourcePlanRevision: 0,
    sourceControlRevision: 1,
    targetPlanRevision: state === "committed" ? 1 : 0,
    controlRevision: 2,
    sourceReceiptHash: hash("source"),
    candidateHash: null,
    committedReceiptHash: null,
    planDocID: "doc:plan",
    planDocVersion: 1,
    planDocHash: hash(plan),
    nextSeq: 0,
    confirmedDocuments: state === "mirror_pending" ? 1 : 0,
    totalDocuments: state === "mirror_pending" ? 2 : 0,
    projections: [],
    partial: state === "mirror_pending",
    execution: "paused" as const,
    recordedAt: 1,
  }
  return {
    version: 1,
    originalReceipt: receipt,
    current: {
      editID: id,
      revision: receipt.revision,
      state,
      controlRevision: 2,
      planRevision: receipt.targetPlanRevision,
      confirmedDocuments: receipt.confirmedDocuments,
      totalDocuments: receipt.totalDocuments,
      partial: receipt.partial,
      safeToResume: state === "committed",
      execution: state === "mirror_pending" ? "blocked" : "paused",
      retry: state === "mirror_pending" ? "reconcile" : "none",
      editSource:
        state === "ready"
          ? {
              planDocument: {
                id: "doc:plan",
                type: "plan",
                scope: "run:ses_ui",
                status: "draft",
                version: 1,
                superseded_by: null,
                created_round: null,
                domain: null,
                tags: [],
                description: "fixture",
                provenance: {},
                links: [],
                body: JSON.stringify(plan),
              },
              planDocHash: hash(plan),
              sourceReceiptHash: hash("source"),
              baselineDocsHash: hash("baseline"),
              attemptedStepIDs: ["done"],
            }
          : null,
    },
    replayed: false,
  }
}
const scopes: (() => Promise<void>)[] = []
beforeEach(async () => {
  fixture.hold = undefined
  fixture.directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-goal-plan-dom-"))
})
afterEach(async () => {
  cleanup()
  await Promise.allSettled([...fixture.pending])
  for (const close of scopes.splice(0)) await close()
  await fs.rm(fixture.directory, { recursive: true, force: true })
})
async function setup(mode: "normal" | "lost" | "approval" | "conflict" = "normal") {
  const calls: { method: string; url: URL; body: unknown }[] = []
  const persisted: GoalPlanClient.Draft[][] = []
  const state: {
    response?: GoalPlanClient.Response
    begin?: GoalPlanClient.Command
    getMissing: boolean
    release?: () => void
  } = { getMissing: false }
  const server = createServer(async (request, output) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString()
    const url = new URL(request.url!, "http://fixture")
    const body = raw ? JSON.parse(raw) : undefined
    calls.push({ method: request.method!, url, body })
    output.setHeader("Content-Type", "application/json")
    output.setHeader("Access-Control-Allow-Origin", "*")
    output.setHeader("Access-Control-Allow-Headers", "content-type")
    output.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    if (request.method === "OPTIONS") {
      output.end()
      return
    }
    if (url.pathname === "/deepagent/goal/status") {
      output.end(JSON.stringify({ goal: { goalId: "goal_ui", revision: 1 } }))
      return
    }
    if (request.method === "GET") {
      if (!state.response || state.getMissing) {
        output.statusCode = 404
        output.end(JSON.stringify({ code: "NOT_FOUND", message: "Not found" }))
        return
      }
      output.end(JSON.stringify({ ...state.response, replayed: true }))
      return
    }
    persisted.push(
      GoalPlanClient.records(
        JSON.parse(await fs.readFile(path.join(fixture.directory, "goal-plan-v1/records.json"), "utf8")),
      ),
    )
    const action = url.pathname.endsWith("/begin")
      ? "begin"
      : url.pathname.endsWith("/apply")
        ? "apply"
        : url.pathname.endsWith("/reconcile")
          ? "reconcile"
          : "cancel"
    const command: GoalPlanClient.Command = { action, request: body }
    if (mode === "conflict") {
      output.statusCode = 409
      output.end(JSON.stringify({ code: "REVISION_CONFLICT", message: "Current Goal changed" }))
      return
    }
    const id = action === "begin" ? await GoalPlanClient.locator(body) : body.editID
    if (action === "begin") state.begin = command
    if (mode === "approval" && action === "apply")
      await new Promise<void>((resolve) => {
        state.release = resolve
      })
    state.response = response(
      command,
      id,
      action === "apply"
        ? mode === "approval"
          ? "mirror_pending"
          : "committed"
        : action === "reconcile"
          ? "committed"
          : "ready",
    )
    if (mode === "lost" && calls.filter((call) => call.method === "POST").length === 1) {
      request.socket.destroy()
      return
    }
    output.end(JSON.stringify(state.response))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  scopes.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No HTTP listener")
  const url = `http://127.0.0.1:${address.port}`
  const client = createDeepAgentCodeClient({ baseUrl: url })
  const [target, setTarget] = createStore({ current: true })
  const scope = { server: "fixture", url, directory: "/fixture", sessionID: "ses_ui", goalID: "goal_ui" }
  const close = vi.fn()
  const open = () =>
    render(() => <GoalPlanEditDialog scope={scope} client={client} current={() => target.current} onClose={close} />)
  const component = open()
  await screen.findByRole("button", { name: "Prepare edit" })
  return { calls, persisted, state, open, component, close, setTarget }
}
const posts = (f: Awaited<ReturnType<typeof setup>>) => f.calls.filter((call) => call.method === "POST")
async function begin() {
  fireEvent.click(screen.getByRole("button", { name: "Prepare edit" }))
  await screen.findByDisplayValue("Future source")
}
async function edit() {
  fireEvent.input(screen.getByDisplayValue("Future source"), { target: { value: "中文 revised future" } })
  fireEvent.input(screen.getByLabelText("Reason for this plan revision"), { target: { value: "Refine future work" } })
  await waitFor(() => expect(screen.queryByText("Saving draft…")).toBeNull())
}

it("opens read-only; durable draft precedes POST, preserves completed fields, and cold view does not begin again", async () => {
  const f = await setup()
  expect(posts(f)).toHaveLength(0)
  await begin()
  expect(f.persisted[0][0].phase).toBe("sending")
  expect(f.persisted[0][0].command?.request).toEqual(posts(f)[0].body)
  expect(screen.getByDisplayValue("Completed source").hasAttribute("disabled")).toBe(true)
  await edit()
  f.component.unmount()
  await Promise.allSettled([...fixture.pending])
  const reopened = f.open()
  await screen.findByDisplayValue("中文 revised future")
  expect(posts(f)).toHaveLength(1)
  fireEvent.click(screen.getByRole("button", { name: "Review permissions and apply" }))
  await screen.findByText("Plan saved")
  expect(posts(f)).toHaveLength(2)
  const applied = posts(f)[1].body as GoalPlanClient.Candidate & { candidate: GoalPlanClient.Candidate }
  expect(applied.candidate.steps[0]).toEqual(plan.steps[0])
  expect(applied.candidate.steps[1].title).toBe("中文 revised future")
  expect(f.calls.some((call) => /resume|prompt/.test(call.url.pathname))).toBe(false)
  reopened.unmount()
})
it("lost begin ACK retains lookup and exact identity; 404 observation never automatically posts", async () => {
  const f = await setup("lost")
  fireEvent.click(screen.getByRole("button", { name: "Prepare edit" }))
  await screen.findByRole("button", { name: "Retry saved request" })
  const original = posts(f)[0].body
  f.state.getMissing = true
  f.component.unmount()
  await Promise.allSettled([...fixture.pending])
  f.open()
  await screen.findByText("Not found")
  expect(posts(f)).toHaveLength(1)
  fireEvent.click(screen.getByRole("button", { name: "Retry saved request" }))
  await screen.findByDisplayValue("Future source")
  expect(posts(f)[1].body).toEqual(original)
})
it("closing during permission wait retains pending command; partial result requires explicit reconcile, never resumes", async () => {
  const f = await setup("approval")
  await begin()
  await edit()
  fireEvent.click(screen.getByRole("button", { name: "Review permissions and apply" }))
  await waitFor(() => expect(f.state.release).toBeTypeOf("function"))
  fireEvent.click(screen.getByRole("button", { name: "Close to review permission" }))
  await waitFor(() => expect(f.close).toHaveBeenCalledOnce())
  f.component.unmount()
  expect(posts(f)).toHaveLength(2)
  f.state.release!()
  await waitFor(async () => {
    const values = JSON.parse(await fs.readFile(path.join(fixture.directory, "goal-plan-v1/records.json"), "utf8"))
    expect(values[0].response.current.state).toBe("mirror_pending")
  })
  f.open()
  await screen.findByText("Some document changes still need confirmation")
  expect(posts(f)).toHaveLength(2)
  fireEvent.click(screen.getByRole("button", { name: "Confirm pending document changes" }))
  await screen.findByText("Plan saved")
  expect(posts(f)).toHaveLength(3)
  expect(f.calls.some((call) => /resume|cancel|prompt/.test(call.url.pathname))).toBe(false)
})
it("a typed 409 never retries or retargets the Goal", async () => {
  const f = await setup("conflict")
  fireEvent.click(screen.getByRole("button", { name: "Prepare edit" }))
  await screen.findByText("Current Goal changed")
  expect(posts(f)).toHaveLength(1)
  expect(screen.queryByRole("button", { name: "Retry saved request" })).toBeNull()
  expect(posts(f)[0].body).toMatchObject({ goalID: "goal_ui", expectedControlRevision: 1 })
})

it("unmount while durable dispatch record is queued prevents the unissued POST", async () => {
  const f = await setup()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  fixture.hold = () => gate
  fireEvent.click(screen.getByRole("button", { name: "Prepare edit" }))
  await waitFor(() => expect(fixture.pending.size).toBe(1))
  f.setTarget("current", false)
  f.component.unmount()
  release()
  await Promise.allSettled([...fixture.pending])
  await waitFor(async () => {
    const values = JSON.parse(await fs.readFile(path.join(fixture.directory, "goal-plan-v1/records.json"), "utf8"))
    expect(values[0].phase).toBe("draft")
    expect(values[0].command.action).toBe("begin")
  })
  expect(posts(f)).toHaveLength(0)
})
