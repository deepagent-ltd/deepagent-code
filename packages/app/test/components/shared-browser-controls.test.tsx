import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import type { SharedBrowserSchema } from "@deepagent-code/core/browser/shared-schema"
import type { BrowserPlatform, SharedBrowserPlatform, SharedBrowserView } from "@/context/platform"
import { SharedBrowserCreate } from "@/components/shared-browser-create"
import { SharedBrowserPreview } from "@/components/shared-browser-preview"
import { SidePanelBrowser } from "@/pages/session/side-panel-browser"
import { dict } from "@/i18n/en"
import { DialogBrowserControl } from "@/components/dialog-browser-control"
import type { JSX } from "solid-js"

const wiring = vi.hoisted(() => ({
  platform: {} as { sharedBrowser?: SharedBrowserPlatform; browser?: BrowserPlatform },
  sdk: {} as object,
}))
vi.mock("@/context/platform", () => ({ usePlatform: () => wiring.platform }))
vi.mock("@/context/sdk", () => ({ useSDK: () => wiring.sdk }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
vi.mock("@deepagent-code/ui/context/dialog", () => ({ useDialog: () => ({ close: vi.fn() }) }))
vi.mock("@deepagent-code/ui/dialog", () => ({
  Dialog: (props: { title: string; children: JSX.Element }) => (
    <section aria-label={props.title}>{props.children}</section>
  ),
}))
afterEach(() => {
  cleanup()
  wiring.platform = {}
  wiring.sdk = {}
  vi.restoreAllMocks()
})

function view(input: Partial<SharedBrowserSchema.Resource> = {}): SharedBrowserView {
  return {
    elapsedMs: 49_000,
    resource: {
      version: 2,
      profile: "managed-shared-browser-v1",
      inputAssurance: "shared-document-v1",
      resourceID: "resource-a",
      requestID: "create-a",
      requestDigest: "a".repeat(64),
      rootSessionID: "session-a",
      scope: {
        principal: "owner",
        securityNamespaceID: "ns",
        locationKey: "local",
        projectScopeKey: "project",
        namespaceBindingHash: "b".repeat(64),
        sessionID: "session-a",
        projectID: "project",
        directory: "/project",
        workspaceID: null,
      },
      mainIncarnation: "main-a",
      policy: {
        origin: "https://example.com",
        approvedOrigins: ["https://example.com"],
        manualApprovedOrigins: ["https://example.com"],
        resolverPolicy: "system",
        postGrants: [],
      },
      policyHash: "c".repeat(64),
      state: "agent_owned",
      revision: 1,
      manualEpoch: 0,
      barrierOrder: 0,
      coreCutoff: -1,
      liveLeaseID: "lease-a",
      agentAccessFenced: false,
      resourceAlive: true,
      manualEnabled: false,
      createdAt: Date.now() - 49_000,
      updatedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      ...input,
    },
  }
}
function bridge(): SharedBrowserPlatform {
  return {
    list: async () => [],
    create: async () => view(),
    takeover: async () => view(),
    close: async () => view({ state: "closed" }),
    preview: async () => ({ manualEpoch: 0 }),
    stampInput: async () => undefined,
    sealInput: async () => {
      throw new Error("Owner input sealing is unavailable in this UI fixture")
    },
    onState: () => () => {},
    tuiPending: async () => [],
    tuiApprove: async () => {
      throw new Error("This browser UI fixture does not approve terminal ownership")
    },
    tuiDetach: async () => {
      throw new Error("This browser UI fixture does not retire terminal ownership")
    },
    onTuiState: () => () => {},
  }
}

it("retains exact shared creation through unknown and reopen without granting POST or file access", async () => {
  const service = bridge()
  const calls: SharedBrowserSchema.Create[] = []
  service.create = async (input) => {
    calls.push(structuredClone(input))
    if (calls.length === 1) throw new Error("Creation outcome is unknown")
    return view({ requestID: input.requestID, policy: input.policy })
  }
  const use = vi.fn()
  const mount = () =>
    render(() => (
      <SharedBrowserCreate bridge={service} sessionID="session-a" directory="/project" scope="local" onUse={use} />
    ))
  mount()
  const resolver = within(screen.getByRole("group", { name: dict["browser.control.resolver"] })).getByRole("button")
  expect(resolver.textContent).toContain(dict["browser.control.resolverSystem"])
  resolver.focus()
  fireEvent.keyDown(resolver, { key: "ArrowDown" })
  const dns = await screen.findByRole("option", { name: dict["browser.control.resolverAliDNS"] })
  expect(screen.getByRole("option", { name: dict["browser.control.resolverCloudflare"] })).toBeDefined()
  dns.focus()
  fireEvent.keyDown(dns, { key: "Enter" })
  await waitFor(() => expect(resolver.getAttribute("aria-expanded")).toBe("false"))
  const content = dns.closest('[data-slot="select-v2-content"]')
  if (content) fireEvent.animationEnd(content, { animationName: getComputedStyle(content).animationName })
  await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0))
  expect(calls).toHaveLength(0)
  fireEvent.input(screen.getByLabelText(dict["browser.shared.origins"]), {
    target: { value: "https://login.example.com" },
  })
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.create"] }))
  await screen.findByText("Creation outcome is unknown")
  expect(calls).toHaveLength(1)
  expect(calls[0].policy.approvedOrigins).toEqual(["https://example.com", "https://login.example.com"])
  expect(calls[0].policy.manualApprovedOrigins).toEqual(calls[0].policy.approvedOrigins)
  expect(calls[0].policy.postGrants).toEqual([])
  expect(calls[0].policy.resolverPolicy).toBe("alidns_doh_v1")
  expect(calls[0].policy.filePolicy).toBeUndefined()
  expect(calls[0].policy.scriptGrants).toBeUndefined()
  cleanup()
  mount()
  const frozen = within(screen.getByRole("group", { name: dict["browser.control.resolver"] })).getByRole("button")
  expect(frozen.textContent).toContain(dict["browser.control.resolverAliDNS"])
  expect(frozen.hasAttribute("data-disabled")).toBe(true)
  fireEvent.keyDown(frozen, { key: "ArrowDown" })
  expect(screen.queryAllByRole("option")).toHaveLength(0)
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.retryCreate"] }))
  await screen.findByRole("button", { name: dict["browser.shared.open"] })
  expect(calls[1]).toEqual(calls[0])
  expect(use).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.open"] }))
  expect(use).toHaveBeenCalledExactlyOnceWith("resource-a")
})

it("rejects invalid creation before the native bridge and discards late results after scope changes", async () => {
  const service = bridge()
  const request = Promise.withResolvers<SharedBrowserView>()
  const create = vi.fn(() => request.promise)
  service.create = create
  const [scope, setScope] = createStore({ sessionID: "session-a", directory: "/project" })
  render(() => (
    <SharedBrowserCreate bridge={service} sessionID={scope.sessionID} directory={scope.directory} scope="local" />
  ))
  fireEvent.input(screen.getByLabelText(dict["browser.shared.origin"]), {
    target: { value: "https://example.com/private/path" },
  })
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.create"] }))
  expect((await screen.findByRole("alert")).textContent).toBe(dict["browser.shared.invalidPolicy"])
  expect(create).not.toHaveBeenCalled()
  fireEvent.input(screen.getByLabelText(dict["browser.shared.origin"]), { target: { value: "https://example.com" } })
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.create"] }))
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
  setScope("sessionID", "session-b")
  request.resolve(view())
  await request.promise
  expect(screen.queryByRole("button", { name: dict["browser.shared.open"] })).toBeNull()
  expect(screen.getByRole("alert").textContent).toBe(dict["browser.shared.scopeChanged"])
})

it("drops a late screenshot on manual takeover and does not read the page to return to the original chat", async () => {
  const service = bridge()
  const image = Promise.withResolvers<{ png: string; observedAt: number; manualEpoch: number }>()
  const preview = vi.fn(() => image.promise)
  service.preview = preview
  const [state, setState] = createStore({ view: view() })
  const back = vi.fn()
  render(() => (
    <SharedBrowserPreview
      view={state.view}
      bridge={service}
      onUpdate={(next) => setState("view", next)}
      onReturnToSession={back}
    />
  ))
  expect(preview).toHaveBeenCalledExactlyOnceWith({ resourceID: "resource-a", sessionID: "session-a", manualEpoch: 0 })
  setState(
    "view",
    view({ state: "human_owned", manualEpoch: 1, revision: 2, agentAccessFenced: true, manualEnabled: true }),
  )
  image.resolve({ png: "original-frame", observedAt: Date.now(), manualEpoch: 0 })
  await image.promise
  expect(screen.queryByRole("img")).toBeNull()
  expect(screen.queryByRole("button", { name: dict["browser.shared.refreshPreview"] })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.returnToSession"] }))
  expect(back).toHaveBeenCalledTimes(1)
  expect(preview).toHaveBeenCalledTimes(1)
})

it("uses the original pending request for cleanup and retains exact close identity after uncertainty", async () => {
  const service = bridge()
  const original = { resourceID: "resource-a", requestID: "original-takeover", expectedRevision: 1 }
  const takeover = vi
    .fn()
    .mockResolvedValue({ ...view({ state: "fenced_blocked", manualEpoch: 1, revision: 4 }), pendingTakeover: original })
  const close = vi.fn().mockRejectedValue(new Error("Close unconfirmed"))
  service.takeover = takeover
  service.close = close
  const [state, setState] = createStore<{ view: SharedBrowserView }>({
    view: { ...view({ state: "fenced_blocked", manualEpoch: 1, revision: 4 }), pendingTakeover: original },
  })
  render(() => (
    <SharedBrowserPreview
      view={state.view}
      bridge={service}
      onUpdate={(next) => setState("view", next)}
      onReturnToSession={() => {}}
    />
  ))
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.retryTakeover"] }))
  await waitFor(() => expect(takeover).toHaveBeenCalledExactlyOnceWith(original))
  const closeButtons = screen.getAllByRole("button", { name: dict["browser.shared.close"] })
  fireEvent.click(closeButtons[0])
  await screen.findByText("Close unconfirmed")
  fireEvent.click(screen.getAllByRole("button", { name: dict["browser.shared.close"] })[0])
  await waitFor(() => expect(close).toHaveBeenCalledTimes(2))
  expect(close.mock.calls[1][0]).toEqual(close.mock.calls[0][0])
})

it("never reuses an uncertain takeover request for another shared page with the same revision", async () => {
  const service = bridge()
  const takeover = vi.fn().mockRejectedValue(new Error("Takeover unconfirmed"))
  service.takeover = takeover
  const [state, setState] = createStore({ view: view() })
  render(() => (
    <SharedBrowserPreview
      view={state.view}
      bridge={service}
      onUpdate={(next) => setState("view", next)}
      onReturnToSession={() => {}}
    />
  ))
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.takeover"] }))
  await screen.findByText("Takeover unconfirmed")
  setState("view", view({ resourceID: "resource-b" }))
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.takeover"] }))
  await waitFor(() => expect(takeover).toHaveBeenCalledTimes(2))
  expect(takeover.mock.calls[0][0].resourceID).toBe("resource-a")
  expect(takeover.mock.calls[1][0].resourceID).toBe("resource-b")
  expect(takeover.mock.calls[1][0].requestID).not.toBe(takeover.mock.calls[0][0].requestID)
})

it("keeps the current Session state ahead of a late list and ignores another chat's resource", async () => {
  const service = bridge()
  const list = Promise.withResolvers<SharedBrowserView[]>()
  service.list = () => list.promise
  const listener = { value: undefined as ((view: SharedBrowserView) => void) | undefined }
  service.onState = (update) => {
    listener.value = update
    return () => {
      listener.value = undefined
    }
  }
  wiring.platform = { sharedBrowser: service }
  const back = vi.fn()
  render(() => <SidePanelBrowser sessionID="session-a" onClose={back} />)
  listener.value?.(view({ state: "human_owned", manualEpoch: 1, revision: 2 }))
  listener.value?.(
    view({
      resourceID: "foreign",
      rootSessionID: "session-b",
      policy: { ...view().resource.policy, origin: "https://foreign.invalid" },
    }),
  )
  list.resolve([view()])
  await list.promise
  expect(
    within(screen.getByRole("group", { name: dict["browser.shared.control"] })).getByRole("status").textContent,
  ).toBe(dict["browser.shared.human_owned"])
  expect(screen.queryByText("https://foreign.invalid")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.returnToSession"] }))
  expect(back).toHaveBeenCalledTimes(1)
})

it("keeps the personal native page hidden when shared state arrives before its container mounts", async () => {
  const service = bridge()
  service.onState = (update) => {
    update(view())
    return () => {}
  }
  const show = vi.fn(async () => {})
  const hide = vi.fn(async () => {})
  wiring.platform = {
    sharedBrowser: service,
    browser: {
      show,
      hide,
      setBounds: async () => {},
      navigate: async () => {},
      back: async () => {},
      forward: async () => {},
      reload: async () => {},
      openExternal: async () => {},
      onState: () => () => {},
    },
  }
  render(() => <SidePanelBrowser sessionID="session-a" onClose={() => {}} />)
  expect(hide).toHaveBeenCalledTimes(1)
  expect(show).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("tab", { name: dict["browser.shared.personal"] }))
  await waitFor(() => expect(show).toHaveBeenCalledTimes(1))
  expect(screen.getByPlaceholderText(dict["browser.address"])).toBeTruthy()
  fireEvent.click(screen.getByRole("tab", { name: dict["browser.shared.page"] }))
  await waitFor(() => expect(hide).toHaveBeenCalledTimes(2))
})

it("selects the exact requested shared resource, keeps unresolved pages visible, and removes only confirmed closed tabs", async () => {
  const service = bridge()
  const old = view({ resourceID: "old-resource", state: "recovery_required", revision: 5 })
  const fresh = view({ resourceID: "new-resource", state: "agent_owned", revision: 2 })
  const closed = view({ resourceID: "closed-resource", state: "closed", revision: 7 })
  const backend = { resources: [closed, old, fresh] }
  service.list = async () => backend.resources
  const listener = { value: undefined as ((view: SharedBrowserView) => void) | undefined }
  service.onState = (value) => {
    listener.value = value
    return () => {
      if (listener.value === value) listener.value = undefined
    }
  }
  wiring.platform = { sharedBrowser: service }
  const [state, setState] = createStore<{ selection?: { resourceID: string; nonce: string } }>({
    selection: { resourceID: "old-resource", nonce: "first-open" },
  })
  const app = render(() => (
    <SidePanelBrowser
      sessionID="session-a"
      selection={state.selection}
      onSelectResource={(resourceID) =>
        setState("selection", resourceID ? { resourceID, nonce: crypto.randomUUID() } : undefined)
      }
      onClose={() => {}}
    />
  ))
  await screen.findByText(dict["browser.shared.recovery_required"])
  expect(app.container.querySelector('[data-shared-resource-id="closed-resource"]')).toBeNull()
  expect(app.container.querySelectorAll("[data-shared-resource-id]")).toHaveLength(2)
  setState("selection", { resourceID: "new-resource", nonce: "show-new" })
  await screen.findByText(dict["browser.shared.agent_owned"])
  expect(app.container.querySelector('[data-shared-resource-id="new-resource"]')?.getAttribute("aria-selected")).toBe(
    "true",
  )
  expect(app.container.querySelector('[data-shared-resource-id="old-resource"]')).not.toBeNull()
  fireEvent.click(screen.getByRole("tab", { name: dict["browser.shared.personal"] }))
  await screen.findByText(dict["browser.desktopOnly"])
  setState("selection", { resourceID: "new-resource", nonce: "show-same-again" })
  await screen.findByText(dict["browser.shared.agent_owned"])
  const terminal = view({ resourceID: "new-resource", state: "closed", revision: 3 })
  backend.resources = [closed, old, terminal]
  listener.value?.(terminal)
  await waitFor(() => expect(app.container.querySelector('[data-shared-resource-id="new-resource"]')).toBeNull())
  await screen.findByText(dict["browser.shared.recovery_required"])
  expect(state.selection).toBeUndefined()
})

it("keeps one approved-site bar, keyboard page tabs and no idle terminal chrome", async () => {
  const service = bridge()
  const list = vi.fn(async () => [view(), view({ resourceID: "resource-b" })])
  service.list = list
  const close = vi.fn(async (input: SharedBrowserSchema.Close) =>
    view({ resourceID: input.resourceID, state: "closed", revision: 2 }),
  )
  const preview = vi.fn(async () => ({ manualEpoch: 0 }))
  service.close = close
  service.preview = preview
  wiring.platform = { sharedBrowser: service }
  const hide = vi.fn()
  const [selection, setSelection] = createStore<{ value?: { resourceID: string; nonce: string } }>({})
  render(() => (
    <SidePanelBrowser
      sessionID="session-a"
      directory="/project"
      onClose={hide}
      selection={selection.value}
      onSelectResource={(resourceID) =>
        setSelection("value", resourceID ? { resourceID, nonce: crypto.randomUUID() } : undefined)
      }
    />
  ))
  const first = await screen.findByRole("tab", { name: `${dict["browser.shared.page"]} 1` })
  const second = screen.getByRole("tab", { name: `${dict["browser.shared.page"]} 2` })
  const address = screen.getByRole("textbox", { name: dict["browser.shared.approvedSite"] }) as HTMLInputElement
  expect(screen.getAllByDisplayValue("https://example.com")).toHaveLength(1)
  expect(address.readOnly).toBe(true)
  expect(screen.queryByRole("region", { name: dict["browser.tui.title"] })).toBeNull()
  expect(screen.getByRole("button", { name: dict["browser.shared.refreshPreview"] })).toBeDefined()
  first.focus()
  fireEvent.keyDown(first, { key: "ArrowRight" })
  expect(document.activeElement).toBe(second)
  expect(second.getAttribute("aria-selected")).toBe("true")
  expect(list).toHaveBeenCalledTimes(1)
  fireEvent.keyDown(second, { key: "Home" })
  expect(document.activeElement).toBe(first)
  expect(first.getAttribute("aria-selected")).toBe("true")
  fireEvent.keyDown(first, { key: "ArrowRight" })
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.closePanel"] }))
  expect(hide).toHaveBeenCalledTimes(1)
  expect(close).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.refreshPreview"] }))
  await waitFor(() =>
    expect(preview).toHaveBeenCalledWith({ resourceID: "resource-b", sessionID: "session-a", manualEpoch: 0 }),
  )
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.close"] }))
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
  expect(close.mock.calls[0][0].resourceID).toBe("resource-b")
})

it("freezes explicitly selected shared grants and original bytes across an unknown creation", async () => {
  const service = bridge()
  const calls: SharedBrowserSchema.Create[] = []
  service.create = async (input) => {
    calls.push(structuredClone(input))
    if (calls.length === 1) throw new Error("Creation outcome is unknown")
    return view({ requestID: input.requestID, policy: input.policy })
  }
  const mount = () =>
    render(() => (
      <SharedBrowserCreate
        bridge={service}
        sessionID="session-a"
        directory="/project"
        scope="advanced-grants"
        advancedGrants
      />
    ))
  mount()
  fireEvent.click(screen.getByText(dict["settings.general.section.advanced"]))
  expect((screen.getByRole("checkbox", { name: dict["browser.files.upload"] }) as HTMLInputElement).checked).toBe(false)
  expect((screen.getByRole("checkbox", { name: dict["browser.files.download"] }) as HTMLInputElement).checked).toBe(
    false,
  )
  const source = "return { count: page.refs.length }"
  const args = ' { "value": 1 } '
  fireEvent.input(screen.getByLabelText(dict["browser.control.scriptSource"]), { target: { value: source } })
  fireEvent.input(screen.getByLabelText(dict["browser.control.scriptArgs"]), { target: { value: args } })
  fireEvent.click(screen.getByRole("checkbox", { name: dict["browser.files.upload"] }))
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.create"] }))
  await screen.findByText("Creation outcome is unknown")
  expect(calls[0].policy).toMatchObject({
    scriptContext: "snapshot-json-v1",
    scriptGrants: [
      {
        scriptHash: createHash("sha256").update(source).digest("hex"),
        argsHash: createHash("sha256").update(args).digest("hex"),
        readOnly: true,
      },
    ],
    filePolicy: { upload: true, download: false },
    postGrants: [],
  })
  expect(calls[0].policy.programGrants).toBeUndefined()
  fireEvent.input(screen.getByLabelText(dict["browser.control.scriptSource"]), { target: { value: "changed" } })
  fireEvent.click(screen.getByRole("checkbox", { name: dict["browser.files.download"] }))
  cleanup()
  mount()
  expect(screen.getByLabelText(dict["browser.control.scriptSource"]).getAttribute("disabled")).not.toBeNull()
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.retryCreate"] }))
  await screen.findByRole("button", { name: dict["browser.shared.open"] })
  expect(calls).toHaveLength(2)
  expect(calls[1]).toEqual(calls[0])
  cleanup()
  const programService = bridge()
  const programs: SharedBrowserSchema.Create[] = []
  programService.create = async (input) => {
    programs.push(structuredClone(input))
    return view({ requestID: input.requestID, policy: input.policy })
  }
  render(() => (
    <SharedBrowserCreate
      bridge={programService}
      sessionID="session-a"
      directory="/project"
      scope="program-grants"
      advancedGrants
    />
  ))
  fireEvent.click(screen.getByText(dict["settings.general.section.advanced"]))
  const selector = within(screen.getByRole("group", { name: dict["browser.control.program.mode"] })).getByRole("button")
  selector.focus()
  fireEvent.keyDown(selector, { key: "ArrowDown" })
  const option = await screen.findByRole("option", { name: dict["browser.control.program.name"] })
  option.focus()
  fireEvent.keyDown(option, { key: "Enter" })
  const content = option.closest('[data-slot="select-v2-content"]')
  if (content) fireEvent.animationEnd(content, { animationName: getComputedStyle(content).animationName })
  await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0))
  fireEvent.input(screen.getByLabelText(dict["browser.control.scriptSource"]), { target: { value: source } })
  fireEvent.input(screen.getByLabelText(dict["browser.control.scriptArgs"]), { target: { value: args } })
  fireEvent.click(screen.getByRole("checkbox", { name: dict["browser.control.program.operation.fill"] }))
  fireEvent.click(screen.getByRole("checkbox", { name: dict["browser.control.program.operation.scroll"] }))
  fireEvent.input(screen.getByLabelText(dict["browser.control.program.steps"]), { target: { value: "2" } })
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.create"] }))
  await screen.findByRole("button", { name: dict["browser.shared.open"] })
  expect(programs[0].policy.programGrants).toEqual([
    {
      scriptHash: createHash("sha256").update(source).digest("hex"),
      argsHash: createHash("sha256").update(args).digest("hex"),
      operations: ["fill", "scroll"],
      maxSteps: 2,
    },
  ])
  expect(programs[0].policy.scriptGrants).toBeUndefined()
  expect(programs[0].policy.filePolicy).toBeUndefined()
})

it.each(["event", "close"])(
  "keeps a pinned closed browser unavailable without selecting another resource (%s)",
  async (method) => {
    const service = bridge()
    service.list = async () => [view(), view({ resourceID: "resource-b" })]
    const listener = { value: undefined as ((view: SharedBrowserView) => void) | undefined }
    service.onState = (update) => {
      listener.value = update
      return () => {
        listener.value = undefined
      }
    }
    const select = vi.fn()
    const preview = vi.fn(async (_input: Parameters<SharedBrowserPlatform["preview"]>[0]) => ({ manualEpoch: 0 }))
    service.preview = preview
    wiring.platform = { sharedBrowser: service }
    const app = render(() => (
      <SidePanelBrowser
        sessionID="session-a"
        directory="/project"
        hideTabs
        selection={{ resourceID: "resource-a", nonce: "pinned" }}
        onSelectResource={select}
        onClose={() => {}}
      />
    ))
    await screen.findByText(dict["browser.shared.agent_owned"])
    if (method === "event") listener.value?.(view({ state: "closed", revision: 2 }))
    if (method === "close") fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.close"] }))
    await screen.findByText(dict["browser.shared.unavailable"])
    expect(select).not.toHaveBeenCalled()
    expect(preview.mock.calls.every((call) => call[0].resourceID === "resource-a")).toBe(true)
    expect(app.container.querySelector('[data-slot="browser-tabs"]')).toBeNull()
    expect(screen.queryByRole("button", { name: dict["browser.shared.takeover"] })).toBeNull()
  },
)

it("shared file shell exposes only explicit file policy from the existing user creation dialog", async () => {
  wiring.sdk = { client: {}, scope: "shared-file-create", directory: "/project" }
  const service = bridge()
  const requests: SharedBrowserSchema.Create[] = []
  service.create = async (input) => {
    requests.push(structuredClone(input))
    return view({ policy: input.policy })
  }
  render(() => <DialogBrowserControl sessionID="session-a" onUse={() => {}} sharedBrowser={service} />)
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.title"] }))
  const advanced = screen.getByText(dict["settings.general.section.advanced"])
  fireEvent.click(advanced)
  const upload = screen.getByRole("checkbox", { name: dict["browser.files.upload"] })
  const download = screen.getByRole("checkbox", { name: dict["browser.files.download"] })
  expect(upload).toHaveProperty("checked", false)
  expect(download).toHaveProperty("checked", false)
  expect(requests).toHaveLength(0)
  fireEvent.click(upload)
  fireEvent.click(download)
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.create"] }))
  await screen.findByRole("button", { name: dict["browser.shared.open"] })
  expect(requests).toHaveLength(1)
  expect(requests[0].policy.filePolicy).toEqual({ upload: true, download: true })
  expect(requests[0].policy.scriptContext).toBeUndefined()
  expect(requests[0].policy.scriptGrants).toBeUndefined()
  expect(requests[0].policy.programGrants).toBeUndefined()
  expect(requests[0].policy.postGrants).toEqual([])
})

it("shared file shell stays folded, routes one exact approval through the original SDK and disables new work after takeover", async () => {
  const calls: { path: string; method: string; body?: Record<string, unknown> }[] = []
  let approved = false
  const grant = {
    grantID: "shared-file-shell-grant",
    direction: "upload",
    name: "owned.txt",
    bytes: 3,
    expiresAt: Date.now() + 60_000,
    state: "approved",
  }
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,x-deepagent-code-directory")
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    const url = new URL(request.url ?? "/", "http://localhost")
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>) : undefined
    calls.push({ path: url.pathname, method: request.method ?? "GET", body })
    response.setHeader("Content-Type", "application/json")
    const send = (value: unknown) => response.end(JSON.stringify(value))
    if (url.pathname.endsWith("/preview"))
      return send({
        resourceID: "resource-a",
        previewID: "shared-file-shell-preview",
        resourceRevision: 1,
        leaseID: "lease-a",
        leaseEpoch: 1,
        manualEpoch: 0,
        preview: {
          direction: "upload",
          name: "owned.txt",
          relative: "owned.txt",
          bytes: 3,
          sha256: "a".repeat(64),
          targetURL: "https://example.com/upload",
          observedAt: 1,
        },
      })
    if (url.pathname.endsWith("/approve")) {
      approved = true
      return send({ resourceID: "resource-a", grant, replayed: false })
    }
    if (url.pathname.includes("/requests/"))
      return send({
        requestID: url.pathname.split("/").at(-1),
        state: approved ? "approved" : "missing",
        grant: approved ? grant : null,
      })
    return send({ grants: approved ? [grant] : [], files: [], nextCursor: null })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Original HTTP peer unavailable")
  wiring.sdk = {
    client: createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}` }),
    directory: "/project",
    scope: "shared-file-shell",
  }
  const initial = view()
  const [state, setState] = createStore({
    view: view({ policy: { ...initial.resource.policy, filePolicy: { upload: true, download: true } } }),
  })
  try {
    const service = bridge()
    render(() => (
      <SharedBrowserPreview
        view={state.view}
        bridge={service}
        onUpdate={(next) => setState("view", next)}
        onReturnToSession={() => {}}
      />
    ))
    const toggle = screen.getByRole("button", { name: dict["browser.files.title"] })
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByRole("region", { name: dict["browser.files.title"] })).toBeNull()
    expect(calls).toHaveLength(0)
    fireEvent.click(toggle)
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toMatchObject({ path: "/api/v1/browser/shared/resources/resource-a/files", method: "GET" })
    fireEvent.input(screen.getByLabelText(dict["browser.files.relative"]), { target: { value: "owned.txt" } })
    fireEvent.input(screen.getByLabelText(dict["browser.files.uploadURL"]), {
      target: { value: "https://example.com/upload" },
    })
    fireEvent.click(screen.getByRole("button", { name: dict["browser.files.preview"] }))
    await screen.findByText("a".repeat(64))
    fireEvent.click(screen.getByRole("button", { name: dict["browser.files.approve"] }))
    await screen.findAllByText(/owned\.txt · Approved/)
    expect(calls.filter((call) => call.path.endsWith("/approve"))).toHaveLength(1)
    expect(calls.find((call) => call.path.endsWith("/approve"))?.body).toMatchObject({
      previewID: "shared-file-shell-preview",
      expectedResourceRevision: 1,
      expectedLeaseID: "lease-a",
      expectedLeaseEpoch: 1,
      expectedManualEpoch: 0,
    })
    setState("view", "resource", {
      state: "human_owned",
      manualEpoch: 1,
      revision: 2,
      liveLeaseID: null,
      agentAccessFenced: true,
      manualEnabled: true,
    })
    expect(screen.getByRole("button", { name: dict["browser.files.preview"] })).toHaveProperty("disabled", true)
    // Historical exact approval reconciliation remains available; it cannot mint
    // a new grant under the human-owned lease. New preview/approval stays fenced.
    expect(screen.getByRole("button", { name: dict["browser.files.retryExact"] })).toHaveProperty("disabled", false)
    fireEvent.click(screen.getByRole("button", { name: dict["browser.files.preview"] }))
    expect(calls.filter((call) => call.path.endsWith("/preview"))).toHaveLength(1)
    expect(calls.every((call) => !/\/actions|file\.upload|file\.download/.test(call.path))).toBe(true)
    setState(
      "view",
      view({
        resourceID: "resource-b",
        policy: { ...initial.resource.policy, filePolicy: { upload: true, download: true } },
      }),
    )
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByRole("region", { name: dict["browser.files.title"] })).toBeNull()
  } finally {
    cleanup()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it("approves only manual origins through the trusted bridge and retries the exact unknown request", async () => {
  const service = bridge()
  const calls: SharedBrowserSchema.ApproveOrigin[] = []
  const initial = view({ state: "human_owned", manualEnabled: true, agentAccessFenced: true, liveLeaseID: null, manualEpoch: 1 })
  const [state, setState] = createStore({ view: initial })
  service.approveOrigin = async (input) => {
    calls.push(structuredClone(input))
    if (calls.length === 1) throw new Error("Approval outcome unknown")
    return { resource: { ...initial.resource, revision: initial.resource.revision + 1, policyRevision: 2,
      policy: { ...initial.resource.policy, manualApprovedOrigins: [...initial.resource.policy.manualApprovedOrigins, input.origin] } } }
  }
  render(() => <SharedBrowserPreview view={state.view} bridge={service} onUpdate={(view) => setState("view", view)} onReturnToSession={() => {}} />)
  const field = screen.getByLabelText(dict["browser.shared.policy.title"])
  fireEvent.input(field, { target: { value: "https://second.example" } })
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.policy.approve"] }))
  await waitFor(() => expect(calls).toHaveLength(1))
  await waitFor(() => expect(screen.getByRole("button", { name: dict["browser.files.retryExact"] })).toHaveProperty("disabled", false))
  expect(field).toHaveProperty("disabled", true)
  fireEvent.click(screen.getByRole("button", { name: dict["browser.files.retryExact"] }))
  await waitFor(() => expect(state.view.resource.policyRevision).toBe(2))
  expect(calls[1]).toEqual(calls[0])
  expect(calls[0]).toMatchObject({ expectedRevision: 1, expectedManualEpoch: 1, expectedPolicyHash: initial.resource.policyHash })
  expect(state.view.resource.policy.approvedOrigins).toEqual(initial.resource.policy.approvedOrigins)
  expect(state.view.resource.policy.manualApprovedOrigins).toEqual(["https://example.com", "https://second.example"])
})

it("ignores a manual origin approval after the original browser scope changes", async () => {
  const service = bridge()
  const pending = Promise.withResolvers<SharedBrowserView>()
  const approve = vi.fn(() => pending.promise)
  service.approveOrigin = approve
  const initial = view({ state: "human_owned", manualEnabled: true, agentAccessFenced: true, liveLeaseID: null, manualEpoch: 1 })
  const [state, setState] = createStore({ view: initial })
  const update = vi.fn()
  render(() => <SharedBrowserPreview view={state.view} bridge={service} onUpdate={update} onReturnToSession={() => {}} />)
  fireEvent.input(screen.getByLabelText(dict["browser.shared.policy.title"]), { target: { value: "https://second.example" } })
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.policy.approve"] }))
  await waitFor(() => expect(approve).toHaveBeenCalledTimes(1))
  setState("view", { resource: { ...initial.resource, scope: { ...initial.resource.scope, directory: "/another" } } })
  pending.resolve(initial)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(update).not.toHaveBeenCalled()
})

it("releases a manual origin draft only after trusted Main confirms that exact request did not commit", async () => {
  const service = bridge()
  const initial = view({ state: "human_owned", manualEnabled: true, agentAccessFenced: true, liveLeaseID: null, manualEpoch: 1 })
  const [state, setState] = createStore({ view: initial })
  const cancelled = { value: false }
  const cancel = vi.fn(async () => ({ view: initial, cancelled: cancelled.value }))
  service.cancelOrigin = cancel
  service.approveOrigin = vi.fn(async () => { throw new Error("Unknown acknowledgement") })
  render(() => <SharedBrowserPreview view={state.view} bridge={service} onUpdate={(view) => setState("view", view)} onReturnToSession={() => {}} />)
  const field = screen.getByLabelText(dict["browser.shared.policy.title"])
  fireEvent.input(field, { target: { value: "https://first.example" } })
  fireEvent.click(screen.getByRole("button", { name: dict["common.cancel"] }))
  expect(field).toHaveProperty("value", "")
  expect(service.approveOrigin).not.toHaveBeenCalled()
  fireEvent.input(field, { target: { value: "https://second.example" } })
  fireEvent.click(screen.getByRole("button", { name: dict["browser.shared.policy.approve"] }))
  await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(screen.getByRole("button", { name: dict["common.cancel"] })).toHaveProperty("disabled", false))
  expect(field).toHaveProperty("disabled", true)
  fireEvent.click(screen.getByRole("button", { name: dict["common.cancel"] }))
  await waitFor(() => expect(cancel).toHaveBeenCalledTimes(2))
  expect(field).toHaveProperty("disabled", true)
  cancelled.value = true
  fireEvent.click(screen.getByRole("button", { name: dict["common.cancel"] }))
  await waitFor(() => expect(field).toHaveProperty("disabled", false))
  expect(cancel.mock.calls[2]).toEqual(cancel.mock.calls[0])
})
