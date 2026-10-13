import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createServer } from "node:http"
import { Database } from "bun:sqlite"

const scenarios = ["native media", "directory alias", "unknown outcome"] as const
const selected = process.env.DEEPAGENT_TEST_MCP_RUNNER_CHILD
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII="
const wait = async <A>(read: () => Promise<A | undefined>, label: string, timeout = 30_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await read()
    if (result !== undefined) return result
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out: ${label}`)
}

function environment(root: string) {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: path.join(root, "home"),
    TMPDIR: path.join(root, "tmp"),
    TMP: path.join(root, "tmp"),
    TEMP: path.join(root, "tmp"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    DEEPAGENT_CODE_HOME: path.join(root, "data"),
    DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"),
    DEEPAGENT_CODE_DB: path.join(root, "authority.sqlite"),
    DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "1",
    DEEPAGENT_CODE_V2_OWNER_CAMPAIGN: "",
    DEEPAGENT_CODE_V2_OWNER_PUBLIC_KEY: "",
    DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
    DEEPAGENT_IM_AGENT_RESPONDER: "off",
    NO_COLOR: "1",
  }
}

// Other MCP suites mock modules process-wide. The entire provider/HTTP/stdio experiment
// runs in a clean child, not merely the stdio server, when included in the package suite.
if (!selected)
  test.each([...scenarios])(
    "real MCP → host SessionExecution → provider: %s",
    async (scenario) => {
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-mcp-runner-")))
      await Promise.all(
        ["home", "tmp", "config", "data", "cache", "state", "project"].map((name) => fs.mkdir(path.join(root, name))),
      )
      const child = Bun.spawn([process.execPath, "test", import.meta.path, "--timeout", "90000"], {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: {
          ...environment(root),
          DEEPAGENT_TEST_MCP_RUNNER_CHILD: scenario,
          DEEPAGENT_TEST_MCP_RUNNER_ROOT: root,
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const timer = setTimeout(() => child.kill("SIGKILL"), 100_000)
      try {
        const [status, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        await Bun.write(`${root}/child.log`, stdout + stderr)
        console.info("MCP_RUNNER_EVIDENCE", scenario, root)
        expect({ status, output: status === 0 ? "ok" : stdout + stderr }).toEqual({ status: 0, output: "ok" })
        expect(stdout + stderr).toMatch(/\b1 pass\b/)
        expect(stdout + stderr).toMatch(/\b0 fail\b/)
        const result = await Bun.file(`${root}/result.json`).json()
        expect(result.scenario).toBe(scenario)
        expect(result.pid).toBe(child.pid)
        expect(result.pid).not.toBe(process.pid)
        console.info("MCP_RUNNER_RESULT", JSON.stringify(result))
      } finally {
        clearTimeout(timer)
        child.kill()
      }
    },
    110_000,
  )

if (selected) {
  if (!scenarios.some((scenario) => scenario === selected)) throw new Error("Unknown MCP runner scenario")
  test(`real host runner: ${selected}`, async () => {
    const root = process.env.DEEPAGENT_TEST_MCP_RUNNER_ROOT!
    const alias = path.join(root, "project-alias")
    if (selected === "directory alias") await fs.symlink(path.join(root, "project"), alias, "junction")
    const directory = selected === "directory alias" ? alias : path.join(root, "project")
    const requests: Record<string, unknown>[] = []
    const resourceHits: string[] = []
    const provider = createServer(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        resourceHits.push(request.url ?? "missing")
        response.writeHead(404).end()
        return
      }
      const parts: Buffer[] = []
      for await (const part of request) parts.push(Buffer.from(part))
      const body = JSON.parse(Buffer.concat(parts).toString()) as Record<string, unknown>
      requests.push(body)
      await Bun.write(`${root}/provider-${requests.length}.json`, JSON.stringify(body, null, 2))
      const tools = body.tools as { function: { name: string } }[]
      const name = tools.find((tool) => tool.function.name === "mcp__fixture__probe")?.function.name
      response.writeHead(200, { "content-type": "text/event-stream" })
      const delta =
        requests.length === 1 && name
          ? { tool_calls: [{ index: 0, id: "call_mcp_runner", type: "function", function: { name, arguments: "{}" } }] }
          : { content: "MCP integration complete" }
      for (const chunk of [
        { choices: [{ index: 0, delta: { role: "assistant" } }] },
        { choices: [{ index: 0, delta }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: requests.length === 1 && name ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        },
      ])
        response.write(
          `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 0, model: "test-model", ...chunk })}\n\n`,
        )
      response.end("data: [DONE]\n\n")
    })
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve))
    const address = provider.address()
    if (!address || typeof address === "string") throw new Error("Missing provider address")
    const url = `http://127.0.0.1:${address.port}`
    await Bun.write(
      path.join(root, "project", "deepagent-code.json"),
      JSON.stringify({
        formatter: false,
        lsp: false,
        model: "fixture/test-model",
        permission: { "*": "allow" },
        provider: {
          fixture: {
            name: "Fixture",
            npm: "@ai-sdk/openai-compatible",
            env: [],
            options: { apiKey: "local-fixture", baseURL: `${url}/v1` },
            models: {
              "test-model": {
                id: "test-model",
                name: "Fixture",
                attachment: true,
                tool_call: true,
                modalities: { input: ["text", "image"], output: ["text"] },
                limit: { context: 100_000, output: 10_000 },
                cost: { input: 0, output: 0 },
              },
            },
          },
        },
        mcp: {
          fixture: {
            type: "local",
            command: [
              process.execPath,
              path.resolve(import.meta.dir, "fixture/runner-e2e-mcp.ts"),
              root,
              selected === "unknown outcome" ? "unknown" : "success",
              `${url}/resource-never-fetch`,
            ],
            protocol: "2026-07-28",
            enabled: true,
            timeout: 5_000,
          },
        },
      }),
    )
    type Host = {
      child: Bun.Subprocess<"pipe", "pipe", "pipe">
      output: Promise<[string, string]>
      ready: { url: string; pid: number }
      phase: string
    }
    const hosts: Host[] = []
    async function start(phase: string) {
      const child = Bun.spawn(
        [process.execPath, path.resolve(import.meta.dir, "fixture/runner-e2e-host.ts"), root, phase],
        {
          cwd: directory,
          env: environment(root),
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      const ready = await wait(async () => {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Host ${phase} exited before ready`)
        return (await Bun.file(`${root}/host-${phase}-ready.json`).exists())
          ? ((await Bun.file(`${root}/host-${phase}-ready.json`).json()) as { url: string; pid: number })
          : undefined
      }, "host ready").catch(async (error) => {
        child.kill("SIGKILL")
        await child.exited
        await Bun.write(`${root}/host-${phase}.log`, (await output).join("\n"))
        throw error
      })
      const host = { child, output, ready, phase }
      hosts.push(host)
      return host
    }
    async function command(host: Host, type: "wait" | "resume", sessionID: string, id: string) {
      host.child.stdin.write(JSON.stringify({ type, sessionID, id }) + "\n")
      return await wait(
        async () =>
          (await Bun.file(`${root}/command-${id}.json`).exists())
            ? ((await Bun.file(`${root}/command-${id}.json`).json()) as { status: string; cause?: string })
            : undefined,
        `${type} ${id}`,
      )
    }
    async function stop(host: Host) {
      if (host.child.exitCode === null && host.child.signalCode === null)
        host.child.stdin.write(JSON.stringify({ type: "stop", id: "stop" }) + "\n")
      const timer = setTimeout(() => host.child.kill("SIGKILL"), 10_000)
      await host.child.exited
      clearTimeout(timer)
      await Bun.write(`${root}/host-${host.phase}.log`, (await host.output).join("\n"))
    }
    function snapshot() {
      const database = new Database(path.join(root, "authority.sqlite"), { readonly: true })
      try {
        return {
          sessions: database
            .query<Record<string, unknown>, []>("SELECT id, directory, execution_claim_token FROM session")
            .all(),
          inputs: database.query<Record<string, unknown>, []>("SELECT * FROM session_input").all(),
          admissions: database
            .query<Record<string, unknown>, []>("SELECT * FROM session_v2_tool_effect_admission")
            .all(),
          effects: database.query<Record<string, unknown>, []>("SELECT * FROM session_v2_tool_effect").all(),
          providers: database
            .query<
              Record<string, unknown>,
              []
            >("SELECT receipt_id, provider_attempt_id, state FROM session_v2_provider_turn_receipt ORDER BY request_ordinal")
            .all(),
          events: database
            .query<
              { type: string; data: string },
              []
            >("SELECT type, data FROM event WHERE type LIKE 'session.execution.%' ORDER BY sync_seq")
            .all(),
        }
      } finally {
        database.close()
      }
    }
    try {
      const host = await start("initial")
      const request = async (route: string, body: unknown) => {
        const response = await fetch(new URL(route, host.ready.url), {
          method: "POST",
          headers: { "content-type": "application/json", "x-deepagent-code-directory": directory },
          body: JSON.stringify(body),
        })
        const text = await response.text()
        expect({ status: response.status, body: response.ok ? "ok" : text }).toEqual({ status: 200, body: "ok" })
        return JSON.parse(text)
      }
      const created = await request("/api/session", { model: { id: "test-model", providerID: "fixture" } })
      const admitted = await request(`/api/session/${created.data.id}/prompt`, {
        prompt: { text: "Call fixture probe once, then summarize its returned observation." },
        resume: true,
      })
      expect(admitted.data.id).toBeTruthy()
      await wait(
        async () => ((await Bun.file(`${root}/mcp-body.log`).exists()) ? true : undefined),
        "actual stdio tool body",
      )
      await command(host, "wait", created.data.id, "initial-idle")
      const dispatched = snapshot()
      await Bun.write(`${root}/snapshot-dispatched.json`, JSON.stringify(dispatched, null, 2))
      expect(dispatched.sessions[0]?.directory).toBe(path.join(root, "project"))
      expect(dispatched.inputs).toHaveLength(1)
      expect(dispatched.inputs[0]?.id).toBe(admitted.data.id)
      expect(dispatched.inputs[0]?.promoted_seq).toBeNumber()
      expect(dispatched.admissions).toHaveLength(1)
      expect(dispatched.admissions[0]).toMatchObject({
        tool_name: "mcp__fixture__probe",
        tool_call_id: "call_mcp_runner",
        effect_kind: "mutating",
      })
      expect(dispatched.sessions[0]?.execution_claim_token).toBeNull()
      expect(
        (requests[0]!.tools as { function: { name: string } }[]).some(
          (tool) => tool.function.name === "mcp__fixture__probe",
        ),
      ).toBe(true)
      if (selected !== "unknown outcome") {
        expect(requests).toHaveLength(2)
        expect(dispatched.effects).toHaveLength(1)
        expect(dispatched.effects[0]).toMatchObject({
          state: "settled",
          receipt_id: dispatched.admissions[0]?.receipt_id,
          provider_attempt_id: dispatched.admissions[0]?.provider_attempt_id,
        })
        expect(dispatched.effects[0]?.outcome_hash).toMatch(/^[a-f0-9]{64}$/)
        expect(dispatched.providers.map((receipt) => receipt.state)).toEqual(["settled", "settled"])
        expect(dispatched.events.at(-1)?.type).toBe("session.execution.succeeded.1")
        const messages = requests[1]!.messages as {
          role: string
          content: string | null | { type: string; image_url?: { url: string } }[]
        }[]
        const images = messages
          .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
          .filter((part) => part.type === "image_url")
        expect(images).toEqual([{ type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }])
        const tool = messages.find((message) => message.role === "tool")!
        expect(typeof tool.content).toBe("string")
        expect((tool.content as string).match(/mcp_e2e_answer/g)).toHaveLength(1)
        expect(tool.content).toContain(`${url}/resource-never-fetch`)
        expect(tool.content).not.toContain(png)
      }
      if (selected === "unknown outcome") {
        expect(requests).toHaveLength(1)
        expect(dispatched.effects).toEqual([])
        expect(dispatched.events.at(-1)?.type).toBe("session.execution.failed.1")
        expect(dispatched.events.at(-1)?.data).toContain("V2ToolEffect.RecoveryRequiredError")
        const same = await command(host, "resume", created.data.id, "same-resume")
        await Bun.write(`${root}/snapshot-same-resume.json`, JSON.stringify(snapshot(), null, 2))
        expect(same.status).toBe("Failure")
        expect(same.cause).toContain("V2ToolEffect.RecoveryRequiredError")
        expect(requests).toHaveLength(1)
        expect(snapshot().admissions).toEqual(dispatched.admissions)
        expect(snapshot().effects).toEqual([])
        expect(snapshot().inputs).toEqual(dispatched.inputs)
        expect(snapshot().providers).toEqual(dispatched.providers)
        await stop(host)
        expect(host.child.exitCode).toBe(0)
        expect(await Bun.file(`${root}/host-initial-stopped.json`).exists()).toBe(true)
        const reopened = await start("reopened")
        expect(reopened.ready.pid).not.toBe(host.ready.pid)
        const cold = await command(reopened, "resume", created.data.id, "cold-resume")
        const recovered = snapshot()
        await Bun.write(`${root}/snapshot-cold-resume.json`, JSON.stringify(recovered, null, 2))
        expect(cold.status).toBe("Failure")
        expect(cold.cause).toContain("V2ToolEffect.RecoveryRequiredError")
        expect(requests).toHaveLength(1)
        expect(recovered.admissions).toEqual(dispatched.admissions)
        expect(recovered.effects).toEqual([])
        expect(recovered.inputs).toEqual(dispatched.inputs)
        expect(recovered.providers).toEqual(dispatched.providers)
      }
      expect(resourceHits).toEqual([])
      expect(await Bun.file(`${root}/resource-read.log`).exists()).toBe(false)
      expect((await Bun.file(`${root}/mcp-body.log`).text()).trim().split("\n")).toHaveLength(1)
      await Bun.write(
        `${root}/result.json`,
        JSON.stringify({
          scenario: selected,
          pid: process.pid,
          hostPIDs: hosts.map((host) => host.ready.pid),
          providerRequests: requests.length,
          toolBodies: 1,
          resourceReads: resourceHits.length,
          fixtureDevMint: true,
          inputID: admitted.data.id,
          admissionID: dispatched.admissions[0]?.admission_id,
          receiptID: dispatched.admissions[0]?.receipt_id,
          directory,
          storedDirectory: dispatched.sessions[0]?.directory,
        }),
      )
    } finally {
      for (const host of hosts) await stop(host)
      provider.closeAllConnections()
      await new Promise<void>((resolve) => provider.close(() => resolve()))
      for (const host of hosts)
        expect({ phase: host.phase, exit: host.child.exitCode }).toEqual({ phase: host.phase, exit: 0 })
    }
  }, 90_000)
}
