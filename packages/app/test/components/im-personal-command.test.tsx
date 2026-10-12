import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { PersonalCommandEditor, type PersonalCommandClient } from "@/components/im/personal-command-editor"
import { createDacDraft, createDacDrafts, parseDacCommand, type DacCommand } from "@/components/im/personal-command"
import { MessageComposer } from "@/components/im/message-composer"
import { dict } from "@/i18n/en"

vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
vi.mock("@deepagent-code/ui/dialog", () => ({ Dialog: (props: { children: unknown }) => props.children }))
afterEach(cleanup)

const binding = {
  version: 1 as const,
  groupID: "conversation",
  bindingID: null,
  sessionID: null,
  directory: "/owned/project",
  workspaceID: null,
  projectID: "project",
}
const command: DacCommand = {
  ...binding,
  bindingID: "binding",
  sessionID: "session",
  commandID: "command",
  inputID: "input",
  delivery: "queue",
  state: "admitted",
  activityID: null,
  finalMessageID: null,
  replyStatus: null,
}
function client() {
  const scope = {}
  return {
    scope: () => scope,
    dacBinding: vi.fn<PersonalCommandClient["dacBinding"]>(async () => binding),
    dacSubmit: vi.fn<PersonalCommandClient["dacSubmit"]>(async (_group, input) => ({
      ...command,
      commandID: input.commandID,
    })),
    dacCommand: vi.fn<PersonalCommandClient["dacCommand"]>(async () => command),
  } satisfies PersonalCommandClient
}

it("only the exact owner-input command activates DAC and incoming-looking text stays ordinary", () => {
  expect(parseDacCommand("/dac")).toBe("")
  expect(parseDacCommand("/dac\nread the project")).toBe("\nread the project")
  for (const text of ["/dact", "quoted /dac do it", "@dac do it", "```/dac do it```", " /dac do it"])
    expect(parseDacCommand(text)).toBeUndefined()
})

it("retains original ambiguous submissions at capacity instead of evicting or minting new identity", () => {
  const drafts = createDacDrafts()
  const original = drafts("original")!
  original.setState("pending", { commandID: "original-command", text: "original", delivery: "queue" })
  for (let i = 0; i < 31; i++) expect(drafts(`other-${i}`)).toBeDefined()
  expect(drafts("full")).toBeUndefined()
  expect(drafts("original")).toBe(original)
  expect(original.state.pending?.commandID).toBe("original-command")
})

it("empty DAC and a reference open a private editable draft without input admission", async () => {
  const api = client()
  const draft = createDacDraft()
  draft.setState("reference", { id: "source", content: "Quoted instruction" })
  render(() => (
    <PersonalCommandEditor
      client={api}
      groupID="conversation"
      draft={draft}
      current={() => true}
      open={vi.fn()}
      close={vi.fn()}
    />
  ))
  await waitFor(() => expect(api.dacBinding).toHaveBeenCalledTimes(1))
  expect(api.dacSubmit).not.toHaveBeenCalled()
  expect(screen.getByText("Quoted instruction")).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>("button", { name: dict["im.dac.send"] }).disabled).toBe(true)
})

it("submits one queue command directly with its reference then opens the real ordinary Session", async () => {
  const api = client()
  const draft = createDacDraft()
  const open = vi.fn()
  draft.setState({ text: "Read and test", reference: { id: "source", content: "quote" } })
  render(() => (
    <PersonalCommandEditor
      client={api}
      groupID="conversation"
      draft={draft}
      current={() => true}
      autoSubmit
      open={open}
      close={vi.fn()}
    />
  ))
  await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
  expect(api.dacSubmit).toHaveBeenCalledTimes(1)
  expect(api.dacSubmit.mock.calls[0]?.[1]).toMatchObject({
    text: "Read and test",
    delivery: "queue",
    referenceMessageIDs: ["source"],
  })
  expect(open.mock.calls[0]?.[0]).toMatchObject({ sessionID: "session", directory: "/owned/project" })
  expect(draft.state.pending).toBeUndefined()
})

it("unknown transport retains exact command identity and changing scope rejects late navigation", async () => {
  const api = client()
  const draft = createDacDraft()
  const open = vi.fn()
  draft.setState("text", "Original request")
  api.dacSubmit.mockRejectedValueOnce(new Error("transport closed"))
  const view = render(() => (
    <PersonalCommandEditor
      client={api}
      groupID="conversation"
      draft={draft}
      current={() => true}
      autoSubmit
      open={open}
      close={vi.fn()}
    />
  ))
  await screen.findByText(dict["im.dac.unknown"])
  const original = draft.state.pending?.commandID
  expect(original).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: dict["im.dac.retry"] }))
  await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
  expect(api.dacSubmit.mock.calls[1]?.[1].commandID).toBe(original)
  view.unmount()

  const late = Promise.withResolvers<DacCommand>()
  const second = createDacDraft()
  second.setState("text", "Second request")
  api.dacSubmit.mockImplementationOnce(() => late.promise)
  const captured = api.scope()
  const other = {}
  api.scope = () => captured
  const next = render(() => (
    <PersonalCommandEditor
      client={api}
      groupID="conversation"
      draft={second}
      current={() => true}
      autoSubmit
      open={open}
      close={vi.fn()}
    />
  ))
  await waitFor(() => expect(second.state.pending).toBeDefined())
  api.scope = () => other
  late.resolve({ ...command, commandID: second.state.pending!.commandID })
  await Promise.resolve()
  expect(open).toHaveBeenCalledTimes(1)
  expect(second.state.pending).toBeDefined()
  next.unmount()
})

it("the actual IM composer never publishes DAC command text as an ordinary message", async () => {
  const send = vi.fn()
  const dac = vi.fn()
  render(() => <MessageComposer agents={[]} onSend={send} onDac={dac} />)
  const input = screen.getByRole("textbox")
  fireEvent.input(input, { target: { value: "/dac read the project" } })
  fireEvent.keyDown(input, { key: "Enter" })
  await waitFor(() => expect(dac).toHaveBeenCalledWith(" read the project", "queue"))
  expect(send).not.toHaveBeenCalled()
  fireEvent.input(input, { target: { value: "ordinary message" } })
  fireEvent.keyDown(input, { key: "Enter" })
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
})

it("explicit steer and new-session choice use the original submit body without publishing to IM", async () => {
  const api = client()
  api.dacBinding.mockResolvedValue({ ...binding, bindingID: "original-binding", sessionID: "original-session" })
  const draft = createDacDraft()
  draft.setState("text", "Supplement the current operation")
  render(() => (
    <PersonalCommandEditor
      client={api}
      groupID="conversation"
      draft={draft}
      current={() => true}
      open={vi.fn()}
      close={vi.fn()}
    />
  ))
  await screen.findByRole("checkbox")
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "steer" } })
  fireEvent.click(screen.getByRole("checkbox"))
  fireEvent.click(screen.getByRole("button", { name: dict["im.dac.send"] }))
  await waitFor(() => expect(api.dacSubmit).toHaveBeenCalledOnce())
  expect(api.dacSubmit.mock.calls[0]?.[1]).toMatchObject({ delivery: "steer", newSession: true })
})

it("only an explicit not-admitted response releases the exact payload for editing", async () => {
  const { IMFacadeRequestError } = await import("@/utils/im-client")
  const api = client()
  api.dacSubmit.mockRejectedValueOnce(new IMFacadeRequestError("reference_unavailable", "not admitted", 409, true))
  const draft = createDacDraft()
  draft.setState("text", "Original request")
  render(() => (
    <PersonalCommandEditor
      client={api}
      groupID="conversation"
      draft={draft}
      current={() => true}
      autoSubmit
      open={vi.fn()}
      close={vi.fn()}
    />
  ))
  await screen.findByRole("alert")
  expect(draft.state.pending).toBeUndefined()
  expect(screen.getByRole<HTMLTextAreaElement>("textbox").disabled).toBe(false)
  expect(draft.state.text).toBe("Original request")
})

it("a remounted ambiguous command reconciles admission without a second submit", async () => {
  const api = client()
  api.dacCommand.mockResolvedValue({ ...command, commandID: "original-command" })
  const draft = createDacDraft()
  draft.setState({
    text: "Original request",
    pending: { commandID: "original-command", text: "Original request", delivery: "queue" },
  })
  render(() => (
    <PersonalCommandEditor
      client={api}
      groupID="conversation"
      draft={draft}
      current={() => true}
      autoSubmit
      open={vi.fn()}
      close={vi.fn()}
    />
  ))
  await waitFor(() => expect(draft.state.command?.state).toBe("admitted"))
  expect(draft.state.pending).toBeUndefined()
  expect(draft.state.text).toBe("")
  expect(api.dacSubmit).not.toHaveBeenCalled()
})

it("refreshing a previous admitted receipt never clears a newly entered command or reference", async () => {
  const api = client()
  const draft = createDacDraft()
  draft.setState({
    command,
    text: "  New command\n",
    reference: { id: "new-source", content: "new quote" },
    newSession: true,
  })
  render(() => (
    <PersonalCommandEditor
      client={api}
      groupID="conversation"
      draft={draft}
      current={() => true}
      open={vi.fn()}
      close={vi.fn()}
    />
  ))
  await waitFor(() => expect(api.dacCommand).toHaveBeenCalledOnce())
  expect(draft.state.text).toBe("  New command\n")
  expect(draft.state.reference?.id).toBe("new-source")
  expect(draft.state.newSession).toBe(true)
  expect(api.dacSubmit).not.toHaveBeenCalled()
})

it("a refused private draft keeps the owner's text and never falls back to ordinary IM send", async () => {
  const send = vi.fn()
  const dac = vi.fn(() => false)
  render(() => <MessageComposer agents={[]} onSend={send} onDac={dac} />)
  const input = screen.getByRole<HTMLTextAreaElement>("textbox")
  fireEvent.input(input, { target: { value: "/dac keep this request" } })
  fireEvent.keyDown(input, { key: "Enter" })
  await waitFor(() => expect(dac).toHaveBeenCalledOnce())
  expect(input.value).toBe("/dac keep this request")
  expect(send).not.toHaveBeenCalled()
})

it("an unavailable binding finishes loading and explicit refresh only reads before a normal send", async () => {
  const { IMFacadeRequestError } = await import("@/utils/im-client")
  const api = client()
  const retry = Promise.withResolvers<typeof binding>()
  api.dacBinding
    .mockRejectedValueOnce(new IMFacadeRequestError("binding_unavailable", "not readable", 409))
    .mockImplementationOnce(() => retry.promise)
  const draft = createDacDraft()
  const open = vi.fn()
  draft.setState("text", "  Original private request\n")
  render(() => (
    <PersonalCommandEditor
      client={api}
      groupID="conversation"
      draft={draft}
      current={() => true}
      autoSubmit
      open={open}
      close={vi.fn()}
    />
  ))
  expect((await screen.findByRole("alert")).textContent).toBe(dict["im.dac.error.unavailable"])
  expect(screen.queryByText(dict["im.dac.loading"])).toBeNull()
  expect(api.dacSubmit).not.toHaveBeenCalled()
  expect(draft.state.pending).toBeUndefined()
  expect(draft.state.text).toBe("  Original private request\n")
  fireEvent.click(screen.getByRole("button", { name: dict["common.refresh"] }))
  await waitFor(() => expect(api.dacBinding).toHaveBeenCalledTimes(2))
  expect(screen.getByText(dict["im.dac.loading"])).toBeTruthy()
  expect(screen.queryByRole("button", { name: dict["common.refresh"] })).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>("button", { name: dict["im.dac.send"] }).disabled).toBe(true)
  retry.resolve(binding)
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>("button", { name: dict["im.dac.send"] }).disabled).toBe(false),
  )
  expect(api.dacSubmit).not.toHaveBeenCalled()
  expect(draft.state.text).toBe("  Original private request\n")
  fireEvent.click(screen.getByRole("button", { name: dict["im.dac.send"] }))
  await waitFor(() => expect(open).toHaveBeenCalledOnce())
  expect(api.dacSubmit).toHaveBeenCalledOnce()
  expect(api.dacSubmit.mock.calls[0]?.[1].text).toBe("  Original private request\n")
})

it("an actual command conflict keeps the original pending identity and conflict feedback", async () => {
  const { IMFacadeRequestError } = await import("@/utils/im-client")
  const api = client()
  api.dacSubmit.mockRejectedValueOnce(new IMFacadeRequestError("command_conflict", "conflict", 409))
  const draft = createDacDraft()
  const open = vi.fn()
  draft.setState("text", "Original private request")
  render(() => (
    <PersonalCommandEditor
      client={api}
      groupID="conversation"
      draft={draft}
      current={() => true}
      autoSubmit
      open={open}
      close={vi.fn()}
    />
  ))
  expect((await screen.findByRole("alert")).textContent).toBe(dict["im.dac.error.conflict"])
  expect(draft.state.pending?.commandID).toBe(api.dacSubmit.mock.calls[0]?.[1].commandID)
  expect(draft.state.pending?.text).toBe("Original private request")
  expect(screen.getByRole<HTMLTextAreaElement>("textbox").disabled).toBe(true)
  expect(screen.queryByRole("button", { name: dict["common.refresh"] })).toBeNull()
  expect(open).not.toHaveBeenCalled()
  expect(api.dacSubmit).toHaveBeenCalledOnce()
})
