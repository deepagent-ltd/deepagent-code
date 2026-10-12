/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { ServerWebSocket } from "bun"
import { Show, createSignal } from "solid-js"
import { createOpencodeClient } from "@deepagent-code/sdk"
import { IMDacSessionSchema } from "@deepagent-code/core/im/dac-session.schema"
import { useSDK } from "../../../src/context/sdk"
import { createIMClient, type IMGroup } from "../../../src/component/im-client"
import { createIMDacDraft } from "../../../src/component/im-dac-draft"
import { DialogIMChat } from "../../../src/component/dialog-im"
import { DialogIMDac } from "../../../src/component/dialog-im-dac"
import { mountIM, until } from "../../fixture/im-environment"
import { tmpdir } from "../../fixture/fixture"

const group: IMGroup = {
  id: "original-chat",
  workspaceID: "fixture",
  projectID: "original-project",
  type: "direct",
  name: "Original chat",
  createdBy: "self",
  kernelConvID: null,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
}

function fixture(directory: string) {
  const state = {
    sessionID: "original-session",
    workspaceID: null as string | null,
    eligible: true,
    posts: [] as IMDacSessionSchema.Submit[],
    messages: [] as string[],
    commands: new Map<string, IMDacSessionSchema.CommandResponse>(),
    recent: false,
    replyRetries: [] as string[],
    loseReplyResponse: false,
    afterBinding: undefined as (() => void) | undefined,
    calls: [] as {
      method: string
      path: string
      auth: string | null
      directory: string | null
      header: string | null
    }[],
    loseResponse: false,
    beforeResponse: undefined as (() => Promise<void>) | undefined,
    afterSession: undefined as (() => void) | undefined,
    rejection: undefined as { code: string; admitted?: false } | undefined,
    sockets: new Set<ServerWebSocket<undefined>>(),
  }
  const server = Bun.serve({
    port: 0,
    async fetch(request, host) {
      const url = new URL(request.url)
      state.calls.push({
        method: request.method,
        path: url.pathname,
        auth: request.headers.get("authorization"),
        directory: url.searchParams.get("directory"),
        header: request.headers.get("x-deepagent-code-directory"),
      })
      if (url.pathname.startsWith("/ws/")) {
        if (host.upgrade(request)) return
        return new Response("upgrade", { status: 400 })
      }
      const placement = { groupID: group.id, directory, projectID: "original-project", workspaceID: state.workspaceID }
      if (url.pathname === `/api/v1/im/groups/${group.id}/dac`) {
        const response = Response.json({
          version: 1,
          ...placement,
          bindingID: "original-binding",
          sessionID: state.sessionID,
          ...(state.recent ? { recentCommands: [...state.commands.values()].slice(-8).reverse() } : {}),
        })
        state.afterBinding?.()
        return response
      }
      if (url.pathname === `/api/v1/im/groups/${group.id}/dac/commands` && request.method === "POST") {
        const body = (await request.json()) as IMDacSessionSchema.Submit
        state.posts.push(body)
        if (state.rejection)
          return Response.json({ name: "IM_DAC_COMMAND_REJECTED", data: state.rejection }, { status: 409 })
        state.commands.set(body.commandID, {
          version: 1,
          ...placement,
          commandID: body.commandID,
          bindingID: "original-binding",
          sessionID: state.sessionID,
          inputID: `input-${state.posts.length}`,
          delivery: body.delivery,
          state: "admitted",
          activityID: null,
          finalMessageID: null,
          replyStatus: null,
        })
        await state.beforeResponse?.()
        if (state.loseResponse) return Response.json({ code: "response_unavailable" }, { status: 503 })
        return Response.json(state.commands.get(body.commandID))
      }
      if (url.pathname.startsWith(`/api/v1/im/groups/${group.id}/dac/commands/`)) {
        if (request.method === "POST" && url.pathname.endsWith("/reply/retry")) {
          const commandID = url.pathname.split("/").at(-3)!
          state.replyRetries.push(commandID)
          expect(await request.text()).toBe("")
          const command = state.commands.get(commandID)
          if (!command || command.replyStatus !== "dead")
            return Response.json({ code: "reply_unavailable" }, { status: 409 })
          const pending = { ...command, replyStatus: "pending" as const }
          state.commands.set(commandID, pending)
          return state.loseReplyResponse
            ? Response.json({ code: "response_unavailable" }, { status: 503 })
            : Response.json(pending)
        }
        const command = state.commands.get(url.pathname.split("/").at(-1) ?? "")
        return Response.json(command ?? { code: "command_not_found" }, { status: command ? 200 : 404 })
      }
      if (url.pathname.startsWith("/session/") && (url.pathname === "/session/original-session" ||
        [...state.commands.values()].some((command) => `/session/${command.sessionID}` === url.pathname))) {
        state.afterSession?.()
        return Response.json({
          id: url.pathname.slice("/session/".length),
          directory,
          projectID: "original-project",
          workspaceID: state.workspaceID,
          ordinaryEligible: state.eligible,
        })
      }
      if (url.pathname === `/api/v1/im/groups/${group.id}/messages`) {
        if (request.method === "POST") {
          const body = (await request.json()) as { content: string }
          state.messages.push(body.content)
          return Response.json({
            id: "original-message",
            groupID: group.id,
            senderID: "self",
            senderType: "user",
            type: "text",
            content: body.content,
            mentions: null,
            metadata: null,
            replyToID: null,
            createdAt: 1,
            updatedAt: 1,
            deletedAt: null,
          })
        }
        return Response.json({ messages: [], hasMore: false, nextCursor: null })
      }
      return Response.json({ code: "unexpected_path" }, { status: 404 })
    },
    websocket: {
      open(socket) {
        state.sockets.add(socket)
      },
      close(socket) {
        state.sockets.delete(socket)
      },
      message() {},
    },
  })
  const sdk = {
    url: server.url.origin,
    directory,
    client: createOpencodeClient({ baseUrl: server.url.origin, headers: { Authorization: "Basic fixture-only" } }),
  }
  return {
    state,
    server,
    sdk,
    client: createIMClient(sdk),
    [Symbol.dispose]() {
      server.stop(true)
    },
  }
}

test("private commands use official SDK routing, default queue and same-session supplement without IM sends", async () => {
  await using tmp = await tmpdir()
  using peer = fixture(tmp.path)
  const draft = createIMDacDraft({ client: peer.client, groupID: group.id, current: () => true })
  try {
    draft.update({ text: " 保留原正文\n", referenceMessageIDs: ["original-message"] })
    const queued = await draft.submit()
    expect(queued?.state).toBe("admitted")
    expect(peer.state.posts[0]).toMatchObject({
      text: " 保留原正文\n",
      delivery: "queue",
      referenceMessageIDs: ["original-message"],
    })
    expect((await peer.client.dacSession(group.id, queued!.sessionID, new AbortController().signal)).sessionID).toBe(
      "original-session",
    )
    draft.update({ text: "补充当前工作", delivery: "steer" })
    const supplemented = await draft.submit()
    expect(supplemented?.sessionID).toBe(queued?.sessionID)
    expect(peer.state.posts[1].delivery).toBe("steer")
    expect(peer.state.posts[1].commandID).not.toBe(peer.state.posts[0].commandID)
    expect(peer.state.messages).toEqual([])
    expect(
      peer.state.calls.every(
        (call) =>
          call.auth === "Basic fixture-only" &&
          call.directory === tmp.path &&
          call.header === encodeURIComponent(tmp.path),
      ),
    ).toBe(true)
  } finally {
    draft.dispose()
  }
})

test("lost admission retains exact payload, blocks edits and reconciles the original receipt without resubmitting", async () => {
  await using tmp = await tmpdir()
  using peer = fixture(tmp.path)
  peer.state.loseResponse = true
  const draft = createIMDacDraft({ client: peer.client, groupID: group.id, current: () => true })
  try {
    draft.update({ text: "private task", newSession: true })
    await expect(draft.submit()).rejects.toThrow()
    expect(draft.state.uncertain).toBe(true)
    expect(draft.update({ text: "different task", delivery: "steer" })).toBe(false)
    const original = draft.snapshot().intent
    expect(original).toMatchObject({ text: "private task", delivery: "queue", newSession: true })
    const command = await draft.refresh()
    expect(command?.commandID).toBe(original?.commandID)
    expect(draft.state.uncertain).toBe(false)
    expect(peer.state.posts).toHaveLength(1)
    expect(peer.state.messages).toEqual([])
    peer.state.commands.set(command!.commandID, {
      ...command!,
      activityID: "original-activity",
      finalMessageID: "original-final",
      replyStatus: "delivered",
    })
    expect((await draft.refresh())?.replyStatus).toBe("delivered")
    expect(peer.state.posts).toHaveLength(1)
  } finally {
    draft.dispose()
  }
})

test("late owner changes reject admission observations and current binding changes cannot open a foreign Session", async () => {
  await using tmp = await tmpdir()
  using peer = fixture(tmp.path)
  const owner = { current: true }
  peer.state.beforeResponse = async () => {
    owner.current = false
  }
  const draft = createIMDacDraft({ client: peer.client, groupID: group.id, current: () => owner.current })
  try {
    draft.update({ text: "one current task" })
    await expect(draft.submit()).rejects.toThrow()
    expect(draft.state.command).toBeUndefined()
    expect(draft.state.uncertain).toBe(true)
    expect(peer.state.posts).toHaveLength(1)
  } finally {
    draft.dispose()
  }
  peer.state.eligible = false
  await expect(peer.client.dacSession(group.id, "original-session", new AbortController().signal)).rejects.toThrow()
  peer.state.eligible = true
  peer.state.afterSession = () => {
    peer.state.sessionID = "foreign-session"
  }
  await expect(peer.client.dacSession(group.id, "original-session", new AbortController().signal)).rejects.toThrow()
  expect(peer.state.messages).toEqual([])
})

test("only explicit before-admission rejection permits an edited intent while conflict reconciles by GET", async () => {
  await using tmp = await tmpdir()
  using peer = fixture(tmp.path)
  const draft = createIMDacDraft({ client: peer.client, groupID: group.id, current: () => true })
  try {
    draft.update({ text: "first private command" })
    peer.state.rejection = { code: "reference_unavailable", admitted: false }
    await expect(draft.submit()).rejects.toThrow()
    expect(draft.state.uncertain).toBe(false)
    expect(draft.update({ text: "corrected private command", delivery: "steer" })).toBe(true)
    peer.state.rejection = { code: "command_conflict" }
    await expect(draft.submit()).rejects.toThrow()
    expect(draft.state.uncertain).toBe(true)
    expect(draft.update({ text: "must not overwrite ambiguous intent" })).toBe(false)
    peer.state.rejection = undefined
    await expect(draft.submit()).rejects.toThrow()
    expect(peer.state.posts).toHaveLength(2)
    expect(peer.state.calls.at(-1)?.method).toBe("GET")
    expect(peer.state.posts[1].commandID).not.toBe(peer.state.posts[0].commandID)
    expect(peer.state.posts[1].text).toBe("corrected private command")
    expect(peer.state.posts[1].delivery).toBe("steer")
    expect(draft.state.uncertain).toBe(true)
    expect(peer.state.messages).toEqual([])
  } finally {
    draft.dispose()
  }
})

test("actual chat Enter routes nonempty /dac directly to private admission and leaves ordinary messages on IM", async () => {
  await using tmp = await tmpdir()
  using peer = fixture(tmp.path)
  const opened: string[] = []
  function View() {
    const sdk = useSDK()
    return (
      <DialogIMChat
        sdk={sdk}
        client={peer.client}
        group={group}
        back={() => {}}
        openSession={(binding) => {
          if (binding.sessionID) opened.push(binding.sessionID)
        }}
      />
    )
  }
  using ui = await mountIM(tmp.path, peer.server.url.origin, View)
  await ui.frame("Original chat")
  ui.app.mockInput.pressKey("s", { ctrl: true })
  await ui.type("ordinary hello")
  ui.app.mockInput.pressEnter()
  await until(() => peer.state.messages.length === 1, "ordinary IM message")
  const frame = await ui.frame("ordinary hello")
  expect(frame).not.toContain("Propose task")
  expect(frame).not.toContain("Accept and execute")
  ui.app.mockInput.pressKey("s", { ctrl: true })
  await ui.type("/dac 读取并修改一个小模块")
  await ui.frame("/dac 读取并修改一个小模块")
  ui.app.mockInput.pressEnter()
  await until(() => opened.length === 1, "original private admission navigation")
  expect(peer.state.posts).toHaveLength(1)
  expect(peer.state.posts[0].text).toBe(" 读取并修改一个小模块")
  expect(peer.state.posts[0].delivery).toBe("queue")
  expect(peer.state.messages).toEqual(["ordinary hello"])
})

test("actual empty /dac opens only a private draft, preserving default queue until explicit submit", async () => {
  await using tmp = await tmpdir()
  using peer = fixture(tmp.path)
  function View() {
    const sdk = useSDK()
    return <DialogIMChat sdk={sdk} client={peer.client} group={group} back={() => {}} openSession={() => {}} />
  }
  using ui = await mountIM(tmp.path, peer.server.url.origin, View)
  await ui.frame("Original chat")
  ui.app.mockInput.pressKey("s", { ctrl: true })
  await ui.type("/dac")
  await ui.frame("/dac")
  ui.app.mockInput.pressEnter()
  await ui.frame("Commands and execution stay private")
  expect(peer.state.posts).toEqual([])
  expect(peer.state.messages).toEqual([])
  await ui.app.renderOnce()
  await ui.type("explicit private command")
  ui.app.mockInput.pressEnter()
  await until(() => peer.state.posts.length === 1, "one draft submit")
  expect(peer.state.posts[0].delivery).toBe("queue")
  expect(peer.state.messages).toEqual([])
})

test("validated pending conversation preserves an unreferenced private DAC draft across actual body polling", async () => {
  await using tmp = await tmpdir()
  using peer = fixture(tmp.path)
  const opened: string[] = []
  const pending: IMGroup = {
    ...group,
    kernelConvID: "kr1:fixture",
    reader: { mode: "protected", state: "pending", liveUnread: null },
  }
  function View() {
    const sdk = useSDK()
    return (
      <DialogIMChat
        sdk={sdk}
        client={peer.client}
        group={pending}
        displayEpoch="pending_epoch"
        back={() => {}}
        openSession={(binding) => {
          if (binding.sessionID) opened.push(binding.sessionID)
        }}
      />
    )
  }
  using ui = await mountIM(tmp.path, peer.server.url.origin, View)
  await until(() => peer.state.sockets.size === 1, "actual protected socket connected")
  await ui.frame("Waiting for the conversation")
  ui.app.mockInput.pressKey("j", { ctrl: true })
  await ui.frame("Commands and execution stay private")
  await ui.type("own pending conversation task")
  const gets = peer.state.calls.filter((call) => call.path.endsWith("/messages")).length
  await until(
    () => peer.state.calls.filter((call) => call.path.endsWith("/messages")).length > gets,
    "actual protected body poll",
    6000,
  )
  const frame = await ui.frame("own pending conversation task")
  expect(frame).toContain("Commands and execution stay private")
  expect(peer.state.posts).toEqual([])
  ui.app.mockInput.pressEnter()
  await until(() => opened.length === 1, "pending metadata private admission")
  expect(peer.state.posts).toHaveLength(1)
  expect(peer.state.posts[0]).toMatchObject({ text: "own pending conversation task", delivery: "queue" })
  expect(peer.state.posts[0].referenceMessageIDs).toBeUndefined()
  expect(opened).toEqual(["original-session"])
  expect(peer.state.messages).toEqual([])
  for (const socket of peer.state.sockets) socket.close()
  await until(() => peer.state.sockets.size === 0, "actual protected socket disconnected")
  const disconnected = await ui.frame("Connection: offline")
  expect(disconnected).not.toContain("Commands and execution stay private")
  ui.app.mockInput.pressKey("j", { ctrl: true })
  await ui.app.renderOnce()
  expect(ui.app.captureCharFrame()).not.toContain("Commands and execution stay private")
  expect(peer.state.posts).toHaveLength(1)
}, 10000)

test("pending conversation cannot submit unread references or keep a draft after metadata revocation", async () => {
  await using tmp = await tmpdir()
  using peer = fixture(tmp.path)
  const pending: IMGroup = {
    ...group,
    kernelConvID: "kr1:fixture",
    reader: { mode: "protected", state: "pending", liveUnread: null },
  }
  const [unavailable, setUnavailable] = createSignal(false)
  function View() {
    const sdk = useSDK()
    return (
      <DialogIMChat
        sdk={sdk}
        client={peer.client}
        group={pending}
        displayEpoch="pending_epoch"
        readerUnavailable={unavailable()}
        back={() => {}}
        openSession={() => {}}
        restore={{
          groupID: group.id,
          draft: "",
          scrollTop: 0,
          dac: {
            text: "unread reference must never submit",
            delivery: "queue",
            referenceMessageIDs: ["unread"],
            newSession: false,
          },
        }}
      />
    )
  }
  using ui = await mountIM(tmp.path, peer.server.url.origin, View)
  await until(() => peer.state.sockets.size === 1, "actual protected socket connected")
  await ui.frame("Waiting for the conversation")
  ui.app.mockInput.pressKey("j", { ctrl: true })
  await ui.frame("Commands and execution stay private")
  ui.app.mockInput.pressEnter()
  await ui.frame("This DAC Session or chat is unavailable")
  expect(peer.state.posts).toEqual([])
  setUnavailable(true)
  const frame = await ui.frame("Waiting for the conversation")
  expect(frame).not.toContain("Commands and execution stay private")
  expect(frame).not.toContain("unread reference must never submit")
  ui.app.mockInput.pressKey("j", { ctrl: true })
  await ui.app.renderOnce()
  expect(ui.app.captureCharFrame()).not.toContain("Commands and execution stay private")
  expect(peer.state.posts).toEqual([])
  expect(peer.state.messages).toEqual([])
})

test("pending private draft keeps keyboard status and back reachable without a second admission", async () => {
  await using tmp = await tmpdir()
  using peer = fixture(tmp.path)
  peer.state.loseResponse = true
  const draft = createIMDacDraft({ client: peer.client, groupID: group.id, current: () => true })
  const returned = { count: 0 }
  draft.update({ text: "original ambiguous command" })
  try {
    using ui = await mountIM(tmp.path, peer.server.url.origin, () => (
      <DialogIMDac draft={draft} openSession={async () => {}} back={() => returned.count++} />
    ))
    await ui.frame("Commands and execution stay private")
    ui.app.mockInput.pressEnter()
    await until(() => draft.state.uncertain && !draft.state.busy, "original dispatch completed without receipt")
    ui.app.mockInput.pressKey("r", { ctrl: true })
    await until(() => draft.state.command?.state === "admitted", "keyboard observes original receipt")
    expect(peer.state.posts).toHaveLength(1)
    expect(peer.state.messages).toEqual([])
    ui.app.mockInput.pressEscape()
    await until(() => returned.count === 1, "private back callback")
  } finally {
    draft.dispose()
  }
})

test("cold chat restores recent command cards and explicitly resends only the selected dead final answer", async () => {
  await using tmp = await tmpdir()
  using peer = fixture(tmp.path)
  for (const commandID of ["first-task", "second-task"]) {
    const command = await peer.client.dacSubmit(
      group.id,
      { commandID, text: "private original task", delivery: "queue" },
      new AbortController().signal,
    )
    peer.state.commands.set(commandID, {
      ...command,
      activityID: `activity-${commandID}`,
      finalMessageID: `final-${commandID}`,
      replyStatus: "dead",
    })
  }
  peer.state.recent = true
  const opened: string[] = []
  function View() {
    const sdk = useSDK()
    return (
      <DialogIMChat
        sdk={sdk}
        client={peer.client}
        group={group}
        back={() => {}}
        openSession={(binding) => {
          if (binding.sessionID) opened.push(binding.sessionID)
        }}
      />
    )
  }
  using ui = await mountIM(tmp.path, peer.server.url.origin, View)
  await ui.frame("Original chat")
  ui.app.mockInput.pressKey("o", { ctrl: true })
  await ui.frame("Resend the failed final answer")
  expect(peer.state.posts).toHaveLength(2)
  expect(opened).toEqual([])
  ui.app.mockInput.pressKey("h", { ctrl: true })
  await ui.frame("first-task")
  ui.app.mockInput.pressArrow("down")
  ui.app.mockInput.pressEnter()
  await until(
    () => peer.state.calls.at(-1)?.path.endsWith("/commands/first-task") === true,
    "selected original command GET",
  )
  await ui.frame("Resend the failed final answer")
  ui.app.mockInput.pressKey("y", { ctrl: true })
  await until(() => peer.state.replyRetries.length === 1, "explicit selected final retry")
  await ui.frame("Final delivery: pending")
  ui.app.mockInput.pressKey("y", { ctrl: true })
  await ui.app.renderOnce()
  expect(peer.state.replyRetries).toEqual(["first-task"])
  expect(peer.state.posts).toHaveLength(2)
  expect(peer.state.messages).toEqual([])
})

test("ambiguous final delivery disables repeated POST and Enter observes only its original command", async () => {
  await using tmp = await tmpdir()
  using peer = fixture(tmp.path)
  const draft = createIMDacDraft({ client: peer.client, groupID: group.id, current: () => true })
  try {
    draft.update({ text: "one private task" })
    const command = (await draft.submit())!
    peer.state.commands.set(command.commandID, { ...command, finalMessageID: "original-final", replyStatus: "dead" })
    await draft.refresh()
    peer.state.loseReplyResponse = true
    using ui = await mountIM(tmp.path, peer.server.url.origin, () => (
      <DialogIMDac draft={draft} openSession={async () => {}} back={() => {}} />
    ))
    await ui.frame("Resend the failed final answer")
    ui.app.mockInput.pressKey("y", { ctrl: true })
    await until(() => draft.state.replyUncertain && !draft.state.busy, "final retry response lost")
    ui.app.mockInput.pressKey("y", { ctrl: true })
    await ui.app.renderOnce()
    expect(peer.state.replyRetries).toEqual([command.commandID])
    expect(draft.update({ text: "must remain private" })).toBe(false)
    ui.app.mockInput.pressEnter()
    await until(
      () => draft.state.command?.replyStatus === "pending" && !draft.state.busy,
      "original receipt GET after ambiguous final send",
    )
    expect(peer.state.calls.at(-1)?.method).toBe("GET")
    expect(draft.state.replyUncertain).toBe(false)
    expect(peer.state.posts).toHaveLength(1)
    expect(peer.state.replyRetries).toHaveLength(1)
    expect(peer.state.messages).toEqual([])
  } finally {
    draft.dispose()
  }
})

test("known unknown final delivery stays GET-only until its original receipt is settled", async () => {
  await using tmp = await tmpdir()
  using peer = fixture(tmp.path)
  const draft = createIMDacDraft({ client: peer.client, groupID: group.id, current: () => true })
  const opened: string[] = []
  try {
    draft.update({ text: "one original private task" })
    const command = (await draft.submit())!
    const unknown = { ...command, finalMessageID: "original-final", replyStatus: "unknown" as const }
    peer.state.commands.set(command.commandID, unknown)
    await draft.refresh()
    using ui = await mountIM(tmp.path, peer.server.url.origin, () => (
      <DialogIMDac draft={draft} recentCommands={[unknown]}
        openSession={async (sessionID) => { opened.push(sessionID) }} back={() => {}} />
    ))
    const frame = (await ui.frame("needs checking")).replace(/\s+/g, " ")
    expect(frame).toContain("Final delivery: Delivery outcome needs checking")
    expect(frame).not.toContain("Resend the failed final answer")
    expect(frame).not.toContain("Submit to my DAC (Enter)")
    expect(frame).toContain("Keep the original command and check its state")
    expect(draft.editable()).toBe(false)
    expect(draft.update({ text: "must not replace the original command" })).toBe(false)
    ui.app.mockInput.pressKey("y", { ctrl: true })
    await ui.app.renderOnce()
    expect(peer.state.replyRetries).toEqual([])
    const before = peer.state.calls.length
    ui.app.mockInput.pressEnter()
    await until(() => peer.state.calls.length > before && !draft.state.busy, "unknown final Enter GET")
    expect(peer.state.calls.at(-1)?.method).toBe("GET")
    expect(peer.state.calls.at(-1)?.path).toBe(`/api/v1/im/groups/${group.id}/dac/commands/${command.commandID}`)
    expect(draft.state.command?.replyStatus).toBe("unknown")
    expect(opened).toEqual([])
    await ui.frame("needs checking")
    expect(draft.state.busy).toBe(false)
    expect(draft.state.uncertain).toBe(false)
    expect(draft.state.replyUncertain).toBe(false)
    peer.state.commands.set(command.commandID, { ...unknown, replyStatus: "delivered" })
    ui.app.mockInput.pressKey("r", { ctrl: true })
    await until(() => draft.state.command?.replyStatus === "delivered" && !draft.state.busy, "original receipt settles")
    await ui.frame("Final delivery: delivered")
    expect(peer.state.calls.at(-1)?.method).toBe("GET")
    expect(peer.state.calls.at(-1)?.path).toBe(`/api/v1/im/groups/${group.id}/dac/commands/${command.commandID}`)
    expect(draft.editable()).toBe(true)
    expect(peer.state.posts).toHaveLength(1)
    expect(peer.state.replyRetries).toEqual([])
    expect(peer.state.messages).toEqual([])
  } finally {
    draft.dispose()
  }
})

test("hidden destroyed editor ignores reactive updates and preserves the draft when shown again", async () => {
  await using tmp = await tmpdir()
  using peer = fixture(tmp.path)
  const draft = createIMDacDraft({ client: peer.client, groupID: group.id, current: () => true })
  try {
    draft.update({ text: "one original private task" })
    const command = (await draft.submit())!
    const [visible, setVisible] = createSignal(true)
    using ui = await mountIM(tmp.path, peer.server.url.origin,
      () => <Show when={visible()}><DialogIMDac draft={draft} recentCommands={[command]}
        openSession={async () => {}} back={() => {}} /></Show>)
    await ui.frame("Commands and execution stay private")
    await ui.type("private draft before selector")
    const editor = ui.app.renderer.currentFocusedEditor!
    expect(editor.isDestroyed).toBe(false)
    // Use the actual renderer destruction boundary, not a fabricated buffer or copied
    // effect. The real recent-selector Show leaves this same destroyed ref in its owner.
    editor.destroy()
    expect(editor.isDestroyed).toBe(true)
    expect(draft.update({ text: "private draft changed while task list is open" })).toBe(true)
    await ui.app.renderOnce()
    setVisible(false)
    await ui.app.renderOnce()
    setVisible(true)
    await ui.frame("private draft changed while task list is open")
    expect(peer.state.posts).toHaveLength(1)
    expect(peer.state.replyRetries).toEqual([])
    expect(peer.state.messages).toEqual([])
  } finally { draft.dispose() }
})

test("recent task status changes preserve Session placement while foreign metadata remains rejected", async () => {
  await using tmp = await tmpdir()
  using peer = fixture(tmp.path)
  const command = await peer.client.dacSubmit(
    group.id,
    { commandID: "original-task", text: "original private task", delivery: "queue" },
    new AbortController().signal,
  )
  peer.state.recent = true
  peer.state.afterSession = () =>
    peer.state.commands.set(command.commandID, {
      ...command,
      finalMessageID: "original-final",
      replyStatus: "delivered",
    })
  expect((await peer.client.dacSession(group.id, command.sessionID, new AbortController().signal)).sessionID).toBe(
    command.sessionID,
  )
  peer.state.commands.set(command.commandID, { ...command, directory: "/foreign-project" })
  await expect(peer.client.dacBinding(group.id, new AbortController().signal)).rejects.toThrow()
  expect(peer.state.posts).toHaveLength(1)
  expect(peer.state.replyRetries).toEqual([])
  expect(peer.state.messages).toEqual([])
})

test("same-binding recent metadata opens a historical Session only through its exact admitted command", async () => {
  await using tmp = await tmpdir()
  using peer = fixture(tmp.path)
  const command = await peer.client.dacSubmit(group.id,
    { commandID: "previous-generation-task", text: "private original task", delivery: "queue" }, new AbortController().signal)
  peer.state.recent = true
  peer.state.commands.set(command.commandID, { ...command, sessionID: "previous-generation-session",
    finalMessageID: "previous-final", replyStatus: "dead" })
  expect((await peer.client.dacBinding(group.id, new AbortController().signal)).recentCommands?.[0]?.sessionID)
    .toBe("previous-generation-session")
  await expect(peer.client.dacSession(group.id, "previous-generation-session", new AbortController().signal)).rejects.toThrow()
  expect((await peer.client.dacSession(group.id, "previous-generation-session", new AbortController().signal,
    command.commandID)).sessionID).toBe("previous-generation-session")
  await expect(peer.client.dacSession(group.id, "free-user-supplied-session", new AbortController().signal,
    command.commandID)).rejects.toThrow()
  const opened: string[] = []
  function View() {
    const sdk = useSDK()
    return <DialogIMChat sdk={sdk} client={peer.client} group={group} back={() => {}}
      openSession={(binding) => { if (binding.sessionID) opened.push(binding.sessionID) }} />
  }
  using ui = await mountIM(tmp.path, peer.server.url.origin, View)
  await ui.frame("Original chat")
  ui.app.mockInput.pressKey("o", { ctrl: true })
  await ui.frame("Resend the failed final answer")
  ui.app.mockInput.pressKey("o", { ctrl: true })
  await until(() => opened.length === 1, "historical task opens its verified original Session")
  expect(opened).toEqual(["previous-generation-session"])
  peer.state.commands.set(command.commandID, { ...command, sessionID: "previous-generation-session",
    bindingID: "foreign-binding" })
  await expect(peer.client.dacSession(group.id, "previous-generation-session", new AbortController().signal,
    command.commandID)).rejects.toThrow()
  expect(peer.state.posts).toHaveLength(1)
  expect(peer.state.replyRetries).toEqual([])
})

test("remote attach retains ordinary chat transport while private DAC refuses before any request", async () => {
  await using tmp = await tmpdir()
  const calls: string[] = []
  const transport: typeof fetch = Object.assign(
    (request: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(request, init).url)
      return Promise.resolve(Response.json({ messages: [], hasMore: false, nextCursor: null }))
    },
    { preconnect: fetch.preconnect },
  )
  const sdk = {
    url: "https://owned-remote.example",
    directory: tmp.path,
    fetch: transport,
    client: createOpencodeClient({ baseUrl: "https://owned-remote.example", fetch: transport }),
  }
  const client = createIMClient(sdk)
  expect(client.dacAvailable()).toBe(false)
  await client.listMessages(group.id, 50, undefined, new AbortController().signal)
  expect(calls).toHaveLength(1)
  await expect(client.dacBinding(group.id, new AbortController().signal)).rejects.toThrow()
  await expect(
    client.dacSubmit(
      group.id,
      { commandID: "original-private-command", text: "private task", delivery: "queue" },
      new AbortController().signal,
    ),
  ).rejects.toThrow()
  await expect(client.dacCommand(group.id, "original-private-command", new AbortController().signal)).rejects.toThrow()
  expect(calls).toHaveLength(1)
  expect(createIMClient({ ...sdk, url: "http://deepagent-code.internal" }).dacAvailable()).toBe(true)
  expect(createIMClient({ ...sdk, url: "http://deepagent-code.internal", fetch: undefined }).dacAvailable()).toBe(false)
})
