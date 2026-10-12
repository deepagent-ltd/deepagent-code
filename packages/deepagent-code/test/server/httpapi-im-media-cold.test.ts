import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Database } from "bun:sqlite"
import { MediaIntent } from "@deepagent-code/core/im/media-intent"

const fixture = path.resolve(import.meta.dir, "../fixture/im-media-cold-host.ts")
const wait = async <T>(read: () => Promise<T | undefined>, description: string) => {
  const end = Date.now() + 25_000
  while (Date.now() < end) {
    const value = await read()
    if (value !== undefined) return value
    await Bun.sleep(20)
  }
  throw new Error(`Timed out: ${description}`)
}

test.each(["upload-lost", "uploaded-before-send", "send-lost"])(
  "actual TUI + file DB kill/reopen: %s",
  async (scenario) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-media-cold-")))
    await Promise.all(
      ["home", "tmp", "config", "data", "cache", "state", "project", "client"].map((name) =>
        fs.mkdir(path.join(root, name)),
      ),
    )
    const environment = {
      PATH: process.env.PATH,
      HOME: path.join(root, "home"),
      TMPDIR: path.join(root, "tmp"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      DEEPAGENT_CODE_HOME: path.join(root, "data"),
      DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"),
      DEEPAGENT_CODE_DB: path.join(root, "authority.sqlite"),
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
      DEEPAGENT_IM_AGENT_RESPONDER: "off",
      DEEPAGENT_CODE_V4_FILE_UPLOAD_ENABLED: "true",
      DEEPAGENT_CODE_SERVER_PASSWORD: "private-media-fixture",
      DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "1",
      DEEPAGENT_CODE_V2_OWNER_CAMPAIGN: "",
      DEEPAGENT_CODE_V2_OWNER_PUBLIC_KEY: "",
      NO_COLOR: "1",
    }
    const headers = {
      authorization: `Basic ${Buffer.from("deepagent-code:private-media-fixture").toString("base64")}`,
      "x-deepagent-code-directory": encodeURIComponent(path.join(root, "project")),
    }
    const children: Array<{ child: Bun.Subprocess<"pipe", "pipe", "pipe">; output: Promise<string[]>; name: string }> =
      []
    const spawn = (name: string) => {
      const child = Bun.spawn(
        [
          process.execPath,
          "--conditions=browser",
          "--preload",
          path.resolve(import.meta.dir, "../../../tui/node_modules/@opentui/solid/scripts/preload.js"),
          fixture,
          root,
          name,
        ],
        { cwd: path.join(root, "project"), env: environment, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      )
      const value = {
        child,
        name,
        output: Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]),
      }
      children.push(value)
      return value
    }
    async function jsonReady(name: string) {
      return wait(async () => {
        const child = children.findLast((item) => item.name === name)?.child
        if (child && (child.exitCode !== null || child.signalCode !== null))
          throw new Error(`Fixture ${name} exited before ready`)
        return (await Bun.file(path.join(root, `${name}-ready.json`)).exists())
          ? ((await Bun.file(path.join(root, `${name}-ready.json`)).json()) as { url: string; pid: number })
          : undefined
      }, `${name} ready`)
    }
    const gate = Promise.withResolvers<void>()
    const observed = Promise.withResolvers<void>()
    const state = {
      backend: "",
      uploaded: false,
      gated: false,
      calls: [] as Array<{ method: string; pathname: string; requestID?: string }>,
    }
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        const bytes = request.method === "POST" ? await request.arrayBuffer() : undefined
        const record = {
          method: request.method,
          pathname: url.pathname,
          requestID:
            request.headers.get("content-type")?.includes("json") && bytes
              ? JSON.parse(new TextDecoder().decode(bytes)).clientRequestID
              : undefined,
        }
        state.calls.push(record)
        const forwarded = new Headers(request.headers)
        forwarded.delete("host")
        const response = await fetch(new URL(url.pathname + url.search, state.backend), {
          method: request.method,
          headers: forwarded,
          body: bytes,
          redirect: "error",
        })
        const body = await response.arrayBuffer()
        if (record.method === "POST" && record.pathname === "/api/v1/im/attachments") state.uploaded = true
        const hold =
          !state.gated &&
          response.ok &&
          ((scenario === "upload-lost" && record.method === "POST" && record.pathname === "/api/v1/im/attachments") ||
            (scenario === "uploaded-before-send" && state.uploaded && record.pathname === "/global/capabilities") ||
            (scenario === "send-lost" && record.method === "POST" && record.pathname.endsWith("/messages")))
        if (hold) {
          state.gated = true
          observed.resolve()
          await gate.promise
        }
        return new Response(body, { status: response.status, headers: response.headers })
      },
    })
    function snapshot() {
      const db = new Database(path.join(root, "authority.sqlite"), { readonly: true })
      try {
        return {
          attachments: db
            .query<
              { id: string; message_id: string | null; checksum: string; created_at: number; storage_path: string },
              []
            >("SELECT id,message_id,checksum,created_at,storage_path FROM im_attachments")
            .all(),
          messages: db
            .query<
              { id: string; client_request_id: string },
              []
            >("SELECT id,client_request_id FROM im_messages WHERE type='file'")
            .all(),
          inputs: db.query<{ count: number }, []>("SELECT count(*) AS count FROM session_input").get()!.count,
          providers: db
            .query<{ count: number }, []>("SELECT count(*) AS count FROM session_v2_provider_turn_receipt")
            .get()!.count,
        }
      } finally {
        db.close()
      }
    }
    try {
      const host = spawn("host")
      state.backend = (await jsonReady("host")).url
      const response = await fetch(new URL("/api/v1/im/groups", state.backend), {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ type: "project", name: "Private media cold fixture" }),
      })
      expect(response.status).toBe(200)
      const group = await response.json()
      const source = path.join(root, "source.txt")
      await fs.writeFile(source, "GUI and TUI same bytes 中文 @Agent")
      const input = {
        url: proxy.url.href,
        headers,
        directory: path.join(root, "project"),
        clientRoot: path.join(root, "client"),
        group,
        source,
        start: true,
      }
      await Bun.write(path.join(root, "live-input.json"), JSON.stringify(input))
      const live = spawn("live")
      await Promise.race([
        observed.promise,
        live.child.exited.then(() => {
          throw new Error("TUI exited before controlled ACK window")
        }),
        Bun.sleep(25_000).then(() => {
          throw new Error("TUI did not reach controlled ACK window")
        }),
      ])
      live.child.kill("SIGKILL")
      await live.child.exited
      const journal = path.join(root, "client/state/im-media-v1/records.json")
      const before = MediaIntent.records(await Bun.file(journal).json())
      expect(before).toHaveLength(1)
      expect(MediaIntent.observedPhase(before[0])).toBe(
        scenario === "upload-lost"
          ? "upload_outcome_unknown"
          : scenario === "send-lost"
            ? "send_outcome_unknown"
            : "uploaded_unbound",
      )
      const initial = snapshot()
      expect(initial.attachments).toHaveLength(1)
      expect(initial.messages).toHaveLength(scenario === "send-lost" ? 1 : 0)
      gate.resolve()
      host.child.kill("SIGKILL")
      await host.child.exited
      await fs.rm(path.join(root, "host-ready.json"))
      spawn("host")
      state.backend = (await jsonReady("host")).url
      const writes = state.calls.filter((call) => call.method === "POST").length
      await Bun.write(path.join(root, "cold-input.json"), JSON.stringify({ ...input, start: false }))
      const cold = spawn("cold")
      await jsonReady("cold")
      cold.child.stdin.write(JSON.stringify({ action: "snapshot", id: "opened" }) + "\n")
      const frame = await wait(
        async () =>
          (await Bun.file(path.join(root, "cold-opened.txt")).exists())
            ? await Bun.file(path.join(root, "cold-opened.txt")).text()
            : undefined,
        "cold frame",
      )
      expect(state.calls.filter((call) => call.method === "POST")).toHaveLength(writes)
      expect(snapshot()).toEqual(initial)
      expect(MediaIntent.records(await Bun.file(journal).json())[0].requestID).toBe(before[0].requestID)
      if (scenario === "upload-lost") {
        expect(frame).toContain("Upload result unknown")
        expect(frame).not.toContain("Retry same message")
      } else {
        cold.child.stdin.write(JSON.stringify({ action: "retry", id: "retry" }) + "\n")
        await wait(
          async () => ((await Bun.file(path.join(root, "cold-sent.json")).exists()) ? true : undefined),
          "exact retry receipt",
        )
        const final = snapshot()
        expect(final.attachments).toHaveLength(1)
        expect(final.messages).toHaveLength(1)
        expect(final.messages[0].client_request_id).toBe(before[0].requestID)
        expect(final.attachments[0].message_id).toBe(final.messages[0].id)
        expect(final.attachments[0].created_at).toBe(initial.attachments[0].created_at)
        expect(final.attachments[0].checksum).toBe(initial.attachments[0].checksum)
        expect(
          state.calls.filter((call) => call.method === "POST" && call.pathname === "/api/v1/im/attachments"),
        ).toHaveLength(1)
        expect(
          state.calls.filter((call) => call.requestID).every((call) => call.requestID === before[0].requestID),
        ).toBe(true)
      }
      expect(snapshot().inputs).toBe(0)
      expect(snapshot().providers).toBe(0)
      await Bun.write(
        path.join(root, "result.json"),
        JSON.stringify({ scenario, initial, final: snapshot(), requests: state.calls, fixtureDevMint: true }, null, 2),
      )
    } finally {
      gate.resolve()
      await proxy.stop(true)
      for (const item of children) {
        if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill("SIGTERM")
        const timer = setTimeout(() => item.child.kill("SIGKILL"), 5000)
        await item.child.exited
        clearTimeout(timer)
        await Bun.write(path.join(root, `${item.name}-${item.child.pid}.log`), (await item.output).join("\n"))
      }
      console.info("IM_MEDIA_COLD_EVIDENCE", scenario, root)
    }
  },
  100_000,
)
