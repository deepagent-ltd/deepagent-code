import { describe, expect, test } from "bun:test"
import path from "node:path"
import { chmod, stat } from "node:fs/promises"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { contentDigest } from "@deepagent-code/core/contract/digest"
import { ConfigV1 } from "@deepagent-code/core/v1/config/config"
import { IMAgentExecution } from "../../src/im/im-agent-execution"
import {
  assertHistoryOracle,
  assertHistoryRemoteReply,
  historyLoopback,
  historyReply,
  historySessionID,
  historyText,
  parseHistoryArgs,
  probeConfiguration,
  readExecutionSnapshot,
  runHistoryMatrix,
  startHistoryProvider,
} from "../../script/im-history-execution-matrix"
import type { ExecutionSnapshot, HistoryMatrixState, ProviderHit } from "../../script/im-history-execution-matrix"
import { tmpdir } from "../fixture/fixture"

function scenario() {
  const state: HistoryMatrixState = {
    version: 1,
    run: "69f63859-5b68-4e23-a968-b50a447c9e98",
    agent: "improbe012345abcdef",
    a: "http://127.0.0.1:4625",
    b: "http://127.0.0.1:4622",
    aDirectory: "/private/a/project",
    bDirectory: "/private/b/project",
    aDB: "/private/a/im.db",
    bDB: "/private/b/im.db",
    home: "/private/a/home",
    kernel: "k:2:real-group",
    aGroup: "a-local-group",
    bGroup: "b-local-group",
    identities: { a: { uuid: "a-user", name: "甲" }, b: { uuid: "b-user", name: "乙" } },
    history: { localID: "b-H", kernelID: "kernel-H" },
    live: { localID: "b-L", kernelID: "kernel-L" },
    provider: { url: "http://127.0.0.1:4700", instance: "2659b8bc-dbae-4967-ad34-8cdffb9e84ab" },
  }
  const session = IMAgentExecution.imSessionIDFor(state.aGroup!, state.agent)
  const input = IMAgentExecution.imPromptIDFor("a-L", state.agent)
  const snapshot: ExecutionSnapshot = {
    history: [
      {
        id: "a-H",
        group_id: state.aGroup!,
        sender_id: "b-user",
        sender_type: "user",
        content: historyText(state, "H"),
        kernel_msg_id: "kernel-H",
      },
    ],
    live: [
      {
        id: "a-L",
        group_id: state.aGroup!,
        sender_id: "b-user",
        sender_type: "user",
        content: historyText(state, "L"),
        kernel_msg_id: "kernel-L",
      },
    ],
    intents: [
      {
        message_id: "a-L",
        agent_name: state.agent,
        status: "admitted",
        origin: "kernel_live",
        receiver_id: "a-user",
        session_id: session,
        input_id: input,
      },
    ],
    inputs: [
      {
        id: input,
        session_id: session,
        promoted_seq: 1,
        prompt: JSON.stringify({ text: `IM message from b-user: ${historyText(state, "L")}` }),
      },
    ],
    receipts: [
      {
        session_id: session,
        user_message_id: input,
        provider_attempt_id: "attempt-1",
        state: "settled",
        model_id: "im02-model",
        provider_id: "im02",
      },
    ],
    attempts: [{ session_id: session, attempt_id: "attempt-1", state: "settled" }],
    outbox: [
      {
        id: "outbox-1",
        session_id: session,
        group_id: state.aGroup!,
        agent_id: state.agent,
        trigger_message_id: input,
        reply_text: historyReply(state),
        status: "delivered",
      },
    ],
    replies: [
      {
        id: `imsg_reply_${contentDigest("outbox-1").slice(0, 40)}`,
        group_id: state.aGroup!,
        sender_id: state.agent,
        sender_type: "agent",
        content: historyReply(state),
        kernel_msg_id: "kernel-reply",
      },
    ],
  }
  const provider: ProviderHit[] = [
    {
      run: state.run,
      instance: state.provider!.instance,
      at: 1,
      model: "im02-model",
      history: false,
      live: true,
      tools: 0,
      accepted: true,
      requestHash: "hash",
    },
  ]
  return { state, snapshot, provider }
}

describe("IM02 durable execution oracle", () => {
  test("accepts a full positive chain using production stable identities and different local group IDs", () => {
    const sample = scenario()
    expect(historySessionID(sample.state)).toBe(IMAgentExecution.imSessionIDFor("a-local-group", sample.state.agent))
    expect(() => assertHistoryOracle(sample.state, sample.snapshot, sample.provider, true)).not.toThrow()
  })

  test("historical admission is rejected even when every positive assertion is otherwise satisfied", () => {
    const sample = scenario()
    sample.snapshot.intents.push({ ...sample.snapshot.intents[0], message_id: "a-H" })
    expect(() => assertHistoryOracle(sample.state, sample.snapshot, sample.provider, true)).toThrow("HISTORY_EXECUTED")
  })

  test("a noop execution owner cannot pass the positive control", () => {
    const sample = scenario()
    sample.snapshot.inputs[0].promoted_seq = null
    expect(() => assertHistoryOracle(sample.state, sample.snapshot, sample.provider, true)).toThrow(
      "LIVE_INPUT_NOT_PROMOTED_EXACTLY_ONCE",
    )
  })

  test("a settled but unrelated provider attempt cannot satisfy the ledger", () => {
    const sample = scenario()
    sample.snapshot.attempts[0].attempt_id = "unrelated"
    expect(() => assertHistoryOracle(sample.state, sample.snapshot, sample.provider, true)).toThrow(
      "LIVE_PROVIDER_ATTEMPT_NOT_SETTLED",
    )
  })

  test("provider retries and historical transport are rejected", () => {
    const sample = scenario()
    expect(() =>
      assertHistoryOracle(sample.state, sample.snapshot, [...sample.provider, ...sample.provider], true),
    ).toThrow("LIVE_HTTP_NOT_EXACT")
    sample.provider[0].history = true
    expect(() => assertHistoryOracle(sample.state, sample.snapshot, sample.provider, true)).toThrow("HISTORY_EXECUTED")
  })

  test("a reply for another input is rejected even with a delivered outbox", () => {
    const sample = scenario()
    sample.snapshot.outbox[0].trigger_message_id = "other-input"
    expect(() => assertHistoryOracle(sample.state, sample.snapshot, sample.provider, true)).toThrow(
      "LIVE_OUTBOX_NOT_DELIVERED",
    )
  })

  test("remote reply requires one message with the receiver binding, source identity and same kernel ACK", () => {
    const sample = scenario()
    const reply = {
      id: "b-reply",
      groupID: sample.state.bGroup,
      senderID: sample.state.identities.a.uuid,
      senderType: "user",
      content: `[Agent·${sample.state.agent}] ${historyReply(sample.state)}`,
    }
    expect(() => assertHistoryRemoteReply(sample.state, [reply], "ack", "ack")).not.toThrow()
    expect(() => assertHistoryRemoteReply(sample.state, [reply, reply], "ack", "ack")).toThrow(
      "REMOTE_REPLY_MISSING_OR_DUPLICATED",
    )
    expect(() =>
      assertHistoryRemoteReply(sample.state, [{ ...reply, groupID: sample.state.aGroup! }], "ack", "ack"),
    ).toThrow("REMOTE_REPLY_AUTHOR_OR_BINDING_MISMATCH")
    expect(() => assertHistoryRemoteReply(sample.state, [reply], "ack", "unrelated")).toThrow(
      "REMOTE_REPLY_KERNEL_ID_MISMATCH",
    )
  })

  test("negative phase accepts only visible history with no admission or transport", () => {
    const sample = scenario()
    const snapshot: ExecutionSnapshot = {
      history: sample.snapshot.history,
      live: [],
      intents: [],
      inputs: [],
      receipts: [],
      attempts: [],
      outbox: [],
      replies: [],
    }
    expect(() => assertHistoryOracle(sample.state, snapshot, [], false)).not.toThrow()
    expect(() => assertHistoryOracle(sample.state, snapshot, sample.provider, false)).toThrow(
      "NEGATIVE_PHASE_HAS_EXECUTION",
    )
  })

  test("file-backed SQL snapshot preserves exact source identities and never writes to the DB", async () => {
    await using temporary = await tmpdir()
    const sample = scenario()
    const file = path.join(temporary.path, "oracle.db")
    using db = new Database(file)
    // Minimal ledger fixtures test the real read-only SQL adapter; they do not stand in for runner acceptance.
    db.exec(`CREATE TABLE im_messages(id TEXT,group_id TEXT,sender_id TEXT,sender_type TEXT,content TEXT,kernel_msg_id TEXT);
      CREATE TABLE im_mention_intent(message_id TEXT,agent_name TEXT,status TEXT,origin TEXT,receiver_id TEXT,session_id TEXT,input_id TEXT);
      CREATE TABLE session_input(id TEXT,session_id TEXT,promoted_seq INTEGER,prompt TEXT);
      CREATE TABLE session_v2_provider_turn_receipt(session_id TEXT,user_message_id TEXT,provider_attempt_id TEXT,state TEXT,model_id TEXT,provider_id TEXT);
      CREATE TABLE session_provider_attempt(attempt_id TEXT,session_id TEXT,state TEXT);
      CREATE TABLE im_reply_outbox(id TEXT,session_id TEXT,group_id TEXT,agent_id TEXT,trigger_message_id TEXT,reply_text TEXT,status TEXT);`)
    const h = sample.snapshot.history[0]
    db.query("INSERT INTO im_messages VALUES(?,?,?,?,?,?)").run(
      h.id,
      h.group_id,
      h.sender_id,
      h.sender_type,
      h.content,
      h.kernel_msg_id,
    )
    const before = db.query<{ count: number }, []>("select count(*) as count from im_messages").get()
    const read = readExecutionSnapshot(file, sample.state)
    expect(read.history).toEqual(sample.snapshot.history)
    expect(() => assertHistoryOracle(sample.state, read, [], false)).not.toThrow()
    expect(db.query<{ count: number }, []>("select count(*) as count from im_messages").get()).toEqual(before)
  })
})

describe("IM02 opt-in and provider boundary", () => {
  test("rejects remote URLs, URL credentials and implicit consent", async () => {
    for (const url of [
      "https://127.0.0.1",
      "http://example.com",
      "http://localhost:4625",
      "http://key@127.0.0.1",
      "http://127.0.0.1/forward",
    ])
      expect(() => historyLoopback(url)).toThrow("NUMERIC_LOOPBACK_REQUIRED")
    const options = parseHistoryArgs(["--phase", "history", "--state", "/private/test/state.json"])
    await expect(runHistoryMatrix(options)).rejects.toThrow("EXPLICIT_ALLOW_REAL_KERNEL_REQUIRED")
    const config = probeConfiguration(scenario().state, "http://127.0.0.1:4900")
    expect(config.enabled_providers).toEqual(["im02"])
    expect(config.agent[scenario().state.agent].permission).toEqual({ "*": "deny" })
    expect(Schema.decodeUnknownSync(ConfigV1.Info)(config).agent?.[scenario().state.agent]?.permission).toEqual({
      "*": "deny",
    })
  })

  test("deterministic loopback HTTP records accepted live request, rejects history and tools", async () => {
    await using temporary = await tmpdir()
    const sample = scenario()
    const ledger = path.join(temporary.path, "hits.jsonl")
    await using provider = await startHistoryProvider(sample.state, ledger)
    const send = (text: string, tools?: unknown[]) =>
      fetch(`${provider.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "im02-model", stream: true, messages: [{ role: "user", content: text }], tools }),
      })
    const live = await send(historyText(sample.state, "L"))
    expect(live.status).toBe(200)
    expect(await live.text()).toContain(historyReply(sample.state))
    expect((await send(historyText(sample.state, "H"))).status).toBe(400)
    expect((await send(historyText(sample.state, "L"), [{ type: "function" }])).status).toBe(400)
    const entries = (await Bun.file(ledger).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as ProviderHit)
    expect(entries.map((hit) => hit.accepted)).toEqual([true, false, false])
    expect(entries.map((hit) => hit.history)).toEqual([false, true, false])
    expect((await stat(ledger)).mode & 0o077).toBe(0)
  })

  test("prepare only reads B, creates a private isolated configuration root, and requires a new A port", async () => {
    await using temporary = await tmpdir()
    const requests: string[] = []
    const roster: { agent?: string } = {}
    using receiver = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests.push(`${request.method} ${new URL(request.url).pathname}`)
        if (new URL(request.url).pathname === "/api/v1/im/status")
          return Response.json({
            facade: "active",
            kernel: "connected",
            recovery: { status: "ready" },
            identity: { uuid: "b-user", name: "乙" },
          })
        return Response.json(
          roster.agent ? [{ id: roster.agent, name: roster.agent, displayName: roster.agent, visible: true }] : [],
        )
      },
    })
    const unused = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    const a = `http://127.0.0.1:${unused.port}`
    await unused.stop(true)
    const source = path.join(temporary.path, "source.json")
    const sample = scenario()
    await Bun.write(
      source,
      JSON.stringify({
        a: "http://127.0.0.1:4611",
        b: `http://127.0.0.1:${receiver.port}`,
        bDirectory: temporary.path,
        identities: sample.state.identities,
        group: { b: "b-group", bKernel: "k:2:group", verified: true },
      }),
    )
    await chmod(source, 0o600)
    const state = path.join(temporary.path, "isolated", "state.json")
    using database = new Database(path.join(temporary.path, "b.db"))
    database.exec(
      "CREATE TABLE im_groups(id TEXT,kernel_conv_id TEXT); INSERT INTO im_groups VALUES('b-group','k:2:group');",
    )
    const prepared = await runHistoryMatrix({
      phase: "prepare",
      state,
      allowRealKernel: true,
      sourceState: source,
      a,
      bDB: path.join(temporary.path, "b.db"),
    })
    expect(prepared.result).toBe("PREPARED_ONLY")
    expect(requests).toEqual(["GET /api/v1/im/agents"])
    expect((await stat(state)).mode & 0o077).toBe(0)
    expect((await Bun.file(state).json()).aDB).toBe(path.join(temporary.path, "isolated", "data", "im.db"))
    const launch = await Bun.file(path.join(temporary.path, "isolated", "launch-env.json")).json()
    expect(launch.DEEPAGENT_CODE_TEST_HOME).toBe(path.join(temporary.path, "isolated"))
    expect(launch.DEEPAGENT_IM_WORKSPACE_ID).toBe((await Bun.file(state).json()).aDirectory)
    expect(launch.DEEPAGENT_CODE_V2_OWNER_DEV_MINT).toBe("1")
    expect(launch.DEEPAGENT_CODE_V2_OWNER_CAMPAIGN).toBe("")
    expect(launch.DEEPAGENT_CODE_V2_OWNER_AUTHORIZATION_PUBLIC_KEY).toBe("")
    expect(launch.DEEPAGENT_CODE_V2_BUILD_IDENTITY).toBe("")
    expect(launch.DEEPAGENT_CODE_V2_DEV_CAMPAIGN).toBe("")
    expect(launch.DEEPAGENT_CODE_HOME).toBe("")
    const preparedState = (await Bun.file(state).json()) as HistoryMatrixState
    await using provider = await startHistoryProvider(preparedState, path.join(temporary.path, "provider.jsonl"))
    preparedState.provider = { url: provider.url, instance: provider.instance }
    roster.agent = preparedState.agent
    await Bun.write(state, JSON.stringify(preparedState))
    await expect(runHistoryMatrix({ phase: "history", state, allowRealKernel: true })).rejects.toThrow(
      "PROBE_AGENT_EXISTS_ON_B",
    )
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true)
  })
})
