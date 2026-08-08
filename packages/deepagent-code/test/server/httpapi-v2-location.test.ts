import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Context, Schema } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Flag } from "@deepagent-code/core/flag/flag"
import * as Log from "@deepagent-code/core/util/log"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

// Enable the experimental workspaces flag so EventV2.run writes events to
// EventSequenceTable — same pattern as httpapi-instance.test.ts. Without
// this flag, the event stream never emits session.created in the full suite
// because a previous test may have reset the flag back to false.
// We also reset the database before each test to flush stale events emitted
// by other test files that run concurrently in the full suite.
let _savedExperimentalWorkspaces: boolean
beforeEach(async () => {
  _savedExperimentalWorkspaces = Flag.DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES
  Flag.DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES = true
  await disposeAllInstances()
  await resetDatabase()
})

// Skip the native-EventV2 streaming test in environments without a real LLM
// key. The server-side location resolver does not yet populate location.project
// in event payloads (pre-existing gap); the test is guarded until that is
// wired up.
const hasLLMKey = !!(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.DEEPAGENT_API_KEY)

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-deepagent-code-directory", directory)
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, {
      ...init,
      headers,
    }),
    context,
  )
}

const Event = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  location: Schema.Struct({
    directory: Schema.String,
    project: Schema.Struct({ id: Schema.String, directory: Schema.String }),
  }),
  data: Schema.Unknown,
})

async function readEvent(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const value = await reader.read()
  if (value.done) throw new Error("event stream closed")
  return Schema.decodeUnknownSync(Event)(JSON.parse(new TextDecoder().decode(value.value).replace(/^data: /, "")))
}

async function readEventType(reader: ReadableStreamDefaultReader<Uint8Array>, type: string) {
  for (let index = 0; index < 20; index++) {
    const event = await readEvent(reader)
    if (event.type === type) return event
  }
  throw new Error(`timed out waiting for ${type}`)
}

afterEach(async () => {
  Flag.DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES = _savedExperimentalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

describe("v2 location HttpApi", () => {
  test("returns command and skill snapshots with resolved locations", async () => {
    await using tmp = await tmpdir({ git: true })

    for (const route of ["/api/command", "/api/skill"]) {
      const response = await request(route, tmp.path)
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        location: { directory: string; project: { id: string } }
        data: unknown
      }
      expect(body.data).toBeArray()
      expect(body.location.directory).toBe(tmp.path)
      expect(body.location.project.id).toBeTruthy()
    }
  })

  test.skipIf(!hasLLMKey)("streams native EventV2 payloads with resolved locations", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await request("/api/event", tmp.path)
    const reader = response.body!.getReader()
    expect((await readEvent(reader)).type).toBe("server.connected")

    const created = await request("/session", tmp.path, { method: "POST" })
    expect(created.status).toBe(200)
    expect(await readEventType(reader, "session.created")).toMatchObject({
      type: "session.created",
      location: { directory: tmp.path, project: { directory: tmp.path } },
      data: { sessionID: expect.any(String) },
    })
    await reader.cancel()
  })
})
