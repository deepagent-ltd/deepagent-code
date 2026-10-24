import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { Dialog } from "@kobalte/core/dialog"
import { DialogSelectDirectory } from "@/components/dialog-select-directory"
import { dict } from "@/i18n/en"

const list = vi.hoisted(() => vi.fn())
vi.mock("@/context/global", () => ({
  useGlobal: () => ({
    createServerCtx: () => ({
      sync: { data: { path: { home: "/isolated/home", directory: "/isolated/home" } } },
      sdk: { client: { file: { list }, find: { files: async () => ({ data: [] }) } } },
      projects: { list: () => [] },
    }),
  }),
}))
vi.mock("@deepagent-code/ui/context/dialog", async (original) => ({
  ...(await original<typeof import("@deepagent-code/ui/context/dialog")>()),
  useDialog: () => ({ close: vi.fn() }),
}))
vi.mock("@deepagent-code/ui/context/i18n", () => ({ useI18n: () => ({ t: () => "Close" }) }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
afterEach(cleanup)

it("opens an absolute directory without booting a forbidden filesystem-root instance", async () => {
  list.mockImplementation(async ({ directory }: { directory: string }) => {
    if (directory === "/") throw new Error("filesystem root is forbidden")
    if (directory !== "/private/tmp/preview") return { data: [] }
    return { data: [{ name: "project", absolute: "/private/tmp/preview/project", type: "directory" }] }
  })
  const select = vi.fn()
  render(() => (
    <Dialog open>
      <DialogSelectDirectory server={{ type: "http", http: { url: "http://localhost:4595" } }} onSelect={select} />
    </Dialog>
  ))
  fireEvent.input(screen.getByRole("textbox"), { target: { value: "/private/tmp/preview/project" } })
  await waitFor(() => expect(screen.getByText("project")).toBeTruthy())
  fireEvent.click(screen.getByText("project"))
  expect(select).toHaveBeenCalledWith("/private/tmp/preview/project")
  expect(list.mock.calls.some(([input]) => input.directory === "/")).toBe(false)
})
