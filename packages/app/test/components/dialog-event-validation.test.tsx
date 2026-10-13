import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { createRoot, onCleanup, Show } from "solid-js"
import type { JSX } from "solid-js"
import { createServer } from "node:http"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { createEventValidationOwner, DialogEventValidation } from "@/components/dialog-event-validation"
import { dict } from "@/i18n/en"

const wiring = vi.hoisted(() => ({ sdk: {} as object, close: vi.fn() }))
vi.mock("@/context/sdk", () => ({ useSDK: () => wiring.sdk }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
vi.mock("@deepagent-code/ui/context/dialog", () => ({ useDialog: () => ({ close: wiring.close }) }))
vi.mock("@deepagent-code/ui/dialog", () => ({
  Dialog: (props: { title: string; children: JSX.Element }) => (
    <section aria-label={props.title}>{props.children}</section>
  ),
}))
afterEach(cleanup)

it("typed unavailable keeps the current long scope visible without asserting empty rules or candidates", async () => {
  const calls: string[] = []
  const server = await serve((path) => {
    calls.push(path)
    return { status: 403, data: { code: "VALIDATION_AUTH_REQUIRED" } }
  })
  const directory = "/private/project-with-a-long-validation-scope-name-中文目录-and-another-component-for-wrap-check"
  try {
    wiring.sdk = { client: server.client, scope: "fixture", directory }
    render(() => <DialogEventValidation sessionID="session-current" />)
    await screen.findByRole("alert")
    expect(screen.getByText(directory)).toBeDefined()
    expect(screen.queryByText(dict["eventValidation.empty"])).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.new"] }))
    await waitFor(() => expect(calls.some((path) => path.endsWith("/candidates"))).toBe(true))
    await screen.findByRole("alert")
    expect(screen.queryByText(dict["eventValidation.noTargets"])).toBeNull()
    expect(screen.queryByText(dict["eventValidation.empty"])).toBeNull()
    expect(
      calls.some((path) => ["/capture", "/configure-captured", "/control"].some((end) => path.endsWith(end))),
    ).toBe(false)
  } finally {
    await server.close()
  }
})

// These are the public renderer protocol fixtures, not proof of a native grant or execution.
const recipe = {
  logicalID: "project-tests",
  revision: 1,
  executable: "installed-bun-v1",
  parameters: [{ key: "mode", choices: ["unit", "smoke"] }],
  inputs: ["test.ts"],
  outputs: [],
  argv: [{ kind: "literal", value: "test" }],
  timeoutMs: 1000,
}
function rule(state = "disabled", revision = 1) {
  return {
    ruleID: "rule-one",
    revision,
    state,
    contentRevision: 2,
    runCount: 1,
    currentRunID: null,
    lastReason: "completed",
    configuration: {
      recipe,
      scope: { canonicalRoot: "/private/project" },
      watch: ["test.ts"],
      maxRuns: 10,
      expiresAt: Date.now() + 3600000,
    },
  }
}
async function serve(
  handler: (
    path: string,
    body: Record<string, unknown> | undefined,
  ) => Promise<{ status?: number; data: unknown }> | { status?: number; data: unknown },
) {
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", request.headers.origin ?? "http://localhost:3000")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type")
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks)
    const result = await handler(
      new URL(request.url ?? "/", "http://localhost").pathname,
      raw.length ? JSON.parse(raw.toString()) : undefined,
    )
    response.writeHead(result.status ?? 200, { "Content-Type": "application/json" })
    response.end(JSON.stringify(result.data))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing private listener")
  return {
    client: createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}` }),
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

it("real GUI and generated HTTP client capture a rule, save disabled, enable explicitly, and retain exact unknown identity", async () => {
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = []
  let saved = false
  let enabled = false
  let loseResponse = true
  let staleRetry = true
  let id = "rule-one"
  const server = await serve((path, body) => {
    calls.push({ path, body })
    if (path.endsWith("/candidates"))
      return { data: { targets: [{ targetID: "approved-project", recipes: [recipe] }] } }
    if (path.endsWith("/capture"))
      return {
        data: {
          captureID: "private-capture",
          expiresAt: Date.now() + 60000,
          preview: {
            kind: "test",
            recipe,
            parameters: body?.parameters,
            watch: body?.watch,
            maxRuns: body?.maxRuns,
            ruleExpiresAt: body?.expiresAt,
          },
        },
      }
    if (path.endsWith("/configure-captured")) {
      saved = true
      id = String(body?.ruleID)
      return {
        data: {
          receipt: { ruleID: id, requestID: body?.requestID, action: "create", ruleRevision: 1 },
          replayed: false,
        },
      }
    }
    if (path.endsWith("/control")) {
      if (loseResponse) {
        loseResponse = false
        return { status: 503, data: { code: "VALIDATION_UNAVAILABLE" } }
      }
      if (staleRetry) {
        staleRetry = false
        return { status: 409, data: { code: "VALIDATION_CONFLICT" } }
      }
      enabled = true
      return {
        data: {
          receipt: { ruleID: id, requestID: body?.requestID, action: body?.action, ruleRevision: 2 },
          replayed: true,
        },
      }
    }
    if (path.endsWith("/runs"))
      return {
        data: [
          {
            current: false,
            observation: "recovery_required",
            record: {
              runID: "old-run",
              ruleRevision: 1,
              contentRevision: 1,
              state: "dispatching",
              outcome: null,
              cancelRequested: false,
              result: null,
            },
          },
        ],
      }
    return { data: saved ? [{ ...rule(enabled ? "enabled" : "disabled", enabled ? 2 : 1), ruleID: id }] : [] }
  })
  try {
    wiring.sdk = { client: server.client, scope: "fixture", directory: "/private/project" }
    render(() => <DialogEventValidation sessionID="session-current" />)
    await screen.findByText(dict["eventValidation.empty"])
    expect(calls.filter((call) => call.body)).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.new"] }))
    await screen.findByRole("option", { name: "approved-project" })
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.preview"] }))
    await screen.findByRole("button", { name: dict["eventValidation.save"] })
    expect(calls.filter((call) => call.path.endsWith("/control"))).toHaveLength(0)
    expect(calls.find((call) => call.path.endsWith("/capture"))?.body).toMatchObject({
      sessionID: "session-current",
      targetID: "approved-project",
      recipeID: "project-tests",
      watch: ["test.ts"],
      parameters: [{ key: "mode", value: "unit" }],
      maxRuns: 10,
    })
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.save"] }))
    await screen.findByText(dict["eventValidation.saved"])
    expect(calls.find((call) => call.path.endsWith("/configure-captured"))?.body).toMatchObject({
      captureID: "private-capture",
      expectedRevision: 0,
    })
    expect(calls.filter((call) => call.path.endsWith("/control"))).toHaveLength(0)
    await screen.findByText(/Needs explicit recovery/)
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.enable"] }))
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.confirm"] }))
    await screen.findByRole("button", { name: dict["eventValidation.retry"] })
    await waitFor(() =>
      expect(screen.getByRole("button", { name: dict["eventValidation.retry"] }).hasAttribute("disabled")).toBe(false),
    )
    const original = calls.find((call) => call.path.endsWith("/control"))
    cleanup()
    render(() => <DialogEventValidation sessionID="session-current" />)
    await screen.findByRole("button", { name: dict["eventValidation.retry"] })
    await waitFor(() =>
      expect(screen.getByRole("button", { name: dict["eventValidation.retry"] }).hasAttribute("disabled")).toBe(false),
    )
    expect(calls.filter((call) => call.path.endsWith("/control"))).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.retry"] }))
    await screen.findByText(dict["eventValidation.conflict"])
    await waitFor(() =>
      expect(screen.getByRole("button", { name: dict["eventValidation.retry"] }).hasAttribute("disabled")).toBe(false),
    )
    expect(calls.filter((call) => call.path.endsWith("/control"))).toHaveLength(2)
    expect(screen.getByRole("button", { name: dict["eventValidation.new"] }).hasAttribute("disabled")).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.retry"] }))
    await screen.findByRole("button", { name: dict["eventValidation.pause"] })
    await waitFor(() =>
      expect(screen.getByRole("button", { name: dict["eventValidation.refresh"] }).hasAttribute("disabled")).toBe(
        false,
      ),
    )
    expect(calls.filter((call) => call.path.endsWith("/control")).map((call) => call.body)).toEqual([
      original?.body,
      original?.body,
      original?.body,
    ])
  } finally {
    cleanup()
    await server.close()
  }
})

it("scope switch drops a late capture and sends no configure or control", async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const paths: string[] = []
  const server = await serve(async (path) => {
    paths.push(path)
    if (path.endsWith("/capture")) {
      await gate
      return { data: { captureID: "late", expiresAt: Date.now() + 60000, preview: {} } }
    }
    if (path.endsWith("/candidates"))
      return { data: { targets: [{ targetID: "approved-project", recipes: [recipe] }] } }
    return { data: [] }
  })
  try {
    const [sdk, setSDK] = createStore({ client: server.client, scope: "original", directory: "/private/project" })
    wiring.sdk = sdk
    render(() => <DialogEventValidation sessionID="session-current" />)
    await screen.findByText(dict["eventValidation.empty"])
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.new"] }))
    await screen.findByRole("option", { name: "approved-project" })
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.preview"] }))
    await waitFor(() => expect(paths.some((path) => path.endsWith("/capture"))).toBe(true))
    setSDK("scope", "different")
    release?.()
    await waitFor(() => expect(wiring.close).toHaveBeenCalled())
    expect(screen.queryByRole("button", { name: dict["eventValidation.save"] })).toBeNull()
    expect(paths.some((path) => /configure|control/.test(path))).toBe(false)
  } finally {
    release?.()
    cleanup()
    await server.close()
  }
})

it("keyed source replacement invalidates an independently owned dialog with an immutable SDK", async () => {
  wiring.close.mockClear()
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const paths: string[] = []
  const server = await serve(async (path) => {
    paths.push(path)
    if (path.endsWith("/capture")) {
      await gate
      return { data: { captureID: "late", expiresAt: Date.now() + 60000, preview: {} } }
    }
    if (path.endsWith("/candidates"))
      return { data: { targets: [{ targetID: "approved-project", recipes: [recipe] }] } }
    return { data: [] }
  })
  let sourceDisposed = false
  try {
    const [placement, setPlacement] = createStore({ key: "original", sessionID: "session-current" })
    wiring.sdk = Object.freeze({ client: server.client, scope: "original", directory: "/private/project" })
    render(() => (
      <Show when={placement.key} keyed>
        {(key) => {
          if (key !== "original") return <span>{key}</span>
          onCleanup(() => {
            sourceDisposed = true
          })
          // The production DialogProvider also creates a separately owned root.
          render(() => (
            <DialogEventValidation
              sessionID="session-current"
              active={() => placement.key === key && placement.sessionID === "session-current"}
            />
          ))
          return <span>{key}</span>
        }}
      </Show>
    ))
    await screen.findByText(dict["eventValidation.empty"])
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.new"] }))
    await screen.findByRole("option", { name: "approved-project" })
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.preview"] }))
    await waitFor(() => expect(paths.some((path) => path.endsWith("/capture"))).toBe(true))
    setPlacement("key", "replacement")
    await waitFor(() => expect(sourceDisposed).toBe(true))
    release?.()
    await waitFor(() => expect(wiring.close).toHaveBeenCalled())
    expect(screen.queryByRole("button", { name: dict["eventValidation.save"] })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.new"] }))
    expect(paths.filter((path) => path.endsWith("/candidates"))).toHaveLength(1)
    expect(paths.some((path) => /configure|control/.test(path))).toBe(false)
  } finally {
    release?.()
    cleanup()
    await server.close()
  }
})

it("actual source owner disposal invalidates a retained dialog while SDK and route snapshots stay unchanged", async () => {
  wiring.close.mockClear()
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const paths: string[] = []
  const server = await serve(async (path) => {
    paths.push(path)
    if (path.endsWith("/capture")) {
      await gate
      return { data: { captureID: "late", expiresAt: Date.now() + 60000, preview: {} } }
    }
    if (path.endsWith("/candidates"))
      return { data: { targets: [{ targetID: "approved-project", recipes: [recipe] }] } }
    return { data: [] }
  })
  let sourceDisposed = false
  const source = createRoot((dispose) => {
    onCleanup(() => {
      sourceDisposed = true
    })
    return { dispose, active: createEventValidationOwner() }
  })
  try {
    wiring.sdk = Object.freeze({ client: server.client, scope: "original", directory: "/private/project" })
    // This renderer root intentionally outlives the real command owner's root.
    render(() => <DialogEventValidation sessionID="session-current" active={source.active} />)
    await screen.findByText(dict["eventValidation.empty"])
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.new"] }))
    await screen.findByRole("option", { name: "approved-project" })
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.preview"] }))
    await waitFor(() => expect(paths.some((path) => path.endsWith("/capture"))).toBe(true))
    source.dispose()
    expect(sourceDisposed).toBe(true)
    expect(source.active()).toBe(false)
    release?.()
    await waitFor(() => expect(wiring.close).toHaveBeenCalled())
    expect(screen.queryByRole("button", { name: dict["eventValidation.save"] })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.new"] }))
    expect(paths.filter((path) => path.endsWith("/candidates"))).toHaveLength(1)
    expect(paths.some((path) => /configure|control/.test(path))).toBe(false)
  } finally {
    source.dispose()
    release?.()
    cleanup()
    await server.close()
  }
})

const investigationTarget = {
  targetID: "approved-read-only",
  profile: { id: "event_investigate_v1", version: 1, hash: "approved-profile" },
  provider: { providerID: "approved-provider", modelID: "approved-model", routeID: "approved-route" },
  read: ["test/guard.test.ts"],
  budget: {
    maxTotalTokens: 32768,
    maxInputTokens: 16384,
    maxCompletionTokens: 4096,
    maxProviderDispatches: 8,
    maxToolCalls: 32,
    maxChildren: 0,
    maxDurationMs: 600000,
    hourTokensMax: 32768,
    hourWindowMinutes: 60,
  },
  durationMs: 600000,
}

it("investigation uses generated SDK wire, an explicit captured preview, exact unknown retry, null disable and original reports", async () => {
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = []
  const maxExpiresAt = Date.now() + 1_200_000
  let epoch = 0
  let operatorRevision = 4
  let attempts = 0
  let nativeMissing = false
  const open = vi.fn()
  const server = await serve((path, body) => {
    calls.push({ path, body })
    if (path.includes("/event-investigation/")) {
      if (path.endsWith("/candidates"))
        return {
          data: {
            ruleID: "rule-one",
            ruleRevision: 1,
            epoch,
            operatorRevision,
            maxExpiresAt,
            targets: [investigationTarget],
          },
        }
      if (path.endsWith("/reports"))
        return {
          data: Array.from({ length: 33 }, (_, index) => ({
            receiptID: `report-${index}`,
            failureKey: `failure-${index}`,
            runID: `original-run-${index}`,
            contentRevision: 2,
            contentHash: `original-content-${index}`,
            sessionID: `restricted-session-${index}`,
            grantEpoch: 1,
            createdAt: Date.now(),
            deadline: maxExpiresAt,
            work: {
              admissionState: "ready",
              controlState: "active",
              controlRevision: 1,
              outcome: index === 0 ? "unknown" : "pending",
            },
          })),
        }
      if (path.endsWith("/capture")) {
        if (nativeMissing) return { status: 503, data: { code: "VALIDATION_UNAVAILABLE" } }
        return {
          data: {
            captureID: "opaque-investigation-preview",
            expiresAt: Date.now() + 60000,
            preview: {
              ruleID: "rule-one",
              ruleRevision: 1,
              epoch,
              operatorRevision,
              grantExpiresAt: body?.expiresAt,
              target: investigationTarget,
            },
          },
        }
      }
      if (path.endsWith("/control")) {
        if (body?.operation === "enable") {
          attempts++
          if (attempts === 1) return { status: 503, data: { code: "VALIDATION_UNAVAILABLE" } }
          if (attempts === 2) {
            epoch = 7
            operatorRevision = 99
            return { status: 409, data: { code: "VALIDATION_CONFLICT" } }
          }
        }
        epoch = Number(body?.expectedEpoch) + 1
        operatorRevision = 5
        return {
          data: {
            receipt: {
              ruleID: body?.ruleID,
              requestID: body?.requestID,
              action: "update",
              investigation: { version: 1, operation: body?.operation, epoch },
            },
            replayed: attempts > 1,
          },
        }
      }
    }
    if (path.endsWith("/runs")) return { data: [] }
    return { data: [rule()] }
  })
  try {
    wiring.sdk = { client: server.client, scope: "investigation-fixture", directory: "/private/project" }
    render(() => <DialogEventValidation sessionID="session-current" onOpenSession={open} />)
    await screen.findByRole("option", { name: investigationTarget.targetID })
    await screen.findByText(/Investigation OFF/)
    expect(screen.getByText(dict["eventValidation.investigation.candidateNotice"])).toBeDefined()
    expect(screen.queryByRole("button", { name: dict["eventValidation.investigation.enable"] })).toBeNull()
    expect(calls.filter((call) => call.body)).toHaveLength(0)
    expect(screen.getAllByRole("button", { name: dict["eventValidation.investigation.open"] })).toHaveLength(32)
    expect(screen.queryByText(/original-content-32/)).toBeNull()
    expect(screen.getByText(/Unknown; result unconfirmed/)).toBeDefined()
    expect(screen.getAllByText(/Pending; no completed result/)).toHaveLength(31)
    fireEvent.click(screen.getAllByRole("button", { name: dict["eventValidation.investigation.open"] })[0]!)
    expect(open).toHaveBeenCalledExactlyOnceWith("restricted-session-0")
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: dict["eventValidation.investigation.preview"] }).hasAttribute("disabled"),
      ).toBe(false),
    )
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.investigation.preview"] }))
    await screen.findByRole("button", { name: dict["eventValidation.investigation.enable"] })
    expect(screen.getByText(/test\/guard.test.ts/)).toBeDefined()
    expect(screen.getByText(/32768 \/ 16384 \/ 4096/)).toBeDefined()
    expect(screen.getByText(/approved-provider\/approved-model/)).toBeDefined()
    expect(calls.find((call) => call.path.endsWith("/capture"))?.body).toEqual({
      ruleID: "rule-one",
      targetID: "approved-read-only",
      expiresAt: maxExpiresAt,
    })
    expect(calls.filter((call) => call.path.endsWith("/control"))).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.investigation.enable"] }))
    await screen.findByRole("button", { name: dict["eventValidation.retry"] })
    await waitFor(() =>
      expect(screen.getByRole("button", { name: dict["eventValidation.retry"] }).hasAttribute("disabled")).toBe(false),
    )
    const original = calls.find((call) => call.path.endsWith("/control"))?.body
    expect(original).toMatchObject({
      operation: "enable",
      expectedEpoch: 0,
      expectedOperatorRevision: 4,
      targetID: "approved-read-only",
      expiresAt: maxExpiresAt,
      captureID: "opaque-investigation-preview",
    })
    cleanup()
    render(() => <DialogEventValidation sessionID="session-current" onOpenSession={open} />)
    await screen.findByRole("button", { name: dict["eventValidation.retry"] })
    await waitFor(() =>
      expect(screen.getByRole("button", { name: dict["eventValidation.retry"] }).hasAttribute("disabled")).toBe(false),
    )
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.investigation.refresh"] }))
    await waitFor(() => expect(calls.filter((call) => call.path.endsWith("/candidates")).length).toBeGreaterThan(1))
    expect(calls.filter((call) => call.path.endsWith("/control"))).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.retry"] }))
    await screen.findByText(dict["eventValidation.conflict"])
    await waitFor(() =>
      expect(screen.getByRole("button", { name: dict["eventValidation.retry"] }).hasAttribute("disabled")).toBe(false),
    )
    expect(calls.filter((call) => call.path.endsWith("/control"))).toHaveLength(2)
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.retry"] }))
    await screen.findByText(dict["eventValidation.investigation.accepted"])
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: dict["eventValidation.investigation.preview"] }).hasAttribute("disabled"),
      ).toBe(false),
    )
    expect(calls.filter((call) => call.path.endsWith("/control")).map((call) => call.body)).toEqual([
      original,
      original,
      original,
    ])
    nativeMissing = true
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: dict["eventValidation.investigation.preview"] }).hasAttribute("disabled"),
      ).toBe(false),
    )
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.investigation.preview"] }))
    await screen.findByText(/Investigation preview unavailable.*VALIDATION_UNAVAILABLE/)
    expect(screen.queryByRole("button", { name: dict["eventValidation.investigation.enable"] })).toBeNull()
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: dict["eventValidation.investigation.disable"] }).hasAttribute("disabled"),
      ).toBe(false),
    )
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.investigation.disable"] }))
    await waitFor(() => expect(calls.filter((call) => call.path.endsWith("/control"))).toHaveLength(4))
    expect(calls.filter((call) => call.path.endsWith("/control"))[3]?.body).toMatchObject({
      operation: "disable",
      expectedEpoch: 1,
      expectedOperatorRevision: 5,
      targetID: null,
      expiresAt: null,
      captureID: null,
    })
    expect(calls.filter((call) => call.body).every((call) => call.path.includes("/event-investigation/"))).toBe(true)
    expect(screen.getByRole("button", { name: dict["eventValidation.enable"] })).toBeDefined()
  } finally {
    cleanup()
    await server.close()
  }
})

it("independent history refusal preserves the selected rule and original report, while rules refusal fences late reads", async () => {
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = []
  let historyUnavailable = false
  let rulesForbidden = false
  let holdReports = false
  let completedReports = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const open = vi.fn()
  const server = await serve(async (path, body) => {
    calls.push({ path, body })
    if (path.endsWith("/rules"))
      return rulesForbidden
        ? { status: 403, data: { code: "VALIDATION_AUTH_REQUIRED" } }
        : {
            data: [
              rule(),
              {
                ...rule(),
                ruleID: "rule-two",
                configuration: { ...rule().configuration, recipe: { ...recipe, logicalID: "second-tests" } },
              },
            ],
          }
    if (path.endsWith("/runs"))
      return historyUnavailable ? { status: 503, data: { code: "VALIDATION_CAPACITY" } } : { data: [] }
    const id = path.includes("/rule-two/") ? "rule-two" : "rule-one"
    if (path.endsWith("/candidates"))
      return {
        data: {
          ruleID: id,
          ruleRevision: 1,
          epoch: 0,
          operatorRevision: 4,
          maxExpiresAt: Date.now() + 3600000,
          targets: [investigationTarget],
        },
      }
    if (path.endsWith("/reports")) {
      if (holdReports) await gate
      completedReports++
      return {
        data: [
          {
            receiptID: `report-${id}`,
            failureKey: `failure-${id}`,
            runID: `original-run-${id}`,
            contentRevision: 2,
            contentHash: `original-content-${id}`,
            sessionID: `restricted-session-${id}`,
            grantEpoch: 1,
            createdAt: Date.now(),
            deadline: Date.now() + 600000,
            work: { admissionState: "ready", controlState: "active", controlRevision: 1, outcome: "unknown" },
          },
        ],
      }
    }
    return { status: 404, data: {} }
  })
  try {
    wiring.sdk = { client: server.client, scope: "independent-reads", directory: "/private/project" }
    render(() => <DialogEventValidation sessionID="session-current" onOpenSession={open} />)
    await screen.findByRole("button", { name: /second-tests/ })
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /second-tests/ }).hasAttribute("disabled")).toBe(false),
    )
    fireEvent.click(screen.getByRole("button", { name: /second-tests/ }))
    await screen.findByText(/original-content-rule-two/)
    historyUnavailable = true
    await waitFor(() =>
      expect(screen.getByRole("button", { name: dict["eventValidation.refresh"] }).hasAttribute("disabled")).toBe(
        false,
      ),
    )
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.refresh"] }))
    await screen.findByText(`${dict["eventValidation.history"]}: ${dict["eventValidation.unavailable"]}`)
    await screen.findByText(/original-content-rule-two/)
    expect(screen.getByRole("heading", { name: "second-tests" })).toBeDefined()
    expect(screen.getByRole("option", { name: investigationTarget.targetID })).toBeDefined()
    expect(screen.queryByText(dict["eventValidation.noRuns"])).toBeNull()
    expect(screen.getByText(/original-run-rule-two/)).toBeDefined()
    expect(screen.getByText(/Unknown; result unconfirmed/)).toBeDefined()
    expect(calls.filter((call) => call.path.endsWith("/reports")).at(-1)?.path).toContain("/rule-two/")
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.investigation.open"] }))
    expect(open).toHaveBeenCalledExactlyOnceWith("restricted-session-rule-two")

    holdReports = true
    const beforeHeld = calls.filter((call) => call.path.endsWith("/reports")).length
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.investigation.refresh"] }))
    await waitFor(() => expect(calls.filter((call) => call.path.endsWith("/reports"))).toHaveLength(beforeHeld + 1))
    const beforeRefusal = calls.length
    rulesForbidden = true
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.refresh"] }))
    await screen.findByText(dict["eventValidation.unavailable"])
    expect(calls.slice(beforeRefusal).map((call) => call.path)).toEqual(["/api/v1/event-validation/rules"])
    const beforeRelease = completedReports
    release?.()
    await waitFor(() => expect(completedReports).toBe(beforeRelease + 1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByRole("heading", { name: "second-tests" })).toBeNull()
    expect(screen.queryByRole("button", { name: dict["eventValidation.investigation.open"] })).toBeNull()
    expect(screen.queryByRole("button", { name: dict["eventValidation.investigation.preview"] })).toBeNull()
    expect(screen.queryByRole("button", { name: dict["eventValidation.enable"] })).toBeNull()
    expect(screen.queryByText(dict["eventValidation.empty"])).toBeNull()
    expect(calls.filter((call) => call.body)).toHaveLength(0)
    expect(open).toHaveBeenCalledTimes(1)
  } finally {
    release?.()
    cleanup()
    await server.close()
  }
})

for (const expired of ["rule", "target"] as const)
  it(`expiry ${expired} disables fresh investigation capture while retaining the original report`, async () => {
    const calls: Array<{ path: string; body?: Record<string, unknown> }> = []
    const open = vi.fn()
    const server = await serve((path, body) => {
      calls.push({ path, body })
      if (path.endsWith("/rules"))
        return {
          data: [
            {
              ...rule(),
              configuration: {
                ...rule().configuration,
                expiresAt: Date.now() + (expired === "rule" ? -1000 : 3600000),
              },
            },
          ],
        }
      if (path.endsWith("/runs")) return { data: [] }
      if (path.endsWith("/candidates"))
        return {
          data: {
            ruleID: "rule-one",
            ruleRevision: 1,
            epoch: 0,
            operatorRevision: 4,
            maxExpiresAt: Date.now() + (expired === "target" ? -1000 : 3600000),
            targets: [investigationTarget],
          },
        }
      if (path.endsWith("/reports"))
        return {
          data: [
            {
              receiptID: "expiry-report",
              runID: "original-run",
              contentHash: "original-content",
              contentRevision: 2,
              sessionID: "original-session",
              deadline: Date.now() - 1000,
              work: { outcome: "unknown" },
            },
          ],
        }
      return { status: 404, data: {} }
    })
    try {
      wiring.sdk = { client: server.client, scope: `expiry-${expired}`, directory: "/private/project" }
      render(() => <DialogEventValidation sessionID="session-current" onOpenSession={open} />)
      await screen.findByText(dict["eventValidation.reason.expired"])
      expect(
        (await screen.findByRole("button", { name: dict["eventValidation.investigation.preview"] })).hasAttribute(
          "disabled",
        ),
      ).toBe(true)
      fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.investigation.open"] }))
      expect(open).toHaveBeenCalledExactlyOnceWith("original-session")
      expect(calls.filter((call) => call.body)).toHaveLength(0)
      expect(screen.getByText(/Unknown; result unconfirmed/)).toBeDefined()
    } finally {
      cleanup()
      await server.close()
    }
  })

it("expiry after a real future preview and unknown enable preserves exact retry and reports on refresh", async () => {
  const deadline = Date.now() + 1800
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = []
  let attempts = 0
  const open = vi.fn()
  const server = await serve((path, body) => {
    calls.push({ path, body })
    if (path.endsWith("/rules"))
      return { data: [{ ...rule(), configuration: { ...rule().configuration, expiresAt: deadline } }] }
    if (path.endsWith("/runs")) return { data: [] }
    if (path.endsWith("/candidates"))
      return {
        data: {
          ruleID: "rule-one",
          ruleRevision: 1,
          epoch: 0,
          operatorRevision: 4,
          maxExpiresAt: deadline,
          targets: [investigationTarget],
        },
      }
    if (path.endsWith("/reports"))
      return {
        data: [
          {
            receiptID: "expiry-report",
            runID: "original-run",
            contentHash: "original-content",
            contentRevision: 2,
            sessionID: "original-session",
            deadline,
            work: { outcome: "unknown" },
          },
        ],
      }
    if (path.endsWith("/capture"))
      return {
        data: {
          captureID: "original-preview",
          expiresAt: deadline,
          preview: {
            ruleID: "rule-one",
            ruleRevision: 1,
            epoch: 0,
            operatorRevision: 4,
            grantExpiresAt: body?.expiresAt,
            target: investigationTarget,
          },
        },
      }
    if (path.endsWith("/control")) {
      attempts++
      if (attempts === 1) return { status: 503, data: { code: "VALIDATION_UNAVAILABLE" } }
      return {
        data: {
          receipt: {
            ruleID: body?.ruleID,
            requestID: body?.requestID,
            action: "update",
            investigation: { version: 1, operation: "enable", epoch: 1 },
          },
          replayed: true,
        },
      }
    }
    return { status: 404, data: {} }
  })
  try {
    wiring.sdk = { client: server.client, scope: "expiry-unknown", directory: "/private/project" }
    render(() => <DialogEventValidation sessionID="session-current" onOpenSession={open} />)
    await screen.findByRole("option", { name: investigationTarget.targetID })
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: dict["eventValidation.investigation.preview"] }).hasAttribute("disabled"),
      ).toBe(false),
    )
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.investigation.preview"] }))
    fireEvent.click(await screen.findByRole("button", { name: dict["eventValidation.investigation.enable"] }))
    await screen.findByRole("button", { name: dict["eventValidation.retry"] })
    await waitFor(() => expect(calls.filter((call) => call.path.endsWith("/control"))).toHaveLength(1))
    const original = calls.find((call) => call.path.endsWith("/control"))?.body
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now() + 20)))
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.investigation.refresh"] }))
    await screen.findByText(dict["eventValidation.reason.expired"])
    expect(
      (await screen.findByRole("button", { name: dict["eventValidation.investigation.preview"] })).hasAttribute(
        "disabled",
      ),
    ).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.investigation.open"] }))
    expect(open).toHaveBeenCalledExactlyOnceWith("original-session")
    expect(calls.filter((call) => call.path.endsWith("/capture"))).toHaveLength(1)
    expect(calls.filter((call) => call.path.endsWith("/control"))).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.retry"] }))
    await screen.findByText(dict["eventValidation.investigation.accepted"])
    expect(calls.filter((call) => call.path.endsWith("/control")).map((call) => call.body)).toEqual([
      original,
      original,
    ])
  } finally {
    cleanup()
    await server.close()
  }
})

it("late investigation capture cannot enable after the real source command owner is disposed", async () => {
  wiring.close.mockClear()
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const calls: string[] = []
  const server = await serve(async (path, body) => {
    calls.push(path)
    if (path.includes("/event-investigation/") && path.endsWith("/candidates"))
      return {
        data: {
          ruleID: "rule-one",
          ruleRevision: 1,
          epoch: 0,
          operatorRevision: 1,
          maxExpiresAt: Date.now() + 3600000,
          targets: [investigationTarget],
        },
      }
    if (path.endsWith("/reports") || path.endsWith("/runs")) return { data: [] }
    if (path.endsWith("/capture")) {
      await gate
      return {
        data: {
          captureID: "late-investigation",
          expiresAt: Date.now() + 60000,
          preview: {
            ruleID: "rule-one",
            ruleRevision: 1,
            epoch: 0,
            operatorRevision: 1,
            grantExpiresAt: body?.expiresAt,
            target: investigationTarget,
          },
        },
      }
    }
    return { data: [rule()] }
  })
  const source = createRoot((dispose) => ({ dispose, active: createEventValidationOwner() }))
  try {
    wiring.sdk = Object.freeze({ client: server.client, scope: "immutable", directory: "/private/project" })
    render(() => <DialogEventValidation sessionID="session-current" active={source.active} />)
    await screen.findByRole("option", { name: investigationTarget.targetID })
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: dict["eventValidation.investigation.preview"] }).hasAttribute("disabled"),
      ).toBe(false),
    )
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.investigation.preview"] }))
    await waitFor(() => expect(calls.some((path) => path.endsWith("/capture"))).toBe(true))
    source.dispose()
    release?.()
    await waitFor(() => expect(wiring.close).toHaveBeenCalled())
    expect(screen.queryByRole("button", { name: dict["eventValidation.investigation.enable"] })).toBeNull()
    expect(calls.some((path) => path.endsWith("/control"))).toBe(false)
  } finally {
    source.dispose()
    release?.()
    cleanup()
    await server.close()
  }
})

for (const state of ["disabled", "enabled"])
  it(`deterministic expiry past ${state} blocks fresh authority and labels historical ready while keeping stop and reports`, async () => {
    const calls: Array<{ path: string; body?: Record<string, unknown> }> = []
    const open = vi.fn()
    const expired = { ...rule(state), lastReason: "ready", currentRunID: "original-active-run" }
    expired.configuration.expiresAt = Date.now() - 1000
    const server = await serve((path, body) => {
      calls.push({ path, body })
      if (path.endsWith("/rules")) return { data: [expired] }
      if (path.endsWith("/runs")) return { data: [] }
      if (path.endsWith("/candidates"))
        return {
          data: {
            ruleID: "rule-one",
            ruleRevision: 1,
            epoch: 0,
            operatorRevision: 1,
            maxExpiresAt: Date.now() + 3600000,
            targets: [],
          },
        }
      if (path.endsWith("/reports"))
        return { data: [{ receiptID: "original-report", sessionID: "original-session", work: { outcome: "unknown" } }] }
      if (path.endsWith("/control"))
        return {
          data: {
            receipt: { ruleID: "rule-one", requestID: body?.requestID, action: body?.action },
            replayed: false,
          },
        }
      return { status: 404, data: {} }
    })
    try {
      wiring.sdk = { client: server.client, scope: `deterministic-past-${state}`, directory: "/private/project" }
      render(() => <DialogEventValidation sessionID="session-current" onOpenSession={open} />)
      const fresh = await screen.findByRole("button", {
        name: dict[`eventValidation.${state === "enabled" ? "verify" : "enable"}`],
      })
      expect(fresh.hasAttribute("disabled")).toBe(true)
      expect(
        screen.getByText(
          `${dict["eventValidation.reason"]}: ${dict["eventValidation.reason.expired"]} · ${dict["eventValidation.historical"]}: ${dict["eventValidation.reason.ready"]}`,
        ),
      ).toBeDefined()
      await screen.findByRole("button", { name: dict["eventValidation.investigation.open"] })
      fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.investigation.open"] }))
      expect(open).toHaveBeenCalledExactlyOnceWith("original-session")
      expect(calls.filter((call) => call.body)).toHaveLength(0)
      for (const action of state === "enabled"
        ? (["pause", "cancel", "revoke"] as const)
        : (["cancel", "revoke"] as const)) {
        await waitFor(() =>
          expect(screen.getByRole("button", { name: dict[`eventValidation.${action}`] }).hasAttribute("disabled")).toBe(
            false,
          ),
        )
        fireEvent.click(screen.getByRole("button", { name: dict[`eventValidation.${action}`] }))
        fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.confirm"] }))
        await waitFor(() => expect(calls.some((call) => call.body?.action === action)).toBe(true))
        await waitFor(() =>
          expect(screen.getByRole("button", { name: dict[`eventValidation.${action}`] }).hasAttribute("disabled")).toBe(
            false,
          ),
        )
      }
      expect(calls.filter((call) => call.body).map((call) => call.body?.action)).toEqual(
        state === "enabled" ? ["pause", "cancel", "revoke"] : ["cancel", "revoke"],
      )
      await waitFor(() => expect(screen.queryAllByText(dict["eventValidation.loading"])).toHaveLength(0))
      expect(expired.lastReason).toBe("ready")
    } finally {
      cleanup()
      await server.close()
    }
  })

for (const state of ["disabled", "enabled"])
  it(`deterministic expiry future ${state} rechecks the fresh click without a timer or control POST`, async () => {
    const deadline = Date.now() + 500
    const calls: Array<{ path: string; body?: Record<string, unknown> }> = []
    const currentRule = { ...rule(state), lastReason: "ready" }
    currentRule.configuration.expiresAt = deadline
    const server = await serve((path, body) => {
      calls.push({ path, body })
      if (path.endsWith("/rules")) return { data: [currentRule] }
      if (path.endsWith("/runs") || path.endsWith("/reports")) return { data: [] }
      if (path.endsWith("/candidates"))
        return {
          data: {
            ruleID: "rule-one",
            ruleRevision: 1,
            epoch: 0,
            operatorRevision: 1,
            maxExpiresAt: deadline,
            targets: [],
          },
        }
      return { status: 404, data: {} }
    })
    try {
      wiring.sdk = { client: server.client, scope: `deterministic-future-${state}`, directory: "/private/project" }
      render(() => <DialogEventValidation sessionID="session-current" />)
      const fresh = await screen.findByRole("button", {
        name: dict[`eventValidation.${state === "enabled" ? "verify" : "enable"}`],
      })
      await waitFor(() => expect(fresh.hasAttribute("disabled")).toBe(false))
      if (state === "enabled") fireEvent.click(fresh)
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now() + 20)))
      fireEvent.click(
        state === "enabled" ? screen.getByRole("button", { name: dict["eventValidation.confirm"] }) : fresh,
      )
      await waitFor(() =>
        expect(
          screen.getAllByRole("alert").some((alert) => alert.textContent === dict["eventValidation.reason.expired"]),
        ).toBe(true),
      )
      expect(fresh.hasAttribute("disabled")).toBe(true)
      expect(calls.filter((call) => call.body)).toHaveLength(0)
    } finally {
      cleanup()
      await server.close()
    }
  })

it("deterministic expiry refresh retains the original unknown verify body and report after the deadline", async () => {
  const deadline = Date.now() + 700
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = []
  let attempts = 0
  const server = await serve((path, body) => {
    calls.push({ path, body })
    if (path.endsWith("/rules"))
      return {
        data: [
          { ...rule("enabled"), lastReason: "ready", configuration: { ...rule().configuration, expiresAt: deadline } },
        ],
      }
    if (path.endsWith("/runs")) return { data: [] }
    if (path.endsWith("/candidates"))
      return {
        data: {
          ruleID: "rule-one",
          ruleRevision: 1,
          epoch: 0,
          operatorRevision: 1,
          maxExpiresAt: deadline,
          targets: [],
        },
      }
    if (path.endsWith("/reports"))
      return { data: [{ receiptID: "retained-report", sessionID: "original-session", work: { outcome: "unknown" } }] }
    if (path.endsWith("/control")) {
      attempts++
      if (attempts === 1) return { status: 503, data: { code: "VALIDATION_UNAVAILABLE" } }
      return {
        data: { receipt: { ruleID: "rule-one", requestID: body?.requestID, action: body?.action }, replayed: true },
      }
    }
    return { status: 404, data: {} }
  })
  const open = vi.fn()
  try {
    wiring.sdk = { client: server.client, scope: "deterministic-unknown", directory: "/private/project" }
    render(() => <DialogEventValidation sessionID="session-current" onOpenSession={open} />)
    const verify = await screen.findByRole("button", { name: dict["eventValidation.verify"] })
    await waitFor(() => expect(verify.hasAttribute("disabled")).toBe(false))
    fireEvent.click(verify)
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.confirm"] }))
    await screen.findByRole("button", { name: dict["eventValidation.retry"] })
    await waitFor(() => expect(calls.filter((call) => call.path.endsWith("/control"))).toHaveLength(1))
    const original = calls.find((call) => call.path.endsWith("/control"))?.body
    expect(original).toMatchObject({ expectedRevision: 1, action: "verify" })
    expect(calls.find((call) => call.path.endsWith("/control"))?.path).toContain("/rules/rule-one/control")
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now() + 20)))
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.refresh"] }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: dict["eventValidation.verify"] }).hasAttribute("disabled")).toBe(true),
    )
    await waitFor(() =>
      expect(screen.getByRole("button", { name: dict["eventValidation.retry"] }).hasAttribute("disabled")).toBe(false),
    )
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.investigation.open"] }))
    expect(open).toHaveBeenCalledExactlyOnceWith("original-session")
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.retry"] }))
    await screen.findByText(dict["eventValidation.accepted"])
    expect(calls.filter((call) => call.path.endsWith("/control")).map((call) => call.body)).toEqual([
      original,
      original,
    ])
    await waitFor(() => expect(screen.queryAllByText(dict["eventValidation.loading"])).toHaveLength(0))
  } finally {
    cleanup()
    await server.close()
  }
})


it.each([
  [403, "VALIDATION_AUTH_REQUIRED", "unavailable"],
  [409, "VALIDATION_CAPTURE_EXPIRED", "conflict"],
  [400, "VALIDATION_INVALID", "invalid"],
  [503, "SECRET:/private/token", "invalid"],
])("capture feedback retains only the fixed HTTP and validation code (%s %s)", async (status, code, reason) => {
  const calls: string[] = []
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
  const server = await serve((path) => {
    calls.push(path)
    if (path.endsWith("/candidates"))
      return { data: { targets: [{ targetID: "approved-project", recipes: [recipe] }] } }
    if (path.endsWith("/capture"))
      return { status, data: { code, message: "SECRET:/private/token", data: { key: "SECRET" } } }
    return { data: [] }
  })
  try {
    wiring.sdk = { client: server.client, scope: "fixture", directory: "/private/project" }
    render(() => <DialogEventValidation sessionID="session-current" />)
    await waitFor(() => expect(screen.queryAllByText(dict["eventValidation.loading"])).toHaveLength(0))
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.new"] }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: dict["eventValidation.preview"] }).hasAttribute("disabled")).toBe(false),
    )
    fireEvent.click(screen.getByRole("button", { name: dict["eventValidation.preview"] }))
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain(dict[`eventValidation.${reason}` as keyof typeof dict])
    expect(alert.textContent).toContain(`capture · HTTP ${status}`)
    expect(alert.textContent).not.toContain("SECRET")
    if (code.startsWith("VALIDATION_")) expect(alert.textContent).toContain(code)
    expect(screen.queryByRole("button", { name: dict["eventValidation.save"] })).toBeNull()
    expect(calls.filter((path) => path.endsWith("/capture"))).toHaveLength(1)
    expect(calls.some((path) => path.endsWith("/configure-captured") || path.endsWith("/control"))).toBe(false)
    expect(JSON.stringify(warning.mock.calls)).not.toContain("SECRET")
  } finally {
    await server.close()
  }
})
