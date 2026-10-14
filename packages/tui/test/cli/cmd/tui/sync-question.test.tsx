/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createOpencodeClient, type GlobalEvent, type QuestionRequest } from "@deepagent-code/sdk"
import { QuestionClient } from "../../../../src/context/question-client"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount, wait } from "./sync-fixture"

function question(id: string, sessionID = "ses_question_v2", header = "Execute plan"): QuestionRequest {
  return {
    id,
    sessionID,
    questions: [
      {
        header,
        question: "Approve this version?",
        options: [{ label: "Execute", description: "Proceed" }],
        custom: false,
      },
    ],
  }
}

function event(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory, project: "proj_test", payload }
}

test("question bootstrap restores both protocols and records provenance by Session", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const legacy = question("que_same", "ses_legacy")
  const current = question("que_same")
  const locations: URL[] = []
  const { app, sync } = await mount((url) => {
    if (url.pathname === "/question") {
      locations.push(url)
      return json([legacy])
    }
    if (url.pathname === "/api/question/request") {
      locations.push(url)
      return json({ location: { directory }, data: [current] })
    }
    return undefined
  }, tmp.path)

  try {
    expect(sync.data.question[legacy.sessionID]).toEqual([legacy])
    expect(sync.data.question[current.sessionID]).toEqual([current])
    expect(sync.questionV2(current.sessionID, current.id)).toBe(true)
    expect(sync.questionV2(legacy.sessionID, legacy.id)).toBe(false)
    expect(locations.find((url) => url.pathname === "/question")?.searchParams.get("directory")).toBe(directory)
    expect(
      locations.find((url) => url.pathname === "/api/question/request")?.searchParams.get("location[directory]"),
    ).toBe(directory)
  } finally {
    app.renderer.destroy()
  }
})

test("question SSE upserts once and clears replied or rejected requests from either protocol", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(undefined, tmp.path)
  const current = question("que_event")
  const legacy = question("que_legacy", "ses_legacy")
  try {
    emit(event({ id: "evt_current", type: "question.v2.asked", properties: current }))
    emit(
      event({
        id: "evt_current_update",
        type: "question.v2.asked",
        properties: question(current.id, current.sessionID, "Exact snapshot"),
      }),
    )
    emit(event({ id: "evt_legacy", type: "question.asked", properties: legacy }))
    await wait(() => sync.data.question[current.sessionID]?.[0]?.questions[0].header === "Exact snapshot")
    expect(sync.data.question[current.sessionID]).toHaveLength(1)
    expect(sync.questionV2(current.sessionID, current.id)).toBe(true)
    expect(sync.questionV2(legacy.sessionID, legacy.id)).toBe(false)

    emit(
      event({
        id: "evt_current_reply",
        type: "question.v2.replied",
        properties: { sessionID: current.sessionID, requestID: current.id, answers: [["Execute"]] },
      }),
    )
    emit(
      event({
        id: "evt_legacy_reject",
        type: "question.rejected",
        properties: { sessionID: legacy.sessionID, requestID: legacy.id },
      }),
    )
    await wait(
      () => sync.data.question[current.sessionID]?.length === 0 && sync.data.question[legacy.sessionID]?.length === 0,
    )
    expect(sync.questionV2(current.sessionID, current.id)).toBe(false)

    emit(event({ id: "evt_current_again", type: "question.v2.asked", properties: current }))
    emit(event({ id: "evt_legacy_again", type: "question.asked", properties: legacy }))
    emit(
      event({
        id: "evt_current_reject",
        type: "question.v2.rejected",
        properties: { sessionID: current.sessionID, requestID: current.id },
      }),
    )
    emit(
      event({
        id: "evt_legacy_reply",
        type: "question.replied",
        properties: { sessionID: legacy.sessionID, requestID: legacy.id, answers: [["Execute"]] },
      }),
    )
    await wait(
      () => sync.data.question[current.sessionID]?.length === 0 && sync.data.question[legacy.sessionID]?.length === 0,
    )
    expect(sync.questionV2(current.sessionID, current.id)).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})

test("question list hydration preserves live asks and does not revive decisions from stale snapshots", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let reload = false
  const resolvers = new Map<string, (response: Response) => void>()
  const { app, emit, sync } = await mount((url) => {
    if (!reload || !["/question", "/api/question/request"].includes(url.pathname)) return undefined
    return new Promise<Response>((resolve) => resolvers.set(url.pathname, resolve))
  }, tmp.path)

  try {
    reload = true
    const hydration = sync.bootstrap({ fatal: false })
    await wait(() => resolvers.size === 2)
    const late = question("que_late")
    const changed = question("que_changed", late.sessionID, "New live version")
    emit(event({ id: "evt_late", type: "question.v2.asked", properties: late }))
    emit(event({ id: "evt_changed", type: "question.v2.asked", properties: changed }))
    emit(
      event({
        id: "evt_replied",
        type: "question.v2.replied",
        properties: { sessionID: late.sessionID, requestID: "que_replied", answers: [["Execute"]] },
      }),
    )
    emit(
      event({
        id: "evt_rejected",
        type: "question.v2.rejected",
        properties: { sessionID: late.sessionID, requestID: "que_rejected" },
      }),
    )
    emit(
      event({
        id: "evt_legacy_rejected",
        type: "question.rejected",
        properties: { sessionID: "ses_legacy", requestID: "que_legacy_decided" },
      }),
    )
    await wait(() => sync.data.question[late.sessionID]?.length === 2)
    // The SDK batches events over 16 ms; wait for the terminal decisions as well.
    await Bun.sleep(30)
    resolvers.get("/question")!(json([question("que_legacy_decided", "ses_legacy")]))
    resolvers.get("/api/question/request")!(
      json({
        location: { directory },
        data: [question("que_replied"), question("que_rejected"), question(changed.id)],
      }),
    )
    await hydration
    expect(sync.data.question[late.sessionID]?.map((request) => request.id)).toEqual([changed.id, late.id])
    expect(sync.data.question[late.sessionID]?.[0]?.questions[0].header).toBe("New live version")
    expect(sync.data.question.ses_legacy ?? []).toEqual([])
    expect(sync.questionV2(late.sessionID, late.id)).toBe(true)
    expect(sync.questionV2(late.sessionID, "que_replied")).toBe(false)

    reload = false
    await sync.bootstrap({ fatal: false })
    expect(sync.data.question[late.sessionID]).toEqual([])
    expect(sync.questionV2(late.sessionID, late.id)).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})

test("question replies and rejection use generated SDK V2 routes only for tracked V2 provenance", async () => {
  const calls: { path: string; method: string; body: unknown; directory: string | null }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      calls.push({
        path: url.pathname,
        method: request.method,
        body: request.headers.get("content-type") ? await request.json() : undefined,
        directory: url.searchParams.get("directory"),
      })
      return url.pathname.startsWith("/api/") ? new Response(null, { status: 204 }) : json(true)
    },
  })

  try {
    const client = createOpencodeClient({ baseUrl: server.url.toString() })
    const request = question("que_identical")
    await QuestionClient.reply(client, { request, v2: true, directory }, [["Execute"]])
    await QuestionClient.reject(client, { request, v2: true, directory })
    await QuestionClient.reply(client, { request, v2: false, directory }, [["Later"]])
    await QuestionClient.reject(client, { request, v2: false, directory })
    expect(calls).toEqual([
      {
        path: `/api/session/${request.sessionID}/question/${request.id}/reply`,
        method: "POST",
        body: { answers: [["Execute"]] },
        directory: null,
      },
      {
        path: `/api/session/${request.sessionID}/question/${request.id}/reject`,
        method: "POST",
        body: undefined,
        directory: null,
      },
      { path: `/question/${request.id}/reply`, method: "POST", body: { answers: [["Later"]] }, directory },
      { path: `/question/${request.id}/reject`, method: "POST", body: undefined, directory },
    ])
  } finally {
    server.stop(true)
  }
})
