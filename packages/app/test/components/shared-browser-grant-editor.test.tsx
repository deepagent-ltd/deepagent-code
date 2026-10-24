import { createHash } from "node:crypto"
import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { prepareBrowserScriptGrant } from "@/components/browser-script-grant"
import { SharedBrowserGrantEditor, type SharedBrowserGrantDraft } from "@/components/shared-browser-grant-editor"
import { dict } from "@/i18n/en"

vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
afterEach(cleanup)

function draft(): SharedBrowserGrantDraft {
  return {
    source: "(args, page) => page",
    argsJSON: ' { "value": 1 } ',
    scriptMode: "program",
    programOperations: ["fill", "click"],
    programSteps: "4",
    filePolicy: { upload: false, download: false },
  }
}

it("shares exact-byte WebCrypto grants without normalizing JSON or allowing mutation during hashing", async () => {
  const input = draft()
  const original = structuredClone(input)
  const pending = prepareBrowserScriptGrant(input, { script: "script", program: "program" })
  input.source = "different source"
  input.argsJSON = "null"
  input.programOperations.push("drag")
  input.programSteps = "16"
  expect(await pending).toEqual({
    source: original.source,
    argsJSON: original.argsJSON,
    scriptHash: createHash("sha256").update(original.source).digest("hex"),
    argsHash: createHash("sha256").update(original.argsJSON).digest("hex"),
    mode: "program",
    operations: original.programOperations,
    maxSteps: 4,
  })
  const bounded = { ...draft(), source: "é".repeat(4096), argsJSON: JSON.stringify("é".repeat(4095)) }
  expect((await prepareBrowserScriptGrant(bounded, { script: "script", program: "program" }))?.source).toBe(
    bounded.source,
  )
  for (const change of [
    { source: bounded.source + "a" },
    { argsJSON: bounded.argsJSON + " " },
    { argsJSON: "{" },
    { source: "\ud800" },
  ])
    await expect(
      prepareBrowserScriptGrant({ ...draft(), ...change }, { script: "script", program: "program" }),
    ).rejects.toThrow("script")
  for (const change of [
    { programSteps: "17" },
    { programSteps: "1.5" },
    { programOperations: [] },
    { programOperations: ["fill", "fill"] as const },
  ])
    await expect(
      prepareBrowserScriptGrant(
        { ...draft(), ...change, programOperations: [...(change.programOperations ?? draft().programOperations)] },
        { script: "script", program: "program" },
      ),
    ).rejects.toThrow("program")
})

it("edits the snapshot-only shared grant form and freezes the complete draft without issuing permissions", () => {
  const [state, setState] = createStore({ draft: draft(), frozen: false })
  const changes = vi.fn((value: Partial<SharedBrowserGrantDraft>) => setState("draft", value))
  render(() => (
    <SharedBrowserGrantEditor draft={state.draft} id="shared-test" disabled={state.frozen} onChange={changes} />
  ))
  expect(screen.getByText(dict["browser.shared.scriptContextHint"])).toBeDefined()
  expect(screen.getByText(dict["browser.shared.filePolicyHint"])).toBeDefined()
  expect(screen.queryByRole("button", { name: dict["browser.shared.create"] })).toBeNull()
  expect(screen.queryByRole("button", { name: dict["browser.files.approve"] })).toBeNull()
  fireEvent.input(screen.getByLabelText(dict["browser.control.scriptArgs"]), { target: { value: ' {"next": 2} ' } })
  fireEvent.click(screen.getByRole("checkbox", { name: dict["browser.files.upload"] }))
  fireEvent.click(screen.getByRole("checkbox", { name: dict["browser.control.program.operation.drag"] }))
  expect(state.draft.argsJSON).toBe(' {"next": 2} ')
  expect(state.draft.filePolicy).toEqual({ upload: true, download: false })
  expect(state.draft.programOperations).toEqual(["fill", "click", "drag"])
  setState("frozen", true)
  const original = structuredClone({
    ...state.draft,
    filePolicy: { ...state.draft.filePolicy },
    programOperations: [...state.draft.programOperations],
  })
  changes.mockClear()
  fireEvent.input(screen.getByLabelText(dict["browser.control.scriptSource"]), { target: { value: "changed" } })
  fireEvent.input(screen.getByLabelText(dict["browser.control.program.steps"]), { target: { value: "16" } })
  fireEvent.click(screen.getByRole("checkbox", { name: dict["browser.files.download"] }))
  expect(changes).not.toHaveBeenCalled()
  expect(state.draft).toEqual(original)
})
