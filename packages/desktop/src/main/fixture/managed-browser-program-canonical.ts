import { app, utilityProcess } from "electron"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { Hash } from "@deepagent-code/core/util/hash"
import { installManagedBrowser } from "../managed-browser"

const root = process.env.DAC_BROWSER_TEST_ROOT!
app.setPath("userData", path.join(root, "electron-user"))
app.setPath("sessionData", path.join(root, "electron-session"))
app.commandLine.appendSwitch("disable-background-networking")
// A shown window outside the pointer's screen area keeps ambient cursor events
// from invalidating this qualifier's real native source during awaited checks.
app.on("browser-window-created", (_event, window) => {
  window.on("show", () => window.setPosition(-10_000, -10_000))
  window.setPosition(-10_000, -10_000)
})
app.on("window-all-closed", () => {})

async function main() {
  await app.whenReady()
  const requests: Array<{ method: string; url: string; body: string }> = []
  const providerCalls: Array<{ ordinal: number; tool: string | null }> = []
  const providerArrivals: Array<{ method: string; url: string }> = []
  const pending: Array<{ action: string; posts: number }> = []
  const state: {
    controlID?: string
    source?: string
    argsJSON?: string
    tab?: typeof BrowserSchema.Tab.Type
    observed?: BrowserSchema.Result
  } = {}
  const page = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      body: Buffer.concat(chunks).toString("utf8"),
    })
    response.setHeader("Content-Type", "text/html; charset=utf-8")
    if (request.url === "/program-submit") {
      response.end("<html><body><h1>Canonical program submitted</h1></body></html>")
      return
    }
    response.end(
      '<html><body><h1>Canonical program</h1><form method="post" action="/program-submit"><label>Name<input name="name" aria-label="Name"></label><label>Choice<select name="choice" aria-label="Choice"><option value="a">A</option><option value="b">B</option></select></label><button type="submit">Submit</button></form></body></html>',
    )
  })
  await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve))
  const address = page.address()
  assert(address && typeof address !== "string")
  const origin = `http://127.0.0.1:${address.port}`
  const bodySchema = Schema.Struct({
    messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
    tools: Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String }) })),
  })
  const provider = createServer(async (request, response) => {
    providerArrivals.push({ method: request.method ?? "", url: request.url ?? "" })
    try {
      assert.equal(request.url, "/v1/chat/completions")
      assert(state.controlID && state.source && state.argsJSON)
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = Schema.decodeUnknownSync(Schema.fromJsonString(bodySchema))(Buffer.concat(chunks).toString("utf8"))
      assert(
        body.tools.some((tool) => tool.function.name === "browser"),
        "Original provider must actually offer browser",
      )
      // Include the original plan tool's provider turn, rather than disabling the ordinary plan gate.
      const ordinal = providerCalls.length
      if (ordinal === 0) assert(body.tools.some((tool) => tool.function.name === "plan"))
      const latest = body.messages.filter((value) => value.role === "tool").at(-1)
      if (ordinal === 2 || ordinal === 3 || ordinal === 4) {
        assert.equal(typeof latest?.content, "string")
        const output = Schema.decodeUnknownSync(Schema.fromJsonString(BrowserSchema.Result))(latest!.content)
        state.tab = output.tabs[0]
        if (ordinal === 4) state.observed = output
      }
      const target = () => {
        assert(state.tab && state.observed?.frameID && state.observed.observationRevision)
        return {
          tabID: state.tab.tabID,
          generation: state.tab.generation,
          frameID: state.observed.frameID,
          observationRevision: state.observed.observationRevision,
          targets: ["Name", "Choice", "Submit"].map((name) => {
            const target = state.observed!.refs?.find((value) => value.name === name)
            assert(target, `Missing real observation ref ${name}`)
            return { name: name.toLowerCase(), ref: target.ref }
          }),
        }
      }
      const command: BrowserSchema.Command | undefined =
        ordinal === 0
          ? undefined
          : ordinal === 1
          ? { type: "tabs.list" }
          : ordinal === 2
            ? {
                type: "navigate",
                tabID: state.tab!.tabID,
                generation: state.tab!.generation,
                url: origin + "/program-page",
              }
            : ordinal === 3
              ? { type: "snapshot", tabID: state.tab!.tabID, generation: state.tab!.generation }
              : ordinal <= 6
                ? {
                    type: "program",
                    ...target(),
                    scriptHash: Hash.sha256(state.source),
                    source: ordinal === 4 ? state.source + "\n" : state.source,
                    argsJSON: ordinal === 5 ? '{"text":"unapproved"}' : state.argsJSON,
                  }
                : undefined
      if (ordinal === 5 || ordinal === 6) {
        assert.equal(typeof latest?.content, "string")
        assert(String(latest?.content).includes("BROWSER_SCOPE_DENIED"), String(latest?.content))
      }
      assert(ordinal <= 7, "Unexpected extra ordinary provider dispatch")
      const tool = ordinal === 0 || command !== undefined
      providerCalls.push({ ordinal, tool: ordinal === 0 ? "plan" : command?.type ?? null })
      response.writeHead(200, { "content-type": "text/event-stream" })
      const emit = (value: object) =>
        response.write(
          `data: ${JSON.stringify({
            id: `canonical-${ordinal}`,
            object: "chat.completion.chunk",
            created: 1,
            model: "test-model",
            ...value,
          })}\n\n`,
        )
      emit({
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              ...(tool
                ? {
                    tool_calls: [
                      {
                        index: 0,
                        id: `canonical_call_${ordinal}`,
                        type: "function",
                        function: {
                          name: ordinal === 0 ? "plan" : "browser",
                          arguments: JSON.stringify(ordinal === 0
                            ? { operation: "create", goal: "Validate the approved browser program", steps: [{ title: "Execute the scoped browser program", status: "active" }] }
                            : { controlID: state.controlID, command }),
                        },
                      },
                    ],
                  }
                : { content: "Canonical approved program completed" }),
            },
          },
        ],
      })
      emit({
        choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      })
      response.end("data: [DONE]\n\n")
    } catch (error) {
      await fs.writeFile(
        path.join(root, "provider-error.log"),
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      )
      response.destroy(error instanceof Error ? error : new Error(String(error)))
    }
  })
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve))
  const providerAddress = provider.address()
  assert(providerAddress && typeof providerAddress !== "string")
  await fs.writeFile(
    path.join(root, "project/deepagent-code.json"),
    JSON.stringify({
      formatter: false,
      lsp: false,
      model: "fixture/test-model",
      permissions: [
        { action: "*", resource: "*", effect: "deny" },
        { action: "plan", resource: "*", effect: "allow" },
        { action: "browser", resource: "*", effect: "ask" },
        { action: "browser-program", resource: "*", effect: "ask" },
      ],
      providers: {
        fixture: {
          name: "Canonical local controlled provider",
          env: ["DAC_CANONICAL_PROVIDER_KEY"],
          api: {
            type: "native",
            settings: {},
            protocol: "openai-compatible.chat",
            url: `http://127.0.0.1:${providerAddress.port}/v1`,
          },
          models: {
            "test-model": {
              api: { id: "test-model" },
              capabilities: { input: ["text"], output: ["text"], tools: true },
              limit: { context: 100000, output: 4096 },
              cost: { input: 0, output: 0 },
            },
          },
        },
      },
    }),
    { mode: 0o600 },
  )
  const child = utilityProcess.fork(process.env.DAC_BROWSER_CHILD!, [], {
    cwd: path.join(root, "project"),
    env: {
      PATH: process.env.PATH,
      HOME: path.join(root, "home"),
      TMPDIR: path.join(root, "tmp"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"),
      DEEPAGENT_CODE_DB: path.join(root, "authority.sqlite"),
      DEEPAGENT_CODE_SERVER_USERNAME: "deepagent-code",
      DEEPAGENT_CODE_SERVER_PASSWORD: "private-fixture",
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
      DEEPAGENT_IM_AGENT_RESPONDER: "off",
      DEEPAGENT_ENABLED: "false",
      DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "1",
      DAC_CANONICAL_PROVIDER_KEY: "private-fixture",
      DAC_BROWSER_TEST_ROOT: root,
      DAC_BROWSER_ORIGIN: origin,
      NO_PROXY: "127.0.0.1,localhost,::1",
      NO_COLOR: "1",
    },
    stdio: "pipe",
  })
  child.stdout?.on("data", (data) => process.stdout.write(data))
  child.stderr?.on("data", (data) => process.stderr.write(data))
  const timeout = setTimeout(() => {
    child.kill()
    app.exit(2)
  }, 70_000)
  child.on("message", (message) => {
    if (message.type === "managed-browser-bootstrap-ready-v1") {
      installManagedBrowser(child, "private-fixture")
      return
    }
    if (message.type === "canonical-control") {
      state.controlID = message.controlID
      state.source = message.source
      state.argsJSON = message.argsJSON
      return
    }
    if (message.type === "canonical-program-pending") {
      pending.push({ action: message.action, posts: requests.filter((value) => value.method === "POST").length })
      return
    }
    if (message.type !== "canonical-result") return
    void fs
      .writeFile(
        path.join(root, "main-result.json"),
        JSON.stringify(
          { providerCalls, providerArrivals, requests, pending, cleanup: { childStopped: true, serversStopped: true } },
          null,
          2,
        ),
      )
      .then(() => {
        clearTimeout(timeout)
        child.kill()
        page.closeAllConnections()
        provider.closeAllConnections()
        page.close()
        provider.close()
        app.exit(message.succeeded ? 0 : 1)
      })
  })
}

void main().catch(async (error) => {
  await fs.writeFile(
    path.join(root, "main-error.log"),
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  )
  app.exit(1)
})
