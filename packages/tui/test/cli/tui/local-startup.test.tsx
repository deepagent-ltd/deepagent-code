/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { onMount } from "solid-js"
import { ArgsProvider } from "../../../src/context/args"
import { ProjectProvider } from "../../../src/context/project"
import { RouteProvider } from "../../../src/context/route"
import { SyncProvider } from "../../../src/context/sync"
import { LocalProvider, useLocal } from "../../../src/context/local"
import { TuiStartupProvider } from "../../../src/context/runtime"
import { mountIM, until } from "../../fixture/im-environment"
import { createFetch } from "../../fixture/tui-sdk"

test("actual LocalProvider renders pending Agent data and recovers without selecting a model or submitting", async () => {
  const root = await mkdtemp("/tmp/dac-tui-local-startup-")
  const calls: { method: string; path: string }[] = []
  const agent = { name: "loaded-agent", mode: "primary", permission: [], options: {} }
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const fixture = createFetch()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      calls.push({ method: request.method, path: url.pathname })
      if (url.pathname === "/agent") {
        await pending
        return Response.json([agent])
      }
      if (url.pathname === "/config/providers") return Response.json({ providers: [], default: {} })
      return fixture.fetch(request)
    },
  })
  const observed: { local?: ReturnType<typeof useLocal> } = {}
  function Probe() {
    const local = useLocal()
    onMount(() => {
      observed.local = local
    })
    return (
      <text>
        {local.agent.status()} | {local.agent.current()?.name ?? "no Agent"} | {local.model.parsed()?.provider}
      </text>
    )
  }
  const app = await mountIM(root, server.url.origin, () => (
    <TuiStartupProvider value={{ skipInitialLoading: true }}>
      <ArgsProvider>
        <RouteProvider>
          <ProjectProvider>
            <SyncProvider>
              <LocalProvider>
                <Probe />
              </LocalProvider>
            </SyncProvider>
          </ProjectProvider>
        </RouteProvider>
      </ArgsProvider>
    </TuiStartupProvider>
  ))
  try {
    await app.frame("loading | no Agent")
    await until(() => observed.local !== undefined)
    expect(observed.local?.agent.current()).toBeUndefined()
    expect(observed.local?.agent.move(1)).toBe(false)
    expect(observed.local?.agent.set(agent.name)).toBe(false)
    expect(observed.local?.model.current()).toBeUndefined()
    release()
    await app.frame("ready | loaded-agent")
    expect(observed.local?.agent.current()?.name).toBe(agent.name)
    expect(observed.local?.model.current()).toBeUndefined()
    expect(calls.some((call) => call.path === "/agent")).toBe(true)
    expect(calls.every((call) => call.method === "GET")).toBe(true)
  } finally {
    release()
    app[Symbol.dispose]()
    await server.stop(true)
  }
})
