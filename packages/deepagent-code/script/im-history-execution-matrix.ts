#!/usr/bin/env bun
// Opt-in IM-02: real kernel + app/Session runner, deterministic loopback provider transport.
// prepare -> provider (separate process) -> history -> operator starts isolated A -> negative
// -> positive -> verify. This script never starts/stops an app server or reads model/kernel keys.
import { lstat, mkdir, open, realpath, rename } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { Database } from "bun:sqlite"
import { z } from "zod"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import type { DeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { contentDigest } from "@deepagent-code/core/contract/digest"
import { readMatrixMessages } from "./im-gray-matrix"

const Identity = z.object({ uuid: z.string().min(1), name: z.string().min(1) })
const Sent = z.object({ localID: z.string(), kernelID: z.string().min(1) })
const State = z.object({
  version: z.literal(1),
  run: z.string().uuid(),
  agent: z.string().regex(/^improbe[0-9a-f]{12}$/),
  a: z.string(),
  b: z.string(),
  aDirectory: z.string(),
  bDirectory: z.string(),
  aDB: z.string(),
  bDB: z.string(),
  home: z.string(),
  kernel: z.string().startsWith("k:2:"),
  bGroup: z.string(),
  aGroup: z.string().optional(),
  identities: z.object({ a: Identity, b: Identity }),
  provider: z.object({ url: z.string(), instance: z.string().uuid() }).optional(),
  aRuntime: z.string().optional(),
  history: Sent.optional(),
  live: Sent.optional(),
  negativeAt: z.number().optional(),
  verifiedAt: z.number().optional(),
})
export type HistoryMatrixState = z.infer<typeof State>
export type HistoryMatrixOptions = {
  phase: "prepare" | "provider" | "history" | "negative" | "positive" | "verify"
  state: string
  allowRealKernel: boolean
  sourceState?: string
  a?: string
  bDB?: string
  timeoutMs?: number
}
const Hit = z.object({
  run: z.string(),
  instance: z.string(),
  at: z.number(),
  model: z.string(),
  history: z.boolean(),
  live: z.boolean(),
  tools: z.number().int(),
  accepted: z.boolean(),
  requestHash: z.string(),
})
export type ProviderHit = z.infer<typeof Hit>
type MessageRow = {
  id: string
  group_id: string
  sender_id: string
  sender_type: string
  content: string
  kernel_msg_id: string | null
}
export type ExecutionSnapshot = {
  history: MessageRow[]
  live: MessageRow[]
  intents: {
    message_id: string
    agent_name: string
    status: string
    origin: string
    receiver_id: string | null
    session_id: string | null
    input_id: string | null
  }[]
  inputs: { id: string; session_id: string; promoted_seq: number | null; prompt: string }[]
  receipts: {
    session_id: string
    user_message_id: string
    provider_attempt_id: string | null
    state: string
    model_id: string
    provider_id: string
  }[]
  attempts: { attempt_id: string; session_id: string; state: string }[]
  outbox: {
    id: string
    session_id: string
    group_id: string
    agent_id: string
    trigger_message_id: string | null
    reply_text: string
    status: string
  }[]
  replies: MessageRow[]
}

export class HistoryMatrixError extends Error {
  constructor(
    readonly code: string,
    readonly http?: { status?: number; endpoint?: string },
  ) {
    super(code)
  }
}
function requireValue(value: unknown, code: string): asserts value {
  if (!value) throw new HistoryMatrixError(code)
}
export function historyLoopback(value: string) {
  const url = new URL(value)
  requireValue(
    url.protocol === "http:" &&
      ["127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash,
    "NUMERIC_LOOPBACK_REQUIRED",
  )
  return url.origin
}
export const historyText = (state: HistoryMatrixState, kind: "H" | "L") =>
  `@${state.identities.a.name} @${state.agent} IM02:${state.run}:${kind}`
export const historyReply = (state: HistoryMatrixState) => `IM02-REPLY:${state.run}`
export const historySessionID = (state: HistoryMatrixState) =>
  `ses_im_${contentDigest(`${state.aGroup}:${state.agent}`).slice(0, 24)}`
const promptID = (message: string, agent: string) => `msg_${contentDigest(`im:${message}:${agent}`).slice(0, 40)}`
const providerFile = (file: string) => path.join(path.dirname(file), "provider-hits.jsonl")

async function privateJSON(file: string, value: unknown, exclusive = false) {
  const temporary = exclusive ? file : `${file}.${crypto.randomUUID()}.tmp`
  {
    await using handle = await open(temporary, "wx", 0o600)
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await handle.sync()
  }
  if (!exclusive) await rename(temporary, file)
}
async function readPrivate(file: string) {
  const stat = await lstat(file)
  requireValue(stat.isFile() && (stat.mode & 0o077) === 0, "PRIVATE_REGULAR_FILE_REQUIRED")
  return (await Bun.file(file).json()) as unknown
}
async function result<T>(pending: Promise<{ data?: T; response?: Response }>) {
  const value = await pending.catch(() => {
    throw new HistoryMatrixError("HTTP_REQUEST_FAILED")
  })
  if (!value.response?.ok || value.data === undefined)
    throw new HistoryMatrixError("HTTP_RESPONSE_FAILED", {
      status: value.response?.status,
      endpoint: value.response?.url ? new URL(value.response.url).pathname : undefined,
    })
  return value.data
}
function client(url: string, directory: string) {
  const base = historyLoopback(url)
  return createDeepAgentCodeClient({
    baseUrl: base,
    directory,
    fetch: Object.assign(
      (request: Parameters<typeof fetch>[0]) => {
        const target = new URL(request instanceof Request ? request.url : String(request))
        requireValue(target.origin === base, "HTTP_ORIGIN_CHANGED")
        return fetch(request, { signal: AbortSignal.timeout(5_000), redirect: "error" })
      },
      { preconnect: fetch.preconnect },
    ),
  })
}
async function offline(url: string) {
  const refused = await fetch(`${historyLoopback(url)}/global/health`, {
    signal: AbortSignal.timeout(2000),
    redirect: "error",
  }).then(
    () => false,
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ECONNREFUSED" || error.code === "ConnectionRefused"),
  )
  requireValue(refused, "A_MUST_NOT_BE_RUNNING")
}
async function poll<T>(options: HistoryMatrixOptions, read: () => Promise<T | undefined>) {
  const deadline = Date.now() + (options.timeoutMs ?? 120_000)
  do {
    const value = await read()
    if (value !== undefined) return value
    await Bun.sleep(500)
  } while (Date.now() < deadline)
  throw new HistoryMatrixError("OBSERVATION_TIMEOUT")
}
async function roster(client: DeepAgentCodeClient, agent: string, present: boolean) {
  const matches = (await result(client.im.agents.list())).filter(
    (item) => item.name.toLowerCase() === agent.toLowerCase(),
  )
  requireValue(
    present
      ? matches.length === 1 &&
          matches[0].visible &&
          (!matches[0].triggers?.length || matches[0].triggers.some((trigger) => trigger.event === "mention"))
      : matches.length === 0,
    present ? "A_PROBE_AGENT_NOT_DISPATCHABLE" : "PROBE_AGENT_EXISTS_ON_B",
  )
}
async function ready(state: HistoryMatrixState, side: "a" | "b") {
  const api = client(state[side], side === "a" ? state.aDirectory : state.bDirectory)
  const status = await result(api.im.facade.status())
  requireValue(
    status.facade === "active" &&
      status.kernel === "connected" &&
      status.recovery?.status === "ready" &&
      status.identity.uuid === state.identities[side].uuid,
    `${side.toUpperCase()}_NOT_READY_OR_IDENTITY_CHANGED`,
  )
  return api
}
function readonly(file: string) {
  requireValue(path.isAbsolute(file), "ABSOLUTE_DB_REQUIRED")
  return new Database(file, { readonly: true, strict: true })
}
function senderBinding(state: HistoryMatrixState) {
  using db = readonly(state.bDB)
  const group = db
    .query<{ kernel_conv_id: string | null }, [string]>("select kernel_conv_id from im_groups where id = ?")
    .get(state.bGroup)
  requireValue(group?.kernel_conv_id === state.kernel, "SENDER_DB_BINDING_MISMATCH")
}
async function hits(file: string, state: HistoryMatrixState) {
  const lines = (await Bun.file(providerFile(file)).text()).trim().split("\n").filter(Boolean)
  const entries = lines.map((line) => Hit.parse(JSON.parse(line)))
  requireValue(
    entries.every((entry) => entry.run === state.run && entry.instance === state.provider?.instance),
    "PROVIDER_LEDGER_IDENTITY_CHANGED",
  )
  return entries
}
async function runtimeFingerprint(state: HistoryMatrixState) {
  const metadata = z
    .object({ token: z.string(), pid: z.number().int(), createdAt: z.string() })
    .parse(await Bun.file(`${state.aDB}.runtime.lock/meta.json`).json())
  return contentDigest(JSON.stringify(metadata))
}

export function readExecutionSnapshot(file: string, state: HistoryMatrixState): ExecutionSnapshot {
  requireValue(state.aGroup, "A_BINDING_REQUIRED")
  using db = readonly(file)
  const session = historySessionID(state)
  return {
    history: db
      .query<
        MessageRow,
        [string]
      >("select id,group_id,sender_id,sender_type,content,kernel_msg_id from im_messages where kernel_msg_id = ?")
      .all(state.history?.kernelID ?? ""),
    live: db
      .query<
        MessageRow,
        [string]
      >("select id,group_id,sender_id,sender_type,content,kernel_msg_id from im_messages where kernel_msg_id = ?")
      .all(state.live?.kernelID ?? ""),
    intents: db
      .query<
        ExecutionSnapshot["intents"][number],
        [string]
      >("select message_id,agent_name,status,origin,receiver_id,session_id,input_id from im_mention_intent where agent_name = ?")
      .all(state.agent),
    inputs: db
      .query<
        ExecutionSnapshot["inputs"][number],
        [string]
      >("select id,session_id,promoted_seq,prompt from session_input where session_id = ?")
      .all(session),
    receipts: db
      .query<
        ExecutionSnapshot["receipts"][number],
        [string]
      >("select session_id,user_message_id,provider_attempt_id,state,model_id,provider_id from session_v2_provider_turn_receipt where session_id = ?")
      .all(session),
    attempts: db
      .query<
        ExecutionSnapshot["attempts"][number],
        [string]
      >("select attempt_id,session_id,state from session_provider_attempt where session_id = ?")
      .all(session),
    outbox: db
      .query<
        ExecutionSnapshot["outbox"][number],
        [string]
      >("select id,session_id,group_id,agent_id,trigger_message_id,reply_text,status from im_reply_outbox where session_id = ?")
      .all(session),
    replies: db
      .query<
        MessageRow,
        [string, string]
      >("select id,group_id,sender_id,sender_type,content,kernel_msg_id from im_messages where group_id = ? and content = ?")
      .all(state.aGroup, historyReply(state)),
  }
}

export function assertHistoryOracle(
  state: HistoryMatrixState,
  snapshot: ExecutionSnapshot,
  provider: ProviderHit[],
  positive: boolean,
) {
  const history = snapshot.history
  requireValue(
    history.length === 1 &&
      history[0].group_id === state.aGroup &&
      history[0].sender_id === state.identities.b.uuid &&
      history[0].sender_type === "user" &&
      history[0].content === historyText(state, "H") &&
      history[0].kernel_msg_id === state.history?.kernelID,
    "HISTORY_MESSAGE_MISMATCH",
  )
  const historicalInput = promptID(history[0].id, state.agent)
  requireValue(
    !snapshot.intents.some((row) => row.message_id === history[0].id) &&
      !snapshot.inputs.some((row) => row.id === historicalInput) &&
      !snapshot.receipts.some((row) => row.user_message_id === historicalInput) &&
      !provider.some((hit) => hit.history),
    "HISTORY_EXECUTED",
  )
  if (!positive) {
    requireValue(
      [
        snapshot.intents,
        snapshot.inputs,
        snapshot.receipts,
        snapshot.attempts,
        snapshot.outbox,
        snapshot.replies,
        provider,
      ].every((rows) => rows.length === 0),
      "NEGATIVE_PHASE_HAS_EXECUTION",
    )
    return
  }
  requireValue(snapshot.live.length === 1, "LIVE_MESSAGE_MISSING_OR_DUPLICATED")
  const live = snapshot.live[0]
  const id = promptID(live.id, state.agent)
  const session = historySessionID(state)
  requireValue(
    live.group_id === state.aGroup &&
      live.sender_id === state.identities.b.uuid &&
      live.sender_type === "user" &&
      live.content === historyText(state, "L") &&
      live.kernel_msg_id === state.live?.kernelID,
    "LIVE_MESSAGE_MISMATCH",
  )
  requireValue(
    snapshot.intents.length === 1 &&
      snapshot.intents[0].message_id === live.id &&
      snapshot.intents[0].origin === "kernel_live" &&
      snapshot.intents[0].receiver_id === state.identities.a.uuid &&
      snapshot.intents[0].status === "admitted" &&
      snapshot.intents[0].input_id === id &&
      snapshot.intents[0].session_id === session,
    "LIVE_INTENT_NOT_EXACT",
  )
  requireValue(
    snapshot.inputs.length === 1 &&
      snapshot.inputs[0].id === id &&
      snapshot.inputs[0].session_id === session &&
      snapshot.inputs[0].promoted_seq !== null &&
      snapshot.inputs[0].prompt.includes(historyText(state, "L")),
    "LIVE_INPUT_NOT_PROMOTED_EXACTLY_ONCE",
  )
  requireValue(
    snapshot.receipts.length === 1 &&
      snapshot.receipts[0].user_message_id === id &&
      snapshot.receipts[0].state === "settled" &&
      snapshot.receipts[0].provider_id === "im02" &&
      snapshot.receipts[0].model_id === "im02-model",
    "LIVE_PROVIDER_RECEIPT_NOT_SETTLED",
  )
  requireValue(
    snapshot.attempts.length === 1 &&
      snapshot.attempts[0].attempt_id === snapshot.receipts[0].provider_attempt_id &&
      snapshot.attempts[0].state === "settled",
    "LIVE_PROVIDER_ATTEMPT_NOT_SETTLED",
  )
  requireValue(
    provider.length === 1 &&
      provider[0].live &&
      provider[0].accepted &&
      provider[0].tools === 0 &&
      provider[0].model === "im02-model",
    "LIVE_HTTP_NOT_EXACT",
  )
  requireValue(
    snapshot.outbox.length === 1 &&
      snapshot.outbox[0].trigger_message_id === id &&
      snapshot.outbox[0].group_id === state.aGroup &&
      snapshot.outbox[0].agent_id === state.agent &&
      snapshot.outbox[0].reply_text === historyReply(state) &&
      snapshot.outbox[0].status === "delivered",
    "LIVE_OUTBOX_NOT_DELIVERED",
  )
  requireValue(
    snapshot.replies.length === 1 &&
      snapshot.replies[0].id === `imsg_reply_${contentDigest(snapshot.outbox[0].id).slice(0, 40)}` &&
      snapshot.replies[0].sender_type === "agent" &&
      snapshot.replies[0].sender_id === state.agent &&
      snapshot.replies[0].kernel_msg_id,
    "LOCAL_REPLY_NOT_KERNEL_ACKNOWLEDGED",
  )
}

export function assertHistoryRemoteReply(
  state: HistoryMatrixState,
  replies: { id: string; groupID: string; senderID: string; senderType: string; content: string }[],
  localKernelID: string | null,
  remoteKernelID: string | null | undefined,
) {
  requireValue(replies.length === 1, "REMOTE_REPLY_MISSING_OR_DUPLICATED")
  requireValue(
    replies[0].groupID === state.bGroup &&
      replies[0].senderID === state.identities.a.uuid &&
      replies[0].senderType === "user" &&
      replies[0].content === `[Agent·${state.agent}] ${historyReply(state)}`,
    "REMOTE_REPLY_AUTHOR_OR_BINDING_MISMATCH",
  )
  requireValue(localKernelID && remoteKernelID === localKernelID, "REMOTE_REPLY_KERNEL_ID_MISMATCH")
}

async function send(options: HistoryMatrixOptions, state: HistoryMatrixState, kind: "H" | "L") {
  const b = await ready(state, "b")
  await roster(b, state.agent, false)
  senderBinding(state)
  const groups = (await result(b.im.groups.list())).filter((group) => group.kernelConvID === state.kernel)
  requireValue(groups.length === 1 && groups[0].id === state.bGroup, "SENDER_HTTP_BINDING_MISMATCH")
  const input = {
    groupId: state.bGroup,
    directory: state.bDirectory,
    type: "text" as const,
    senderType: "user" as const,
    content: historyText(state, kind),
    clientRequestID: `im02:${state.run}:${kind}`,
  }
  const first = await result(b.im.messages.create(input))
  const second = await result(b.im.messages.create(input))
  requireValue(
    first.id === second.id && first.content === input.content && second.content === input.content,
    "SEND_EXACT_RETRY_FAILED",
  )
  return await poll(options, async () => {
    using db = readonly(state.bDB)
    const row = db
      .query<
        MessageRow,
        [string]
      >("select id,group_id,sender_id,sender_type,content,kernel_msg_id from im_messages where id = ?")
      .get(first.id)
    requireValue(row?.content === input.content && row.group_id === state.bGroup, "SENDER_DB_MESSAGE_MISMATCH")
    return row.kernel_msg_id ? { localID: row.id, kernelID: row.kernel_msg_id } : undefined
  })
}

export function probeConfiguration(state: HistoryMatrixState, providerURL: string) {
  return {
    model: "im02/im02-model",
    small_model: "im02/im02-model",
    enabled_providers: ["im02"],
    permission: { "*": "deny" },
    provider: {
      im02: {
        name: "IM02 deterministic loopback",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        options: { baseURL: `${historyLoopback(providerURL)}/v1`, apiKey: "im02-local-fixture-only", maxRetries: 0 },
        models: {
          "im02-model": {
            name: "IM02 deterministic",
            attachment: false,
            reasoning: false,
            tool_call: true,
            limit: { context: 100000, output: 1000 },
            cost: { input: 0, output: 0 },
          },
        },
      },
    },
    agent: {
      [state.agent]: {
        mode: "all",
        model: "im02/im02-model",
        description: "Isolated IM02 transport probe",
        prompt: "Reply briefly. Never use tools.",
        permission: { "*": "deny" },
        tools: { "*": false },
        steps: 1,
      },
    },
  }
}

export async function startHistoryProvider(state: HistoryMatrixState, ledger: string) {
  const instance = crypto.randomUUID()
  const file = await open(ledger, "wx", 0o600)
  const { reply } = await import("../test/lib/llm-server")
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/health") return Response.json({ run: state.run, instance })
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions")
        return new Response(null, { status: 404 })
      const parsed = z
        .object({
          model: z.string(),
          messages: z.array(z.unknown()),
          stream: z.boolean().optional(),
          tools: z.array(z.unknown()).optional(),
        })
        .safeParse(await request.json().catch(() => null))
      const body = parsed.success ? JSON.stringify(parsed.data.messages) : ""
      const hit: ProviderHit = {
        run: state.run,
        instance,
        at: Date.now(),
        model: parsed.success ? parsed.data.model : "invalid",
        history: body.includes(`IM02:${state.run}:H`),
        live: body.includes(`IM02:${state.run}:L`),
        tools: parsed.success ? (parsed.data.tools?.length ?? 0) : 0,
        accepted: false,
        requestHash: contentDigest(body),
      }
      hit.accepted = parsed.success && hit.model === "im02-model" && hit.tools === 0 && !hit.history && hit.live
      await file.write(`${JSON.stringify(hit)}\n`)
      await file.sync()
      if (!hit.accepted) return Response.json({ error: { message: "IM02 fixture rejected request" } }, { status: 400 })
      if (!parsed.success || !parsed.data.stream)
        return Response.json({
          id: "im02",
          object: "chat.completion",
          created: 1,
          model: hit.model,
          choices: [{ index: 0, message: { role: "assistant", content: historyReply(state) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      const item = reply().text(historyReply(state)).usage({ input: 1, output: 1 }).stop().item()
      if (item.type !== "sse") return new Response(null, { status: 500 })
      return new Response(
        [...item.head, ...item.tail].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    instance,
    async close() {
      await server.stop(true)
      await file.close()
    },
    async [Symbol.asyncDispose]() {
      await server.stop(true)
      await file.close()
    },
  }
}

export async function runHistoryMatrix(options: HistoryMatrixOptions) {
  requireValue(options.allowRealKernel, "EXPLICIT_ALLOW_REAL_KERNEL_REQUIRED")
  requireValue(path.isAbsolute(options.state), "ABSOLUTE_STATE_REQUIRED")
  const repository = await realpath(path.resolve(import.meta.dir, "../../.."))
  const stateRoot = path.dirname(options.state)
  const canonicalRoot = path.join(await realpath(path.dirname(stateRoot)), path.basename(stateRoot))
  requireValue(
    canonicalRoot !== repository && !canonicalRoot.startsWith(`${repository}${path.sep}`),
    "RUNTIME_ROOT_MUST_BE_OUTSIDE_REPOSITORY",
  )
  requireValue(
    options.timeoutMs === undefined ||
      (Number.isInteger(options.timeoutMs) && options.timeoutMs >= 1000 && options.timeoutMs <= 600000),
    "INVALID_TIMEOUT",
  )
  if (options.phase === "prepare") {
    requireValue(
      options.sourceState && options.a && options.bDB && path.isAbsolute(options.bDB),
      "PREPARE_OPTIONS_REQUIRED",
    )
    const source = z
      .object({
        a: z.string(),
        b: z.string(),
        bDirectory: z.string(),
        identities: z.object({ a: Identity, b: Identity }),
        group: z.object({ b: z.string(), bKernel: z.string().startsWith("k:2:"), verified: z.literal(true) }),
      })
      .parse(await readPrivate(options.sourceState))
    const a = historyLoopback(options.a)
    requireValue(a !== historyLoopback(source.a) && a !== historyLoopback(source.b), "NEW_A_PORT_REQUIRED")
    await offline(a)
    const run = crypto.randomUUID()
    const agent = `improbe${run.replaceAll("-", "").slice(0, 12)}`
    await roster(client(source.b, source.bDirectory), agent, false)
    const root = path.dirname(options.state)
    await mkdir(root, { mode: 0o700 })
    for (const directory of ["home", "project", "data", "config", "cache", "tmp"])
      await mkdir(path.join(root, directory), { mode: 0o700 })
    const state: HistoryMatrixState = {
      version: 1,
      run,
      agent,
      a,
      b: historyLoopback(source.b),
      aDirectory: await realpath(path.join(root, "project")),
      bDirectory: source.bDirectory,
      aDB: path.join(root, "data/im.db"),
      bDB: options.bDB,
      home: path.join(root, "home"),
      kernel: source.group.bKernel,
      bGroup: source.group.b,
      identities: source.identities,
    }
    senderBinding(state)
    await privateJSON(options.state, state, true)
    await privateJSON(
      path.join(root, "launch-env.json"),
      {
        HOME: state.home,
        TMPDIR: path.join(root, "tmp"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        DEEPAGENT_CODE_DB: state.aDB,
        DEEPAGENT_CODE_TEST_HOME: root,
        DEEPAGENT_CODE_HOME: "",
        DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "1",
        DEEPAGENT_CODE_V2_OWNER_CAMPAIGN: "",
        DEEPAGENT_CODE_V2_OWNER_AUTHORIZATION_PUBLIC_KEY: "",
        DEEPAGENT_CODE_V2_BUILD_IDENTITY: "",
        DEEPAGENT_CODE_V2_DEV_CAMPAIGN: "",
        DEEPAGENT_IM_WORKSPACE_ID: state.aDirectory,
        DEEPAGENT_IM_AGENT_RESPONDER: "on",
        DEEPAGENT_IM_AGENT_RESPONDER_DIRECTORY: state.aDirectory,
        note: "Start only after HISTORY_ACKNOWLEDGED. Supply only the already-authorized A facade key through a private keyfile. Clear inherited model keys. App server is operator-owned.",
      },
      true,
    )
    return { result: "PREPARED_ONLY", run, agent, state: options.state, next: "provider" }
  }
  const state = State.parse(await readPrivate(options.state))
  historyLoopback(state.a)
  historyLoopback(state.b)
  requireValue(
    state.a !== state.b && state.identities.a.uuid !== state.identities.b.uuid,
    "DISTINCT_ENDPOINTS_AND_IDENTITIES_REQUIRED",
  )
  requireValue(
    state.aDirectory === (await realpath(path.join(path.dirname(options.state), "project"))) &&
      state.aDB === path.join(path.dirname(options.state), "data/im.db") &&
      state.home === path.join(path.dirname(options.state), "home"),
    "ISOLATED_PATHS_CHANGED",
  )
  if (options.phase === "provider") {
    requireValue(!state.provider, "PROVIDER_ALREADY_INITIALIZED")
    await offline(state.a)
    await using provider = await startHistoryProvider(state, providerFile(options.state))
    state.provider = { url: provider.url, instance: provider.instance }
    await privateJSON(path.join(state.aDirectory, "deepagent-code.json"), probeConfiguration(state, provider.url), true)
    await privateJSON(options.state, state)
    console.log(JSON.stringify({ result: "DETERMINISTIC_PROVIDER_READY", run: state.run, url: provider.url }))
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve)
      process.once("SIGINT", resolve)
    })
    return { result: "OWN_PROVIDER_STOPPED" }
  }
  requireValue(state.provider, "PROVIDER_REQUIRED")
  const health = z.object({ run: z.string(), instance: z.string() }).parse(
    await fetch(`${historyLoopback(state.provider.url)}/health`, {
      signal: AbortSignal.timeout(2000),
      redirect: "error",
    }).then((response) => response.json()),
  )
  requireValue(
    typeof health === "object" &&
      health !== null &&
      health.run === state.run &&
      health.instance === state.provider.instance,
    "PROVIDER_IDENTITY_CHANGED",
  )
  if (options.phase === "history") {
    requireValue(!state.negativeAt && !state.live, "HISTORY_PHASE_CLOSED")
    await offline(state.a)
    state.history = await send(options, state, "H")
    await offline(state.a)
    await privateJSON(options.state, state)
    return {
      result: "HISTORY_ACKNOWLEDGED",
      run: state.run,
      next: "Start isolated A using prepared configuration, then negative",
    }
  }
  requireValue(state.history, "ACKNOWLEDGED_HISTORY_REQUIRED")
  const a = await poll(options, async () => {
    const api = client(state.a, state.aDirectory)
    const status = await result(api.im.facade.status())
    if (status.facade !== "active" || status.kernel !== "connected" || status.recovery?.status !== "ready") return
    requireValue(status.identity.uuid === state.identities.a.uuid, "A_IDENTITY_CHANGED")
    return api
  })
  const runtime = await runtimeFingerprint(state)
  requireValue(!state.aRuntime || state.aRuntime === runtime, "A_RUNTIME_CHANGED_BETWEEN_CONTROLS")
  state.aRuntime = runtime
  await roster(a, state.agent, true)
  const config = await result(a.config.get())
  const configured = probeConfiguration(state, state.provider.url)
  requireValue(
    config.enabled_providers?.length === 1 &&
      config.enabled_providers[0] === "im02" &&
      config.model === configured.model &&
      config.provider?.im02?.options?.baseURL === configured.provider.im02.options.baseURL &&
      config.agent?.[state.agent]?.model === configured.model &&
      JSON.stringify(config.agent?.[state.agent]?.permission) === JSON.stringify({ "*": "deny" }),
    "A_EFFECTIVE_CONFIG_NOT_ISOLATED",
  )
  await roster(await ready(state, "b"), state.agent, false)
  const groups = (await result(a.im.groups.list())).filter((group) => group.kernelConvID === state.kernel)
  requireValue(groups.length === 1 && (!state.aGroup || state.aGroup === groups[0].id), "A_KERNEL_BINDING_MISMATCH")
  state.aGroup = groups[0].id
  await privateJSON(options.state, state)
  if (options.phase === "negative") {
    requireValue(!state.live && !state.negativeAt, "NEGATIVE_PHASE_ALREADY_CLOSED")
    await poll(options, async () => (readExecutionSnapshot(state.aDB, state).history.length === 1 ? true : undefined))
    const visible = (await readMatrixMessages(a, state.aGroup)).messages.filter(
      (message) => message.content === historyText(state, "H"),
    )
    requireValue(
      visible.length === 1 &&
        visible[0].senderID === state.identities.b.uuid &&
        visible[0].id === readExecutionSnapshot(state.aDB, state).history[0].id,
      "HISTORY_NOT_VISIBLE_THROUGH_API",
    )
    // A full kernel drain interval (30 s) and the local intent reconciler (5 s) both run inside this observation.
    const until = Date.now() + 35_000
    do {
      assertHistoryOracle(state, readExecutionSnapshot(state.aDB, state), await hits(options.state, state), false)
      await Bun.sleep(500)
    } while (Date.now() < until)
    await ready(state, "a")
    requireValue((await runtimeFingerprint(state)) === state.aRuntime, "A_RUNTIME_CHANGED_DURING_NEGATIVE")
    state.negativeAt = Date.now()
    await privateJSON(options.state, state)
    return {
      result: "HISTORY_NEGATIVE_ONLY",
      run: state.run,
      next: "positive",
      acceptance: "requires same-runtime positive control",
    }
  }
  requireValue(state.negativeAt, "NEGATIVE_PHASE_REQUIRED")
  if (options.phase === "positive") {
    state.live = await send(options, state, "L")
    await privateJSON(options.state, state)
    return { result: "LIVE_ACKNOWLEDGED_ONLY", run: state.run, next: "verify" }
  }
  requireValue(state.live, "LIVE_PHASE_REQUIRED")
  const evidence = await poll(options, async () => {
    const snapshot = readExecutionSnapshot(state.aDB, state)
    const provider = await hits(options.state, state)
    // Wait only for asynchronous terminal projections; reject historical execution immediately.
    requireValue(!provider.some((hit) => hit.history), "HISTORY_EXECUTED")
    if (
      !snapshot.outbox.some((row) => row.status === "delivered") ||
      !snapshot.replies.some((row) => row.kernel_msg_id)
    )
      return
    assertHistoryOracle(state, snapshot, provider, true)
    const messages = (await readMatrixMessages(await ready(state, "b"), state.bGroup)).messages
    const replies = messages.filter((message) => message.content === `[Agent·${state.agent}] ${historyReply(state)}`)
    requireValue(replies.length <= 1, "REMOTE_REPLY_DUPLICATED")
    if (!replies.length) return
    using db = readonly(state.bDB)
    const row = db
      .query<{ kernel_msg_id: string | null }, [string]>("select kernel_msg_id from im_messages where id = ?")
      .get(replies[0].id)
    assertHistoryRemoteReply(state, replies, snapshot.replies[0].kernel_msg_id, row?.kernel_msg_id)
    return {
      session: historySessionID(state),
      historyMessageID: snapshot.history[0].id,
      historyPromptID: promptID(snapshot.history[0].id, state.agent),
      liveMessageID: snapshot.live[0].id,
      livePromptID: snapshot.inputs[0].id,
      providerAttemptID: snapshot.receipts[0].provider_attempt_id,
      providerRequestHash: provider[0].requestHash,
      outboxID: snapshot.outbox[0].id,
      localReplyID: snapshot.replies[0].id,
      remoteReplyID: replies[0].id,
      replyKernelID: row?.kernel_msg_id,
      historyInput: 0,
      liveInput: 1,
      providerReceipt: 1,
      providerHTTP: 1,
      outbox: 1,
      remoteReply: 1,
    }
  })
  state.verifiedAt = Date.now()
  await privateJSON(options.state, state)
  await privateJSON(path.join(path.dirname(options.state), "evidence.json"), {
    result: "IM02_PASS",
    provider: "deterministic-loopback-transport",
    run: state.run,
    ...evidence,
  })
  return { result: "IM02_PASS", provider: "deterministic-loopback-transport", run: state.run, ...evidence }
}

export function parseHistoryArgs(args: string[]): HistoryMatrixOptions {
  const values = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      phase: { type: "string" },
      state: { type: "string" },
      "allow-real-kernel": { type: "boolean" },
      "source-state": { type: "string" },
      a: { type: "string" },
      "b-db": { type: "string" },
      "timeout-ms": { type: "string" },
    },
  }).values
  requireValue(
    values.state &&
      values.phase &&
      ["prepare", "provider", "history", "negative", "positive", "verify"].includes(values.phase),
    "REQUIRED_OPTIONS_MISSING",
  )
  return {
    state: values.state,
    phase: values.phase as HistoryMatrixOptions["phase"],
    allowRealKernel: values["allow-real-kernel"] ?? false,
    sourceState: values["source-state"],
    a: values.a,
    bDB: values["b-db"],
    timeoutMs: values["timeout-ms"] ? Number(values["timeout-ms"]) : undefined,
  }
}
if (import.meta.main) {
  Promise.resolve()
    .then(() => runHistoryMatrix(parseHistoryArgs(Bun.argv.slice(2))))
    .then((value) => console.log(JSON.stringify(value)))
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          result: "IM02_FAILED",
          code: error instanceof HistoryMatrixError ? error.code : "MATRIX_IO_OR_CONTRACT_ERROR",
          http: error instanceof HistoryMatrixError ? error.http : undefined,
        }),
      )
      process.exitCode = 1
    })
}
