import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { DialogProvider, useDialog } from "@deepagent-code/ui/context/dialog"
import { createDeepAgentCodeClient, type Provider } from "@deepagent-code/sdk/client"
import { PROVIDER_BRANDS, PROVIDER_PRESETS } from "@deepagent-code/core/provider-presets"
import { DialogConnectProvider } from "@/components/dialog-connect-provider"
import { SettingsProvidersV2 } from "@/components/settings-v2/providers"
import { dict } from "@/i18n/en"

const runtime = vi.hoisted(() => ({
  client: undefined as ReturnType<typeof createDeepAgentCodeClient> | undefined,
  sync: (): unknown => ({}),
  toasts: vi.fn(),
}))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    locale: () => "en",
    t: (key: keyof typeof dict, params?: Record<string, string | number>) =>
      (dict[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params?.[name] ?? "")),
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
    auth?: Record<string, { type: "api" | "oauth"; label: string }[]>
  } = {},
) {
  const calls: { method: string; path: string; body?: unknown }[] = []
  const all = new Map<string, Provider>(
    PROVIDER_PRESETS.map((preset) => [
      preset.id,
      {
        id: preset.id,
        name: preset.name,
        env: [...preset.env],
        models: {},
        options: {},
        source: "api",
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
        if (path === "/auth/deepagent" && input.failure)
          return Response.json({ message: "Credential storage unavailable" }, { status: 503 })
        if (path.startsWith("/auth/")) return Response.json(true)
        if (path === "/global/config") return Response.json({})
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
      config: {},
      provider: { all, default: {}, connected: input.connected ?? [], errors: [] },
      provider_auth: input.auth ?? {},
    },
    updateConfig: (config: Record<string, unknown>) => client.global.config.update({ config }, { throwOnError: true }),
    refreshProviders: refresh,
    set: vi.fn(),
  })
  return { all, calls, refresh }
}

beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

it("shows all ten preset brands, independent API/plan/region choices and a custom entry without claiming loaded models", () => {
  fixture()
  render(() => (
    <DialogProvider>
      <SettingsProvidersV2 />
    </DialogProvider>
  ))
  for (const brand of PROVIDER_BRANDS) expect(screen.getByRole("region", { name: brand.name })).toBeTruthy()
  const alibaba = screen.getByRole("region", { name: "Alibaba Cloud Bailian" })
  expect(within(alibaba).getByText("Alibaba Coding Plan (China)")).toBeTruthy()
  expect(within(alibaba).getByText("Alibaba Coding Plan")).toBeTruthy()
  expect(within(alibaba).getByText("Alibaba (China)")).toBeTruthy()
  expect(within(alibaba).getAllByText(dict["settings.providers.catalogPending"])).toHaveLength(4)
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
  expect(screen.getAllByText("DeepAgent API")).toHaveLength(1)
  const connected = document.querySelector('[data-component="connected-providers-section"]')
  if (!connected) throw new Error("Connected providers section missing")
  expect(within(connected as HTMLElement).getByText("DeepAgent API")).toBeTruthy()
  expect(within(connected as HTMLElement).getByRole("button", { name: dict["common.disconnect"] })).toBeTruthy()
})

it("submits DeepAgent credentials through the real generated SDK route without hidden URL rejection or model requests", async () => {
  const fixture = fixtureForDeepAgent()
  const user = userEvent.setup()
  const input = await screen.findByRole("textbox", { name: /API key/i })
  await user.type(input, "test-only-key")
  fireEvent.submit(input.closest("form")!)
  await waitFor(() => expect(fixture.calls.some((call) => call.path === "/global/dispose")).toBe(true))
  expect(fixture.calls.find((call) => call.path === "/auth/deepagent")).toEqual({
    method: "PUT",
    path: "/auth/deepagent",
    body: { type: "api", key: "test-only-key" },
  })
  expect(fixture.calls.filter((call) => call.path.startsWith("/auth/"))).toHaveLength(1)
  expect(fixture.refresh).toHaveBeenCalledTimes(1)
  expect(runtime.toasts).toHaveBeenCalledWith(
    expect.objectContaining({ title: dict["provider.connect.toast.saved.title"] }),
  )
  expect(fixture.calls.some((call) => /models|messages|responses/.test(call.path))).toBe(false)
})

it("reports actual credential persistence failure and does not save config, dispose or report success", async () => {
  const fixture = fixtureForDeepAgent(true)
  const input = await screen.findByRole("textbox", { name: /API key/i })
  await userEvent.setup().type(input, "test-only-key")
  fireEvent.submit(input.closest("form")!)
  await waitFor(() =>
    expect(runtime.toasts).toHaveBeenCalledWith(expect.objectContaining({ title: dict["common.requestFailed"] })),
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
    const input = await screen.findByRole("textbox", { name: /API key/i })
    await userEvent.setup().type(input, "selected-product-test-key")
    fireEvent.submit(input.closest("form")!)
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

function fixtureForDeepAgent(failure = false) {
  const data = fixture({ failure })
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
