import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { DialogProvider, useDialog } from "@deepagent-code/ui/context/dialog"
import { createDeepAgentCodeClient, type Provider } from "@deepagent-code/sdk/client"
import { PROVIDER_SUPPLIERS, PROVIDER_PRESETS } from "@deepagent-code/core/provider-presets"
import { DialogConnectProvider } from "@/components/dialog-connect-provider"
import { DialogConnectSupplier } from "@/components/dialog-connect-supplier"
import { SettingsProvidersV2 } from "@/components/settings-v2/providers"
import { dict } from "@/i18n/en"

const runtime = vi.hoisted(() => ({
  client: undefined as ReturnType<typeof createDeepAgentCodeClient> | undefined,
  sync: (): unknown => ({}),
  toasts: vi.fn(),
  dictionary: undefined as Record<string, string> | undefined,
  locale: "en",
}))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    locale: () => runtime.locale,
    t: (key: keyof typeof dict, params?: Record<string, string | number>) =>
      (runtime.dictionary?.[key] ?? dict[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
        String(params?.[name] ?? ""),
      ),
  }),
}))
vi.mock("@solidjs/router", () => ({ useParams: () => ({}) }))
vi.mock("@/context/server-sync", () => ({ useServerSync: () => runtime.sync() }))
vi.mock("@/context/server-sdk", () => ({ useServerSDK: () => ({ client: runtime.client }) }))
vi.mock("@/utils/toast", () => ({ showToast: (...args: unknown[]) => runtime.toasts(...args) }))

function fixture(
  input: {
    connected?: string[]
    failure?: boolean
    discovery?: "failure" | "empty"
    discoveryStatus?: number | "timeout"
    delayedDiscovery?: boolean
    preferencesFailure?: boolean
    source?: "api" | "env" | "config"
    config?: Record<string, unknown>
    catalogIDs?: string[]
    auth?: Record<string, { type: "api" | "oauth"; label: string }[]>
  } = {},
) {
  const calls: { method: string; path: string; body?: unknown }[] = []
  const pending = {
    release: undefined as (() => void) | undefined,
    signal: undefined as AbortSignal | undefined,
    configWrites: 0,
  }
  const all = new Map<string, Provider>(
    PROVIDER_PRESETS.map((preset) => [
      preset.id,
      {
        id: preset.id,
        name: preset.name,
        env: [...preset.env],
        models: Object.fromEntries((input.catalogIDs ?? []).map((id) => [id, { id, name: id }])) as Provider["models"],
        options: {},
        source: input.source ?? "api",
      },
    ]),
  )
  const client = createDeepAgentCodeClient({
    baseUrl: "https://fixture.invalid",
    fetch: Object.assign(
      async (requestInput: RequestInfo | URL) => {
        const request = requestInput instanceof Request ? requestInput : new Request(requestInput)
        const path = new URL(request.url).pathname
        const body = ["PUT", "PATCH", "POST"].includes(request.method) ? await request.text() : ""
        calls.push({ method: request.method, path, ...(body ? { body: JSON.parse(body) as unknown } : {}) })
        if (path === "/provider/auth") return Response.json(input.auth ?? {})
        if (path === "/provider/models/discover") {
          pending.signal = request.signal
          if (input.delayedDiscovery)
            await new Promise<void>((resolve) => {
              pending.release = resolve
            })
          if (input.discovery === "failure")
            return Response.json({ message: "Remote credential rejected" }, { status: 400 })
          if (input.discoveryStatus)
            return Response.json(
              {
                message:
                  input.discoveryStatus === "timeout"
                    ? "model discovery timed out after 15000ms"
                    : `model discovery failed: HTTP ${input.discoveryStatus}`,
              },
              { status: 400 },
            )
          const payload = JSON.parse(body) as { providerID: string; baseURL: string; kind: string }
          const models =
            input.discovery === "empty"
              ? []
              : [
                  { id: "verified-one", name: "Verified one" },
                  { id: "verified-two", name: "Verified two" },
                ]
          return Response.json({ ...payload, models, selected: models[0] })
        }
        if (path === "/auth/deepagent" && input.failure)
          return Response.json({ message: "Credential storage unavailable" }, { status: 503 })
        if (path.startsWith("/auth/")) return Response.json(true)
        if (path === "/global/config") {
          pending.configWrites++
          if (input.preferencesFailure && pending.configWrites === 1)
            return Response.json({ message: "Preferences storage unavailable" }, { status: 503 })
          return Response.json({})
        }
        if (path === "/global/dispose") return Response.json(true)
        throw new Error(`Unexpected network request: ${request.method} ${path}`)
      },
      {
        preconnect: () => {
          throw new Error("In-memory HTTP transport has no sockets")
        },
      },
    ),
  })
  const refresh = vi.fn()
  runtime.client = client
  runtime.sync = () => ({
    data: {
      config: input.config ?? {},
      provider: { all, default: {}, connected: input.connected ?? [], errors: [] },
      provider_auth: input.auth ?? {},
    },
    updateConfig: (config: Record<string, unknown>) => client.global.config.update({ config }, { throwOnError: true }),
    refreshProviders: refresh,
    set: vi.fn(),
  })
  return { all, calls, refresh, pending }
}

beforeEach(() => {
  vi.clearAllMocks()
  runtime.dictionary = undefined
  runtime.locale = "en"
})
afterEach(cleanup)

it("uses localized protocol and one API qualifier in the Chinese DeepAgent credential form", async () => {
  const chinese = await import("@/i18n/zh")
  runtime.dictionary = chinese.dict
  runtime.locale = "zh"
  const data = fixtureForDeepAgent()
  expect(await screen.findByLabelText("DeepAgent API 密钥")).toBeTruthy()
  expect(
    screen.getByText("输入你的 DeepAgent API 密钥以连接帐户，并在 DeepAgent Code 中使用 DeepAgent 模型。"),
  ).toBeTruthy()
  expect(screen.getByText("协议")).toBeTruthy()
  expect(screen.queryByText("Protocol")).toBeNull()
  expect(screen.queryByText(/DeepAgent API API/)).toBeNull()
  expect(data.calls.every((call) => call.path === "/provider/auth")).toBe(true)
  expect(data.all.get("deepagent")?.name).toBe("DeepAgent API")
})

it("shows one connect card per regional supplier instead of listing each API and plan identity", () => {
  fixture()
  render(() => (
    <DialogProvider>
      <SettingsProvidersV2 />
    </DialogProvider>
  ))
  for (const supplier of PROVIDER_SUPPLIERS) {
    const cards = document.querySelectorAll<HTMLElement>(`[data-supplier="${supplier.id}"]`)
    expect(cards).toHaveLength(1)
    expect(within(cards[0]).getAllByRole("button", { name: dict["common.connect"] })).toHaveLength(1)
  }
  expect(document.querySelectorAll("[data-supplier]")).toHaveLength(13)
  expect(screen.getByText(dict["provider.custom.title"])).toBeTruthy()
  expect(screen.getByText(dict["settings.providers.connected.empty"])).toBeTruthy()
})

it("keeps a connected DeepAgent manageable and removes its redundant recommended connect entry", () => {
  fixture({ connected: ["deepagent"] })
  render(() => (
    <DialogProvider>
      <SettingsProvidersV2 />
    </DialogProvider>
  ))
  expect(document.querySelectorAll('[data-supplier="deepagent"]')).toHaveLength(1)
  const connected = document.querySelector('[data-component="connected-providers-section"]')
  if (!connected) throw new Error("Connected providers section missing")
  expect(within(connected as HTMLElement).getByRole("button", { name: dict["settings.providers.manage"] })).toBeTruthy()
  expect(within(connected as HTMLElement).getByRole("button", { name: dict["common.disconnect"] })).toBeTruthy()
})

it("probes DeepAgent before saving any credential and confirms the selected remotely returned models", async () => {
  const fixture = fixtureForDeepAgent(false, ["old-catalog-only"])
  const user = userEvent.setup()
  const input = await screen.findByLabelText(/API key/i)
  expect(input.getAttribute("type")).toBe("password")
  await user.type(input, "test-only-key")
  fireEvent.submit(input.closest("form")!)
  const second = await screen.findByRole("checkbox", { name: /Verified two/ })
  expect(fixture.calls.filter((call) => call.path.startsWith("/auth/") || call.path === "/global/config")).toEqual([])
  expect(fixture.calls.find((call) => call.path === "/provider/models/discover")?.body).toEqual({
    providerID: "deepagent",
    baseURL: "https://api.deepagent.ltd/v1",
    apiKey: "test-only-key",
    kind: "openai-compatible",
  })
  fireEvent.click(second)
  fireEvent.click(screen.getByRole("button", { name: dict["provider.connect.models.save"] }))
  await waitFor(() => expect(fixture.calls.some((call) => call.path === "/global/dispose")).toBe(true))
  expect(fixture.calls.find((call) => call.path === "/auth/deepagent")).toEqual({
    method: "PUT",
    path: "/auth/deepagent",
    body: { type: "api", key: "test-only-key" },
  })
  expect(fixture.calls.filter((call) => call.path.startsWith("/auth/"))).toHaveLength(1)
  expect(fixture.calls.find((call) => call.path === "/global/config")?.body).toEqual(
    expect.objectContaining({
      providers: {
        deepagent: {
          models: {
            "old-catalog-only": { disabled: true },
            "verified-one": { disabled: false },
            "verified-two": { disabled: true },
          },
        },
      },
    }),
  )
  expect(fixture.refresh).toHaveBeenCalledTimes(1)
  expect(fixture.calls.filter((call) => call.path === "/provider/models/discover")).toHaveLength(1)
  expect(fixture.calls.some((call) => /messages|responses/.test(call.path))).toBe(false)
})

it("keeps a manual-only Plan inside its original supplier identity with explicit unverified consent", async () => {
  const data = fixture({ discoveryStatus: 404 })
  mountProvider("alibaba-coding-plan")
  const input = await screen.findByLabelText(/API key/i)
  await userEvent.setup().type(input, "plan-test-key")
  fireEvent.submit(input.closest("form")!)
  fireEvent.click(await screen.findByRole("button", { name: dict["provider.connect.models.manual"] }))
  expect(screen.queryByRole("textbox", { name: dict["provider.custom.field.baseURL.label"] })).toBeNull()
  const model = screen.getByRole("textbox", { name: dict["provider.custom.models.id.label"] })
  await userEvent.setup().type(model, "manual-plan-model")
  fireEvent.click(screen.getByRole("button", { name: dict["provider.custom.models.add"] }))
  const save = screen.getByRole("button", { name: dict["provider.connect.models.saveManual"] })
  expect(save.hasAttribute("disabled")).toBe(true)
  expect(data.calls.filter((call) => call.path === "/global/config")).toEqual([])
  fireEvent.click(screen.getByRole("checkbox", { name: dict["provider.connect.models.consent"] }))
  fireEvent.click(save)
  await waitFor(() => expect(data.calls.some((call) => call.path === "/global/dispose")).toBe(true))
  const patch = data.calls.find((call) => call.path === "/global/config")?.body as {
    provider: Record<string, unknown>
    providers: Record<string, unknown>
  }
  expect(Object.keys(patch.provider)).toEqual(["alibaba-coding-plan"])
  expect(patch.provider["alibaba-coding-plan"]).toEqual(
    expect.objectContaining({
      npm: "@ai-sdk/openai-compatible",
      discovery: false,
      options: { baseURL: "https://coding-intl.dashscope.aliyuncs.com/v1", apiKey: "plan-test-key" },
      models: { "manual-plan-model": { name: "manual-plan-model" } },
    }),
  )
  expect(patch.providers).toEqual({ "alibaba-coding-plan": { models: { "manual-plan-model": { disabled: false } } } })
  expect(runtime.toasts).toHaveBeenCalledWith(
    expect.objectContaining({ title: dict["provider.connect.models.manualSaved"] }),
  )
  expect(data.calls.filter((call) => call.path.startsWith("/auth/"))).toEqual([])
})

it.each([401, 403, "timeout"] as const)(
  "does not expose manual bypass for Plan discovery %s",
  async (discoveryStatus) => {
    const data = fixture({ discoveryStatus })
    mountProvider("alibaba-coding-plan")
    const input = await screen.findByLabelText(/API key/i)
    await userEvent.setup().type(input, "rejected-plan-key")
    fireEvent.submit(input.closest("form")!)
    await screen.findByRole("alert")
    expect(screen.queryByRole("button", { name: dict["provider.connect.models.manual"] })).toBeNull()
    expect(data.calls.filter((call) => call.path === "/global/config" || call.path.startsWith("/auth/"))).toEqual([])
  },
)

it("keeps a custom kimi provider separate from the real Kimi supplier and its product entry", () => {
  const data = fixture({ connected: ["kimi"] })
  data.all.set("kimi", { id: "kimi", name: "My custom kimi", env: [], models: {}, options: {}, source: "custom" })
  render(() => (
    <DialogProvider>
      <SettingsProvidersV2 />
    </DialogProvider>
  ))
  const custom = document.querySelector<HTMLElement>('[data-provider-card="kimi"]')!
  const supplier = document.querySelector<HTMLElement>('[data-supplier="kimi"]')!
  expect(custom).toBeTruthy()
  expect(supplier).toBeTruthy()
  expect(custom).not.toBe(supplier)
  expect(within(custom).getByRole("button", { name: dict["settings.providers.manage"] })).toBeTruthy()
  expect(within(supplier).getByRole("button", { name: dict["common.connect"] })).toBeTruthy()
})

it.each(["failure", "empty"] as const)(
  "never persists an existing connection when remote discovery returns %s",
  async (discovery) => {
    const data = fixture({ connected: ["deepagent"], discovery })
    mountProvider("deepagent")
    const input = await screen.findByLabelText(/API key/i)
    await userEvent.setup().type(input, "replacement-test-key")
    fireEvent.submit(input.closest("form")!)
    await screen.findByRole("alert")
    expect(
      data.calls.filter(
        (call) => call.path.startsWith("/auth/") || call.path === "/global/config" || call.path === "/global/dispose",
      ),
    ).toEqual([])
    expect(screen.queryByRole("checkbox")).toBeNull()
  },
)

it.each(["env", "config", "api"] as const)(
  "requires an explicit key instead of borrowing connected %s credentials",
  async (source) => {
    const data = fixture({ connected: ["deepagent"], source })
    mountProvider("deepagent")
    const input = await screen.findByLabelText(/API key/i)
    fireEvent.submit(input.closest("form")!)
    expect((await screen.findByRole("alert")).textContent).toContain(dict["provider.connect.apiKey.required"])
    expect(data.calls.filter((call) => call.path !== "/provider/auth")).toEqual([])
  },
)

it("probes Google with its native discovery kind and retains current native model preferences", async () => {
  const data = fixture({ config: { providers: { google: { models: { "verified-two": { disabled: true } } } } } })
  mountProvider("google")
  const input = await screen.findByLabelText(/API key/i)
  await userEvent.setup().type(input, "google-test-key")
  fireEvent.submit(input.closest("form")!)
  expect((await screen.findByRole<HTMLInputElement>("checkbox", { name: /Verified one/ })).checked).toBe(true)
  expect(screen.getByRole<HTMLInputElement>("checkbox", { name: /Verified two/ }).checked).toBe(false)
  expect(data.calls.find((call) => call.path === "/provider/models/discover")?.body).toEqual({
    providerID: "google",
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "google-test-key",
    kind: "google",
  })
  expect(data.calls.filter((call) => call.path.startsWith("/auth/") || call.path === "/global/config")).toEqual([])
})

it("discloses partial credential save and retries only model preferences after their real SDK failure", async () => {
  const data = fixture({ preferencesFailure: true })
  mountProvider("deepagent")
  const input = await screen.findByLabelText(/API key/i)
  await userEvent.setup().type(input, "test-only-key")
  fireEvent.submit(input.closest("form")!)
  await screen.findByRole("checkbox", { name: /Verified one/ })
  fireEvent.click(screen.getByRole("button", { name: dict["provider.connect.models.save"] }))
  await screen.findByText(new RegExp(dict["provider.connect.models.preferencesFailed"]))
  expect(data.calls.filter((call) => call.path.startsWith("/auth/"))).toHaveLength(1)
  fireEvent.click(screen.getByRole("button", { name: dict["provider.connect.models.save"] }))
  await waitFor(() => expect(data.calls.some((call) => call.path === "/global/dispose")).toBe(true))
  expect(data.calls.filter((call) => call.path.startsWith("/auth/"))).toHaveLength(1)
  expect(data.pending.configWrites).toBe(2)
})

it("cancels after remote discovery without persisting the proposed key or model preferences", async () => {
  const data = fixtureForDeepAgent()
  const input = await screen.findByLabelText(/API key/i)
  await userEvent.setup().type(input, "cancelled-test-key")
  fireEvent.submit(input.closest("form")!)
  await screen.findByRole("checkbox", { name: /Verified one/ })
  fireEvent.click(screen.getByRole("button", { name: dict["common.cancel"] }))
  expect(data.calls.filter((call) => call.path.startsWith("/auth/") || call.path === "/global/config")).toEqual([])
})

it("switches supplier products without retaining keys, pending discovery or a stale model selection", async () => {
  const data = fixture({ delayedDiscovery: true })
  mountSupplier("zhipuai")
  fireEvent.click(await screen.findByRole("button", { name: /^Zhipu AI(?! Coding)/ }))
  const input = await screen.findByLabelText(/API key/i)
  await userEvent.setup().type(input, "api-only-test-key")
  fireEvent.submit(input.closest("form")!)
  await waitFor(() => expect(data.pending.release).toBeTypeOf("function"))
  fireEvent.click(screen.getByRole("button", { name: dict["common.goBack"] }))
  expect(data.pending.signal?.aborted).toBe(true)
  fireEvent.click(screen.getByRole("button", { name: /Zhipu AI Coding Plan/ }))
  expect((await screen.findByLabelText<HTMLInputElement>(/API key/i)).value).toBe("")
  data.pending.release!()
  await waitFor(() => expect(screen.queryByRole("checkbox")).toBeNull())
  expect(data.calls.filter((call) => call.path.startsWith("/auth/") || call.path === "/global/config")).toEqual([])
})

it("reports actual credential persistence failure and does not save config, dispose or report success", async () => {
  const fixture = fixtureForDeepAgent(true)
  const input = await screen.findByLabelText(/API key/i)
  await userEvent.setup().type(input, "test-only-key")
  fireEvent.submit(input.closest("form")!)
  await screen.findByRole("checkbox", { name: /Verified one/ })
  fireEvent.click(screen.getByRole("button", { name: dict["provider.connect.models.save"] }))
  await waitFor(() =>
    expect(
      screen.getAllByRole("alert").some((element) => element.textContent?.includes("Credential storage unavailable")),
    ).toBe(true),
  )
  expect(fixture.calls.some((call) => call.path === "/global/config" || call.path === "/global/dispose")).toBe(false)
  expect(fixture.refresh).not.toHaveBeenCalled()
})

it.each(["openai", "xai"])(
  "keeps %s authentication choices supplied by the existing auth module instead of synthesizing a plan URL",
  async (providerID) => {
    const data = fixture({
      auth: {
        [providerID]: [
          { type: "oauth", label: "Existing subscription OAuth" },
          { type: "api", label: "Existing API key" },
        ],
      },
    })
    mountProvider(providerID)
    expect(await screen.findByText("Existing subscription OAuth")).toBeTruthy()
    expect(screen.getByText(dict["provider.connect.method.apiKey"])).toBeTruthy()
    expect(data.calls.some((call) => call.path.includes("oauth") || call.path.startsWith("/auth/"))).toBe(false)
  },
)

it.each(["zhipuai", "zhipuai-coding-plan", "zai", "zai-coding-plan", "kimi-for-coding"])(
  "keeps explicit %s credentials in that product identity without touching sibling plans",
  async (providerID) => {
    const data = fixture()
    mountProvider(providerID)
    const input = await screen.findByLabelText(/API key/i)
    await userEvent.setup().type(input, "selected-product-test-key")
    fireEvent.submit(input.closest("form")!)
    await screen.findByRole("checkbox", { name: /Verified one/ })
    expect(data.calls.filter((call) => call.path.startsWith("/auth/")).length).toBe(0)
    fireEvent.click(screen.getByRole("button", { name: dict["provider.connect.models.save"] }))
    await waitFor(() => expect(data.calls.some((call) => call.path === "/global/dispose")).toBe(true))
    expect(data.calls.filter((call) => call.path.startsWith("/auth/"))).toEqual([
      { method: "PUT", path: `/auth/${providerID}`, body: { type: "api", key: "selected-product-test-key" } },
    ])
    const patch = data.calls.find((call) => call.path === "/global/config")?.body as {
      provider: Record<string, unknown>
    }
    expect(Object.keys(patch.provider)).toEqual([providerID])
    expect(screen.getByText(PROVIDER_PRESETS.find((item) => item.id === providerID)!.api)).toBeTruthy()
    if (providerID === "kimi-for-coding") expect(screen.getByText("Anthropic Messages")).toBeTruthy()
  },
)

function fixtureForDeepAgent(failure = false, catalogIDs?: string[]) {
  const data = fixture({ failure, catalogIDs })
  mountProvider("deepagent")
  return data
}

function mountProvider(providerID: string) {
  function Caller() {
    const dialog = useDialog()
    return (
      <button onClick={() => void dialog.show(() => <DialogConnectProvider provider={providerID} />)}>
        Open provider
      </button>
    )
  }
  render(() => (
    <DialogProvider>
      <Caller />
    </DialogProvider>
  ))
  fireEvent.click(screen.getByRole("button", { name: "Open provider" }))
}

function mountSupplier(supplier: string) {
  function Caller() {
    const dialog = useDialog()
    return (
      <button onClick={() => void dialog.show(() => <DialogConnectSupplier supplier={supplier} />)}>
        Open supplier
      </button>
    )
  }
  render(() => (
    <DialogProvider>
      <Caller />
    </DialogProvider>
  ))
  fireEvent.click(screen.getByRole("button", { name: "Open supplier" }))
}
