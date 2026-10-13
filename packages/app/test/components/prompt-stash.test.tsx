import { afterEach, expect, it, vi } from "vitest"
import { cleanup, render } from "@solidjs/testing-library"
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router"
import { createStore } from "solid-js/store"
import { PlatformProvider } from "@/context/platform"
import type { Prompt } from "@/context/prompt"
import { createPromptStash } from "@/pages/session/prompt-stash"
import { ServerScope } from "@/utils/server-scope"

vi.mock("@/context/server-sdk", () => ({ useServerSDK: () => ({ scope: ServerScope.local }) }))
afterEach(cleanup)

it("clones the original reactive composer draft without retaining its Solid proxy or later edits", () => {
  const owner = { stash: undefined as ReturnType<typeof createPromptStash> | undefined }
  const [draft, setDraft] = createStore<Prompt>([{ type: "text", content: "隔离草稿\n第一行", start: 0, end: 8 }])
  const history = createMemoryHistory()
  history.set({ value: `/owned-${crypto.randomUUID()}` })
  function Probe() {
    owner.stash = createPromptStash()
    return <output>ready</output>
  }
  render(() => (
    <MemoryRouter history={history}>
      <Route
        path="/:dir"
        component={() => (
          <PlatformProvider
            value={{
              platform: "web",
              openLink() {},
              restart: async () => {},
              back() {},
              forward() {},
              notify: async () => {},
            }}
          >
            <Probe />
          </PlatformProvider>
        )}
      />
    </MemoryRouter>
  ))
  const stash = owner.stash
  if (!stash) throw new Error("The original workspace stash was not mounted")
  expect(() => stash.push(draft)).not.toThrow()
  expect(stash.list()).toHaveLength(1)
  setDraft(0, { type: "text", content: "后续编辑", start: 0, end: 8 })
  expect(stash.list()[0].prompt[0]).toEqual({ type: "text", content: "隔离草稿\n第一行", start: 0, end: 8 })
  stash.push(draft)
  expect(stash.pop()?.prompt[0]).toEqual({ type: "text", content: "后续编辑", start: 0, end: 8 })
  expect(stash.pop()?.prompt[0]).toEqual({ type: "text", content: "隔离草稿\n第一行", start: 0, end: 8 })
  expect(stash.list()).toHaveLength(0)
})
