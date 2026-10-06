#!/usr/bin/env bun
// Runs against two already-started, isolated servers. Never starts/stops servers or calls a model.
// bun script/im-gray-matrix.ts --a http://127.0.0.1:4611 --b http://127.0.0.1:4612 \
//   --phase status --state /private/path/im-matrix.json
import { lstat, mkdir, open, rename } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import type { DeepAgentCodeClient, ImMessagesListResponse } from "@deepagent-code/sdk/client"

const Identity = z.object({ uuid: z.string().min(1), name: z.string().min(1), viewerID: z.string().min(1) })
const Binding = z.object({
  a: z.string().min(1),
  b: z.string().min(1),
  aKernel: z.string(),
  bKernel: z.string(),
  verified: z.boolean(),
})
const State = z.object({
  version: z.literal(1),
  run: z.string().uuid(),
  a: z.string().url(),
  b: z.string().url(),
  aDirectory: z.string().optional(),
  bDirectory: z.string().optional(),
  identities: z.object({ a: Identity, b: Identity }),
  direct: Binding.extend({ firstDiscovery: z.boolean() }).optional(),
  group: Binding.optional(),
  burst: z.object({ count: z.number().int().min(21).max(180), sent: z.number().int().nonnegative() }).optional(),
})
type MatrixState = z.infer<typeof State>
type Phase = "status" | "direct" | "group" | "burst-send" | "burst-verify" | "counts"
export type MatrixOptions = {
  a: string
  b: string
  phase: Phase
  state: string
  count?: number
  timeoutMs?: number
  pollMs?: number
  allowExistingDirect?: boolean
  db?: string
  aDirectory?: string
  bDirectory?: string
}

export class MatrixError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export function parseMatrixArgs(args: string[]): MatrixOptions {
  const parsed = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      a: { type: "string" },
      b: { type: "string" },
      phase: { type: "string" },
      state: { type: "string" },
      count: { type: "string" },
      "timeout-ms": { type: "string" },
      db: { type: "string" },
      "allow-existing-direct": { type: "boolean" },
      "a-directory": { type: "string" },
      "b-directory": { type: "string" },
    },
  }).values
  if (!parsed.a || !parsed.b || !parsed.state || !parsed.phase) throw new MatrixError("MISSING_REQUIRED_OPTION")
  if (!["status", "direct", "group", "burst-send", "burst-verify", "counts"].includes(parsed.phase))
    throw new MatrixError("INVALID_PHASE")
  return {
    a: parsed.a,
    b: parsed.b,
    state: parsed.state,
    phase: parsed.phase as Phase,
    count: parsed.count === undefined ? undefined : Number(parsed.count),
    timeoutMs: parsed["timeout-ms"] === undefined ? undefined : Number(parsed["timeout-ms"]),
    allowExistingDirect: parsed["allow-existing-direct"],
    db: parsed.db,
    aDirectory: parsed["a-directory"],
    bDirectory: parsed["b-directory"],
  }
}

function loopback(value: string) {
  const url = new URL(value)
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new MatrixError("LOOPBACK_URL_REQUIRED")
  return url.origin
}

async function response<T>(pending: Promise<{ data?: T; response?: Response; error?: unknown }>): Promise<T> {
  const result = await pending.catch(() => {
    throw new MatrixError("REQUEST_FAILED")
  })
  if (!result.response?.ok || result.data === undefined)
    throw new MatrixError(result.response ? `HTTP_${result.response.status}` : "REQUEST_FAILED")
  return result.data
}

async function save(file: string, state: MatrixState) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  {
    await using handle = await open(temporary, "wx", 0o600)
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`)
  }
  await rename(temporary, file)
}

async function load(file: string) {
  const stat = await lstat(file).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return
    throw new MatrixError("STATE_UNREADABLE")
  })
  if (!stat) return
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new MatrixError("STATE_MUST_BE_PRIVATE_FILE")
  const parsed = State.safeParse(await Bun.file(file).json())
  if (!parsed.success) throw new MatrixError("INVALID_STATE")
  return parsed.data
}

async function poll<T>(options: MatrixOptions, read: () => Promise<T | undefined>) {
  const deadline = Date.now() + (options.timeoutMs ?? 90_000)
  do {
    const value = await read()
    if (value !== undefined) return value
    await Bun.sleep(options.pollMs ?? 1_000)
  } while (Date.now() < deadline)
  throw new MatrixError("OBSERVATION_TIMEOUT")
}

async function bound(client: DeepAgentCodeClient, kernelConvID: string) {
  const groups = (await response(client.im.groups.list())).filter((group) => group.kernelConvID === kernelConvID)
  if (groups.length > 1) throw new MatrixError("DUPLICATE_KERNEL_BINDING")
  return groups[0]
}

export async function readMatrixMessages(client: DeepAgentCodeClient, groupId: string) {
  const messages: ImMessagesListResponse["messages"] = []
  const ids = new Set<string>()
  const cursors = new Set<string>()
  const progress: { cursor?: string } = {}
  for (let pageNumber = 1; pageNumber <= 100; pageNumber++) {
    const page = await response(client.im.messages.list({ groupId, cursor: progress.cursor, limit: "20" }))
    for (const message of page.messages) {
      if (message.groupID !== groupId) throw new MatrixError("MESSAGE_GROUP_MISMATCH")
      if (ids.has(message.id)) throw new MatrixError("DUPLICATE_PAGE_MESSAGE")
      ids.add(message.id)
      messages.push(message)
    }
    if (!page.hasMore) return { messages, pages: pageNumber }
    if (!page.nextCursor || cursors.has(page.nextCursor)) throw new MatrixError("STALLED_CURSOR")
    cursors.add(page.nextCursor)
    progress.cursor = page.nextCursor
  }
  throw new MatrixError("PAGE_BUDGET_EXCEEDED")
}

async function exactSend(
  client: DeepAgentCodeClient,
  groupId: string,
  content: string,
  clientRequestID: string,
  directory?: string,
) {
  const input = { groupId, content, clientRequestID, directory, senderType: "user" as const, type: "text" as const }
  const first = await response(client.im.messages.create(input))
  const retry = await response(client.im.messages.create(input))
  if (
    first.id !== retry.id ||
    first.groupID !== groupId ||
    retry.groupID !== groupId ||
    first.content !== content ||
    retry.content !== content
  )
    throw new MatrixError("EXACT_RETRY_MISMATCH")
  return first.id
}

async function verifyExchange(
  options: MatrixOptions,
  clients: { a: DeepAgentCodeClient; b: DeepAgentCodeClient },
  state: MatrixState,
  binding: z.infer<typeof Binding>,
  phase: "direct" | "group",
) {
  const contents = { a: `im-gray:${state.run}:${phase}:a`, b: `im-gray:${state.run}:${phase}:b` }
  await exactSend(clients.a, binding.a, contents.a, `${state.run}:${phase}:a`, options.aDirectory)
  await poll(options, async () => {
    const matches = (await readMatrixMessages(clients.b, binding.b)).messages.filter(
      (message) => message.content === contents.a,
    )
    if (matches.length > 1) throw new MatrixError("DUPLICATE_RECEIVED_MESSAGE")
    if (matches[0]?.senderID !== undefined && matches[0].senderID !== state.identities.a.uuid)
      throw new MatrixError("RECEIVED_SENDER_MISMATCH")
    return matches.length === 1 ? true : undefined
  })
  await exactSend(clients.b, binding.b, contents.b, `${state.run}:${phase}:b`, options.bDirectory)
  await poll(options, async () => {
    const snapshots = await Promise.all([
      readMatrixMessages(clients.a, binding.a),
      readMatrixMessages(clients.b, binding.b),
    ])
    const complete = snapshots
      .map((snapshot, index) => {
        const expected =
          index === 0
            ? [state.identities.a.viewerID, state.identities.b.uuid]
            : [state.identities.a.uuid, state.identities.b.viewerID]
        return [contents.a, contents.b]
          .map((content, sender) => {
            const matches = snapshot.messages.filter((message) => message.content === content)
            if (matches.length > 1) throw new MatrixError("DUPLICATE_RECEIVED_MESSAGE")
            if (
              matches[0] &&
              (matches[0].senderID !== expected[sender] ||
                matches[0].senderType !== "user" ||
                matches[0].type !== "text")
            )
              throw new MatrixError("RECEIVED_SENDER_MISMATCH")
            return matches.length === 1
          })
          .every(Boolean)
      })
      .every(Boolean)
    return complete ? true : undefined
  })
}

async function requireOffline(base: string) {
  const refused = await fetch(`${base}/global/health`, { signal: AbortSignal.timeout(2_000), redirect: "error" }).then(
    () => false,
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ECONNREFUSED" || error.code === "ConnectionRefused"),
  )
  // A timeout, HTTP error, or authentication failure cannot prove that the receiver is offline.
  if (!refused) throw new MatrixError("A_MUST_BE_OFFLINE")
}

export async function runMatrix(options: MatrixOptions) {
  const a = loopback(options.a)
  const b = loopback(options.b)
  if (a === b) throw new MatrixError("DISTINCT_SERVERS_REQUIRED")
  if (!path.isAbsolute(options.state)) throw new MatrixError("ABSOLUTE_STATE_PATH_REQUIRED")
  if (
    [options.aDirectory, options.bDirectory].some((directory) => directory !== undefined && !path.isAbsolute(directory))
  )
    throw new MatrixError("ABSOLUTE_PROJECT_DIRECTORY_REQUIRED")
  if (
    options.timeoutMs !== undefined &&
    (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 600_000)
  )
    throw new MatrixError("INVALID_TIMEOUT")
  const previous = await load(options.state)
  if (previous && (previous.a !== a || previous.b !== b)) throw new MatrixError("STATE_SERVER_MISMATCH")
  if (previous && (previous.aDirectory !== options.aDirectory || previous.bDirectory !== options.bDirectory))
    throw new MatrixError("STATE_DIRECTORY_MISMATCH")
  if (options.phase === "counts") {
    if (!options.db || !path.isAbsolute(options.db)) throw new MatrixError("EXPLICIT_DB_REQUIRED")
    const { Database } = await import("bun:sqlite")
    using db = new Database(options.db, { readonly: true, strict: true })
    return {
      result: "COUNTS_DIAGNOSTIC_ONLY",
      sessionInputs: db.query<{ count: number }, []>("select count(*) as count from session_input").get()?.count,
      mentionIntents: db.query<{ count: number }, []>("select count(*) as count from im_mention_intent").get()?.count,
    }
  }
  const boundedFetch = Object.assign(
    (request: Parameters<typeof fetch>[0]) => fetch(request, { signal: AbortSignal.timeout(5_000), redirect: "error" }),
    { preconnect: fetch.preconnect },
  )
  const clients = {
    a: createDeepAgentCodeClient({
      baseUrl: a,
      directory: options.aDirectory,
      fetch: boundedFetch,
    }),
    b: createDeepAgentCodeClient({
      baseUrl: b,
      directory: options.bDirectory,
      fetch: boundedFetch,
    }),
  }
  if (options.phase === "burst-send") {
    if (!previous?.group?.verified) throw new MatrixError("VERIFIED_GROUP_PHASE_REQUIRED")
    const count = options.count ?? previous.burst?.count ?? 125
    if (!Number.isInteger(count) || count < 21 || count > 180 || (previous.burst && previous.burst.count !== count))
      throw new MatrixError("INVALID_BURST_COUNT")
    await requireOffline(a)
    const status = await response(clients.b.im.facade.status())
    if (
      status.facade !== "active" ||
      status.kernel !== "connected" ||
      status.recovery?.status !== "ready" ||
      status.identity.uuid !== previous.identities.b.uuid
    )
      throw new MatrixError("B_NOT_READY")
    const target = await bound(clients.b, previous.group.bKernel)
    if (target?.id !== previous.group.b) throw new MatrixError("GROUP_BINDING_CHANGED")
    previous.burst ??= { count, sent: 0 }
    await save(options.state, previous)
    for (let ordinal = 1; ordinal <= count; ordinal++) {
      await requireOffline(a)
      await exactSend(
        clients.b,
        target.id,
        `im-gray:${previous.run}:burst:${ordinal}/${count}`,
        `${previous.run}:burst:${ordinal}`,
        options.bDirectory,
      )
      previous.burst.sent = ordinal
      await save(options.state, previous)
    }
    await requireOffline(a)
    // The public message contract exposes local persistence, not kernel ACKs. The operator must
    // separately verify B's kernel acknowledgements before restarting A for an offline oracle.
    return { result: "BURST_SENT", delivery: "local_ack_only", run: previous.run, count }
  }
  const statuses = await Promise.all([response(clients.a.im.facade.status()), response(clients.b.im.facade.status())])
  const identities = statuses.map((status) =>
    Identity.parse({
      uuid: status.identity?.uuid,
      name: status.identity?.name,
      viewerID: status.viewer?.memberID ?? "server",
    }),
  )
  if (identities[0].uuid === identities[1].uuid) throw new MatrixError("DISTINCT_IDENTITIES_REQUIRED")
  if (
    previous &&
    (previous.identities.a.uuid !== identities[0].uuid || previous.identities.b.uuid !== identities[1].uuid)
  )
    throw new MatrixError("STATE_IDENTITY_MISMATCH")
  const state: MatrixState = previous ?? {
    version: 1,
    run: crypto.randomUUID(),
    a,
    b,
    identities: { a: identities[0], b: identities[1] },
    aDirectory: options.aDirectory,
    bDirectory: options.bDirectory,
  }
  await save(options.state, state)
  if (options.phase === "status")
    return {
      result: "STATUS_ONLY",
      run: state.run,
      a: { facade: statuses[0].facade, kernel: statuses[0].kernel, recovery: statuses[0].recovery?.status },
      b: { facade: statuses[1].facade, kernel: statuses[1].kernel, recovery: statuses[1].recovery?.status },
    }
  if (
    statuses.some(
      (status) => status.facade !== "active" || status.kernel !== "connected" || status.recovery?.status !== "ready",
    )
  )
    throw new MatrixError("BOTH_SERVERS_MUST_BE_READY")
  if (options.phase === "direct") {
    const kernels = { a: `k:1:${state.identities.b.uuid}`, b: `k:1:${state.identities.a.uuid}` }
    const existing = await bound(clients.b, kernels.b)
    if (existing && !options.allowExistingDirect) throw new MatrixError("RECEIVER_DIRECT_ALREADY_EXISTS")
    const local = await response(
      clients.a.im.facade.direct({ name: state.identities.b.name, directory: options.aDirectory }),
    )
    if (local.kernelConvID !== kernels.a) throw new MatrixError("DIRECT_BINDING_MISMATCH")
    await exactSend(clients.a, local.id, `im-gray:${state.run}:direct:a`, `${state.run}:direct:a`, options.aDirectory)
    const remote = await poll(options, () => bound(clients.b, kernels.b))
    state.direct = {
      a: local.id,
      b: remote.id,
      aKernel: kernels.a,
      bKernel: kernels.b,
      firstDiscovery: !existing,
      verified: false,
    }
    await save(options.state, state)
    await verifyExchange(options, clients, state, state.direct, "direct")
    state.direct.verified = true
    await save(options.state, state)
    return {
      result: existing ? "DIRECT_EXISTING_PASS" : "DIRECT_FIRST_DISCOVERY_PASS",
      run: state.run,
      binding: state.direct,
    }
  }
  if (options.phase === "group") {
    if (state.group) throw new MatrixError("GROUP_PHASE_ALREADY_RECORDED")
    const local = await response(
      clients.a.im.facade.groups.create({
        name: `灰度验收${state.run.replaceAll("-", "").slice(0, 12)}`,
        memberNames: [],
        directory: options.aDirectory,
      }),
    )
    if (!local.kernelConvID?.startsWith("k:2:")) throw new MatrixError("GROUP_BINDING_MISMATCH")
    if (await bound(clients.b, local.kernelConvID)) throw new MatrixError("RECEIVER_GROUP_ALREADY_EXISTS")
    await response(
      clients.a.im.facade.groups.invite({
        groupId: local.id,
        name: state.identities.b.name,
        directory: options.aDirectory,
      }),
    )
    await exactSend(clients.a, local.id, `im-gray:${state.run}:group:a`, `${state.run}:group:a`, options.aDirectory)
    const remote = await poll(options, () => bound(clients.b, local.kernelConvID))
    state.group = {
      a: local.id,
      b: remote.id,
      aKernel: local.kernelConvID,
      bKernel: remote.kernelConvID,
      verified: false,
    }
    await save(options.state, state)
    await verifyExchange(options, clients, state, state.group, "group")
    state.group.verified = true
    await save(options.state, state)
    return { result: "GROUP_INVITE_FIRST_DISCOVERY_PASS", run: state.run, binding: state.group }
  }
  if (options.phase === "burst-verify") {
    if (!state.group?.verified || !state.burst || state.burst.sent !== state.burst.count)
      throw new MatrixError("COMPLETE_BURST_SEND_REQUIRED")
    const target = await bound(clients.a, state.group.aKernel)
    if (target?.id !== state.group.a) throw new MatrixError("GROUP_BINDING_CHANGED")
    const burst = state.burst
    const observed = await poll(options, async () => {
      const snapshot = await readMatrixMessages(clients.a, target.id)
      const prefix = `im-gray:${state.run}:burst:`
      const ordinals = new Set<number>()
      for (const message of snapshot.messages.filter((item) => item.content.startsWith(prefix))) {
        const suffix = message.content.slice(prefix.length).split("/")
        const ordinal = Number(suffix[0])
        if (
          suffix.length !== 2 ||
          !Number.isInteger(ordinal) ||
          ordinal < 1 ||
          ordinal > burst.count ||
          suffix[0] !== String(ordinal) ||
          suffix[1] !== String(burst.count)
        )
          throw new MatrixError("INVALID_BURST_ORDINAL")
        if (ordinals.has(ordinal)) throw new MatrixError("DUPLICATE_BURST_ORDINAL")
        if (message.senderID !== state.identities.b.uuid || message.senderType !== "user" || message.type !== "text")
          throw new MatrixError("RECEIVED_SENDER_MISMATCH")
        ordinals.add(ordinal)
      }
      if (ordinals.size !== burst.count) return
      if (snapshot.pages < 2) throw new MatrixError("MULTIPAGE_EVIDENCE_REQUIRED")
      return { count: ordinals.size, pages: snapshot.pages }
    })
    return { result: "BURST_OFFLINE_RECOVERY_PASS", run: state.run, ...observed }
  }
  throw new MatrixError("INVALID_PHASE")
}

if (import.meta.main) {
  Promise.resolve()
    .then(() => runMatrix(parseMatrixArgs(Bun.argv.slice(2))))
    .then(
      (result) => console.log(JSON.stringify(result)),
      (error: unknown) => {
        console.error(
          JSON.stringify({ result: "FAIL", code: error instanceof MatrixError ? error.code : "MATRIX_FAILED" }),
        )
        process.exitCode = 1
      },
    )
}
