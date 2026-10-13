import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { NativeInstallationSchema } from "../../src/installation/native-installation.schema"
import { Hash } from "@deepagent-code/core/util/hash"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { EventInvestigationInstallation } from "./fixture/event-investigation-installation"
import { KernelLiveFirstSeenFixture } from "../im/fixture/kernel-live-first-seen"

const actual = process.platform === "darwin" && process.arch === "arm64" && process.env.DAC_NATIVE_NODE_WORK_ACTUAL === "1"
  ? test : test.skip
const assets = "/var/folders/cs/___vcxjx2cq69pr_mqhzl_fm0000gn/T/dac-event-validation-ui-e5_dupyf/live/install"
const marker = "NATIVE_KERNEL_CHILD_APPROVED_GUARD"
const auditedText = "Delegate one fresh foreground shared task to explore to read only the explicitly approved guard.test.ts bytes, then report the original marker in this conversation."

actual("signed physical Node module uses the original Root/Native child/parent and returns PUB/ACK", async () => {
  const reused = process.env.DAC_NATIVE_NODE_WORK_REUSE
  const root = await fs.realpath(reused ?? await fs.mkdtemp("/tmp/dac-native-node-work-"))
  if (reused) {
    if (await Bun.file(path.join(root, "case/database.sqlite")).exists()) throw new Error("A used business DB cannot restart this setup-only successor")
    const marker = await fs.open(path.join(root, "successor-started"), "wx", 0o600)
    await marker.close()
  }
  const fixed = reused ? await Bun.file(path.join(root, "build-request.json")).json() as { origin: string; defines: { DEEPAGENT_NATIVE_NODE_FIXTURE_CA: string } } : undefined
  await fs.writeFile("/tmp/dac-native-node-work-current", root, { mode: 0o600 })
  const completed = { value: false }
  const child: { value?: ReturnType<EventInvestigationInstallation.NativeCase["spawn"]> } = {}
  const phase = { value: "private-peers" }
  const wire: { text: string; nativeID: string; requestHash: string }[] = []
  const requests: { path: string; authenticated: boolean; body: unknown }[] = []
  const generations = { value: 0, originalReadOutput: false, originalTaskOutput: false }
  const native = KernelLiveFirstSeenFixture.make({
    fetch(request) {
      const pathname = new URL(request.url).pathname
      if (!pathname.startsWith("/api/im/")) return
      if (request.method !== "POST" || request.headers.get("authorization") !== "Bearer private-kernel-work-facade")
        return Response.json({ success: false }, { status: 403 })
      if (pathname === "/api/im/exchange") return Response.json({ success: true, data: {
        kernel_token: "private-first-seen-token", credential_expires_at: Date.now() + 3_600_000,
        navigator_url: native.server.url.origin, appkey: "private-native-kernel-work",
        identity: { uuid: "receiver", name: "Receiver", org_id: 1, org_all_group_id: "unused" },
        ttl: { msg_life_time_ms: 86_400_000 },
      } })
      if (pathname === "/api/im/conversations/inspect") return Response.json({ success: true, data: {
        conversation_type: 1, conversation_id: "sender", org_id: 1, name: "Sender", member_uuids: ["receiver", "sender"],
      } })
      return Response.json({ success: false }, { status: 404 })
    },
    response(topic, request, original) {
      if (topic === "qry_delivery_capabilities") return { name: "DeliveryCapabilities", value: {
        version: 1, profile: "mysql-receipt-v1", maxLifetimeMs: 259200000, maxContentBytes: 65536, eventualDelivery: false,
      } }
      if (topic === "qry_delivery_read_cut") return { name: "DeliveryReadCutResult", value: {
        version: 1, scopeKey: request.scopeKey, projectionKey: request.projectionKey,
        projectionRevision: request.projectionRevision, throughOrdinal: "0", targetAdmittedOrdinal: String(native.messages.length),
        readOrdinal: "0", liveUnread: String(native.messages.length), storedUnread: String(native.messages.length),
        complete: native.messages.length === 0, serverNow: Date.now(),
      } }
      return original
    },
    outboundPublish(request, message) {
      assert.equal(request.targetId, "sender")
      assert.equal(message.msgType, "jg:text")
      assert.equal(message.deliveryVersion, 1)
      assert.ok(message.msgContent instanceof Uint8Array)
      const content = Schema.decodeUnknownSync(Schema.Struct({ content: Schema.String }))(
        Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(new TextDecoder().decode(message.msgContent)))
      const requestHash = Hash.sha256(JSON.stringify(["dac.delivery.request.v1", 1, request.targetId, message.clientUid,
        "jg:text", content.content, 10, Number(String(message.deliveryExpiresAt))])
        .replace(/[<>&\u2028\u2029]/g, (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0")))
      wire.push({ text: content.content, nativeID: "actual-kernel-work-result", requestHash })
      return { code: 0, msgId: "actual-kernel-work-result", timestamp: Date.now(), msgIndex: 2,
        clientMsgId: message.clientUid, deliveryVersion: 1, deliveryExpiresAt: Number(String(message.deliveryExpiresAt)),
        deliveryRequestHash: requestHash }
    },
  })
  const certificate = reused ? { certificatePath: path.join(root, "ca.pem"), keyPath: path.join(root, "ca-key.pem"),
    ca: await fs.readFile(path.join(root, "ca.pem"), "utf8") } : await EventInvestigationInstallation.certificate(root)
  if (fixed && JSON.parse(fixed.defines.DEEPAGENT_NATIVE_NODE_FIXTURE_CA) !== certificate.ca)
    throw new Error("The fixed signed startup certificate changed")
  const provider = Bun.serve({ hostname: "127.0.0.1", port: fixed ? Number(new URL(fixed.origin).port) : 0,
    tls: { key: Bun.file(certificate.keyPath), cert: Bun.file(certificate.certificatePath) },
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      const body: unknown = await request.json()
      requests.push({ path: pathname, body, authenticated: request.headers.get("authorization") === "Bearer fixture-native-key" })
      if (pathname === "/v1/responses/input_tokens") return Response.json({ object: "response.input_tokens", input_tokens: 41 })
      if (pathname !== "/v1/responses") return new Response("unavailable", { status: 404 })
      generations.value++
      if (generations.value === 1 || generations.value === 2) {
        const delegated = generations.value === 1
        const call = delegated
          ? { type: "function_call", id: "item_kernel_task", call_id: "call_kernel_task", name: "task",
            arguments: JSON.stringify({ description: "Read approved original guard", prompt: "Read only the approved guard.test.ts bytes and report its original marker.", subagent_type: "explore" }) }
          : { type: "function_call", id: "item_kernel_read", call_id: "call_kernel_read", name: "read",
            arguments: JSON.stringify({ path: "guard.test.ts", byteOffset: 0, pageBytes: 51200 }) }
        return new Response([
          { type: "response.output_item.added", item: { ...call, arguments: "" } },
          { type: "response.function_call_arguments.delta", item_id: call.id, delta: call.arguments },
          { type: "response.output_item.done", item: call },
          { type: "response.completed", response: { id: delegated ? "response_kernel_task" : "response_kernel_read",
            usage: { input_tokens: 41, output_tokens: 12, total_tokens: 53 } } },
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
      }
      if (generations.value !== 3 && generations.value !== 4) throw new Error("Unexpected additional provider generation")
      const input = Schema.decodeUnknownSync(Schema.Struct({ input: Schema.Array(Schema.Unknown) }))(body).input
      const hasOutput = (callID: string) => input.some((item) => typeof item === "object" && item !== null &&
        "type" in item && item.type === "function_call_output" && "call_id" in item && item.call_id === callID &&
        "output" in item && typeof item.output === "string" && item.output.includes(marker))
      if (generations.value === 3) generations.originalReadOutput = hasOutput("call_kernel_read")
      if (generations.value === 4) generations.originalTaskOutput = hasOutput("call_kernel_task")
      const text = generations.value === 3 ? `Child verified approved bytes: ${marker}.` : `Verified original approved bytes through explore: ${marker}.`
      return new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", item_id: `message_kernel_final_${generations.value}`,
        delta: text })}\n\n` +
        `data: ${JSON.stringify({ type: "response.completed", response: { id: `response_kernel_final_${generations.value}`,
          usage: { input_tokens: 41, output_tokens: 12, total_tokens: 53 } } })}\n\n`,
        { headers: { "content-type": "text/event-stream" } })
    },
  })
  try {
    phase.value = "fixed-assets"
    expect(EventInvestigationInstallation.hash(await fs.readFile(path.join(assets, "deepagent-work-file-helper"))))
      .toBe("9d141352a9fa0e86635b248d1ffd9f3a00548adba879c9847a3c8ef5a01ccde0")
    expect(EventInvestigationInstallation.hash(await fs.readFile(path.join(assets, "bun-command-runtime"))))
      .toBe("b36d2e9d9bd50e3a3b6a8f2d481839417d6600d4c1753411b094ee0da3222cef")
    phase.value = "one-current-signed-candidate"
    if (fixed && provider.url.origin !== fixed.origin) throw new Error("The original private provider origin changed")
    const installation = reused ? await readSigned(root, provider.url.origin) : await requestBuild(root, provider.url.origin, certificate.ca, assets)
    const candidate = await EventInvestigationInstallation.caseFor({ installation, directory: path.join(root, "case"),
      sourceText: `export const originalMarker = "${marker}";\n` })
    const issuedAt = Date.now()
    await fs.writeFile(candidate.policy, JSON.stringify({ version: 6,
      kernelReceivers: [{ id: "original-kernel-receiver", targetID: "review", realmID: new URL(native.server.url.origin).href,
        appkeyID: "private-native-kernel-work", orgID: 1, receiverID: "receiver", localUserID: "server",
        issuedAt, expiresAt: issuedAt + 7 * 86_400_000 }],
      targets: [{ id: "review", directory: candidate.project, agentID: "auto", providerID: "openai",
        modelID: "gpt-4.1-2025-04-14", profile: "project_shared_root_v1",
        budget: { ...WorkAuthorityPolicy.SHARED_ROOT_PROFILE.budget, maxTotalTokens: 20000, maxCompletionTokens: 4096,
          maxChildren: 2, maxDurationMs: 120000, maxProviderDispatches: 4, maxToolCalls: 2 },
        children: { kind: "shared_root_v1", maxConcurrent: 2, agents: ["explore"], toolIDs: ["read"],
          budget: { ...WorkAuthorityPolicy.PROJECT_PROFILE.budget, maxTotalTokens: 10000, maxCompletionTokens: 4096,
            maxChildren: 0, maxDurationMs: 120000, maxProviderDispatches: 2, maxToolCalls: 1 } },
        project: { tools: ["read", "task"], fileScope: { read: [{ kind: "file", path: "guard.test.ts" }], write: [], deny: [],
          maxReadBytes: 65536, maxPageBytes: 51200, maxHashBytes: 16777216, maxWriteBytes: 0, symlinks: "deny" } } }],
    }), { mode: 0o600 })
    phase.value = "original-operator-enroll-and-route"
    const run = async (name: string, input: { action: "enroll" | "approve-route"; operationID: string; policyPath?: string;
      targetID?: string; snapshot?: string; expectedRevision?: number; expectedRouteRevision?: number; expiresAt?: number }) => {
      const result = path.join(candidate.directory, `${name}-result.json`)
      const spawned = utility(candidate, name, { DAC_NATIVE_NODE_WORK_COMMAND: JSON.stringify(input),
        DAC_NATIVE_NODE_WORK_COMMAND_RESULT: result })
      const [code, stdout, stderr] = await Promise.all([spawned.exited, new Response(spawned.stdout).text(), new Response(spawned.stderr).text()])
      await fs.writeFile(path.join(candidate.directory, `${name}.log`), stdout + stderr, { mode: 0o600 })
      expect(code, stderr.slice(-1800)).toBe(0)
      expect(await Bun.file(result).json()).toMatchObject({ state: "completed", action: input.action })
    }
    await run("enroll", { action: "enroll", operationID: "kernel-work-enroll", policyPath: candidate.policy })
    await run("approve", { action: "approve-route", operationID: "kernel-work-route", targetID: "review",
      snapshot: "gpt-4.1-2025-04-14", expectedRevision: 1, expectedRouteRevision: 0, expiresAt: Date.now() + 3_600_000 })
    const extra = { DAC_KERNEL_WORK_RESULT: path.join(candidate.directory, "result.json"),
      DAC_KERNEL_WORK_READY: path.join(candidate.directory, "reader-ready"), DAC_KERNEL_WORK_CA: certificate.certificatePath,
      DAC_KERNEL_WORK_TLS_KEY: certificate.keyPath, DEEPAGENT_IM_FACADE_URL: native.server.url.origin,
      DEEPAGENT_IM_FACADE_KEY: "private-kernel-work-facade" }
    await fs.writeFile(path.join(candidate.directory, "exact-private-env.json"), JSON.stringify({ ...candidate.env, ...extra }), { mode: 0o600 })
    phase.value = "current-root-and-new-live-source"
    child.value = utility(candidate, "work", extra)
    const output = new Response(child.value.stdout).text()
    const errors = new Response(child.value.stderr).text()
    const stopped = child.value.exited.then((code) => ({ code }))
    const deadline = Date.now() + 70000
    while (!(await Bun.file(extra.DAC_KERNEL_WORK_READY).exists())) {
      if (child.value.exitCode !== null || Date.now() >= deadline) break
      await Bun.sleep(20)
    }
    if (await Bun.file(extra.DAC_KERNEL_WORK_READY).exists()) {
      // The message is invisible during original initial sync. Commit and original WS
      // publication happen in this one JS turn; no history row is upgraded afterward.
      const source = native.add("actual-kernel-work-source", { publish: false })
      source.content = JSON.stringify({ content: auditedText })
      native.publish(source)
    }
    phase.value = "actual-execution-and-result"
    const [exit, stdout, stderr] = await Promise.all([stopped, output, errors])
    await fs.writeFile(path.join(candidate.directory, "actual.log"), stdout + stderr, { mode: 0o600 })
    await fs.writeFile(path.join(root, "transport-facts.json"), JSON.stringify({ requests, wire, generations,
      topics: native.topics, disconnected: native.state.disconnected }), { mode: 0o600 })
    expect(exit.code, stderr.slice(-2400)).toBe(0)
    const result = await Bun.file(extra.DAC_KERNEL_WORK_RESULT).json()
    expect(result.stage).toBe("complete")
    expect(result.error).toBeUndefined()
    expect(result.before.source).toHaveLength(0)
    expect(result.before.sessions).toHaveLength(0)
    expect(result.before.inputs).toHaveLength(0)
    expect(result.after.source).toHaveLength(1)
    expect(result.after.requests).toHaveLength(1)
    expect(result.after.grants).toHaveLength(1)
    expect(result.after.work).toHaveLength(2)
    expect(result.after.work.every((row: { admission_state: string; control_state: string; outcome: string }) =>
      row.admission_state === "ready" && row.control_state === "active" && row.outcome === "succeeded")).toBe(true)
    expect(result.after.sessions).toHaveLength(2)
    expect(result.after.sessions.every((row: { execution_claim_token: string | null }) => row.execution_claim_token === null)).toBe(true)
    expect(result.after.inputs).toHaveLength(2)
    expect(result.after.inputs.every((row: { delivery: string; promoted_seq: number | null }) => row.delivery === "queue" && row.promoted_seq !== null)).toBe(true)
    expect(result.after.activities).toHaveLength(2)
    expect(result.after.activities.every((row: { state: string }) => row.state === "settled")).toBe(true)
    expect(result.after.tools).toEqual(expect.arrayContaining([
      { state: "settled", effect_kind: "read_only", known_read: 1 },
      { state: "settled", effect_kind: "mutating", known_read: 0 },
    ]))
    expect(result.after.tools).toHaveLength(2)
    expect(result.after.toolAdmissions).toHaveLength(2)
    expect(result.after.providers.map((row: { state: string }) => row.state)).toEqual(["settled", "settled", "settled", "settled"])
    expect(result.after.receipts.map((row: { state: string }) => row.state)).toEqual(["settled", "settled", "settled", "settled"])
    expect(result.after.counts.map((row: { state: string }) => row.state)).toEqual(["settled", "settled", "settled", "settled"])
    const observedCounts = result.after.counts.map((row: { record: string }) => Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ result: Schema.Struct({ inputTokens: Schema.Number }) })))(row.record).result.inputTokens)
    const usage = result.after.receipts.map((row: { outcome_artifact: string }) => Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Array(Schema.Struct({ usage: Schema.optional(Schema.Struct({
        inputTokens: Schema.Number, outputTokens: Schema.Number, totalTokens: Schema.Number,
      })) }))))(row.outcome_artifact).flatMap((event) => event.usage ? [event.usage] : []).at(-1))
    expect(observedCounts).toEqual([41, 41, 41, 41])
    expect(usage).toEqual(Array.from({ length: 4 }, () => ({ inputTokens: 41, outputTokens: 12, totalTokens: 53 })))
    expect(result.after.dispatches.map((row: { state: string; charged_tokens: number }) => ({
      state: row.state, charged: row.charged_tokens,
    }))).toEqual(Array.from({ length: 4 }, () => ({ state: "settled", charged: 53 })))
    expect(result.after.childGrants).toEqual([expect.objectContaining({ parent_work_id: result.accepted.workID,
      root_work_id: result.accepted.workID })])
    const derived = result.after.childGrants[0]
    expect(derived.child_work_id).not.toBe(result.accepted.workID)
    expect(result.after.work.find((row: { work_id: string }) => row.work_id === derived.child_work_id)).toMatchObject({
      root_work_id: result.accepted.workID, parent_work_id: result.accepted.workID, outcome: "succeeded" })
    expect(result.after.taskRuns).toEqual([expect.objectContaining({ run_id: derived.task_run_id,
      state: "completed", child_session_id: derived.child_session_id, delivery_mode: "foreground", workspace_mode: "shared" })])
    expect(result.after.taskReceipts).toEqual([expect.objectContaining({ run_id: derived.task_run_id, state: "completed" })])
    expect(result.after.taskCalls).toHaveLength(1)
    expect(result.after.dispatches.filter((row: { work_id: string }) => row.work_id === result.accepted.workID)).toHaveLength(2)
    expect(result.after.dispatches.filter((row: { work_id: string }) => row.work_id === derived.child_work_id)).toHaveLength(2)
    expect(result.after.dispatches.reduce((sum: number, row: { charged_tokens: number }) => sum + row.charged_tokens, 0)).toBe(212)
    expect(result.after.outbox).toEqual([expect.objectContaining({ status: "delivered" })])
    expect(result.delivery).toMatchObject({ state: "acknowledged", kernelMessageID: "actual-kernel-work-result" })
    expect(result.result.state).toBe("available")
    expect(result.result.placement.sessionID).toBe(result.accepted.sessionID)
    expect(result.result.attempt.workID).toBe(result.accepted.workID)
    expect(requests.filter((row) => row.path === "/v1/responses/input_tokens")).toHaveLength(4)
    expect(requests.filter((row) => row.path === "/v1/responses")).toHaveLength(4)
    expect(requests.every((row) => row.authenticated)).toBe(true)
    expect(generations.originalReadOutput).toBe(true)
    expect(generations.originalTaskOutput).toBe(true)
    expect(wire).toEqual([{ text: `[Agent·auto] Verified original approved bytes through explore: ${marker}.`,
      nativeID: "actual-kernel-work-result", requestHash: expect.stringMatching(/^[a-f0-9]{64}$/) }])
    completed.value = true
  } finally {
    child.value?.kill()
    if (child.value) await child.value.exited
    await provider.stop(true)
    await native.server.stop(true)
    await fs.writeFile(path.join(root, "cleanup.json"), JSON.stringify({ phase: phase.value, completed: completed.value,
      ownChildEnded: !child.value || child.value.exitCode !== null, peerClosed: true, providerClosed: true }), { mode: 0o600 })
    if (!completed.value) process.stderr.write(`KERNEL_CHILD_PRIVATE_FAILURE ${phase.value} ${root}\n`)
  }
}, 420_000)


const electron = path.resolve(import.meta.dir, "../../../desktop/node_modules/.bin/electron")
const repository = path.resolve(import.meta.dir, "../../../..")
async function requestBuild(directory: string, origin: string, ca: string, assets: string) {
  const runtime = await Bun.file("/tmp/dac-native-node-actual-runtime.json").json() as { runtime: string; node: string; electron: string }
  if (runtime.node !== "24.18.0" || runtime.electron !== "41.10.3" || await fs.realpath(runtime.runtime) !== runtime.runtime)
    throw new Error("Original utility runtime probe is unavailable")
  const install = path.join(directory, "install")
  await fs.mkdir(install, { mode: 0o700 })
  const overlays = await Promise.all(["packages/deepagent-code/src/installation/work-provider-contract.ts",
    "packages/core/src/session/work-route-policy.ts"].map(async (name) => {
    const before = await fs.readFile(path.join(repository, name), "utf8")
    const needle = '  if (endpoint === "https://api.openai.com/v1/responses") return true'
    if (name.endsWith("work-provider-contract.ts") && before.match(/https:\/\/api\.openai\.com/g)?.length !== 2)
      throw new Error("Original fixed provider contract changed")
    if (name.endsWith("work-route-policy.ts") && before.split(needle).length !== 2)
      throw new Error("Original fixed route policy changed")
    const after = name.endsWith("work-provider-contract.ts") ? before.replaceAll("https://api.openai.com", origin) :
      before.replace(needle, `${needle}\n  if (endpoint === ${JSON.stringify(`${origin}/v1/responses`)}) return true`)
    const stem = path.join(directory, name.replaceAll("/", "__"))
    await fs.writeFile(`${stem}.before`, before)
    await fs.writeFile(`${stem}.after`, after)
    return { path: name, before: `${stem}.before`, after: `${stem}.after`, beforeSHA256: EventInvestigationInstallation.hash(before), afterSHA256: EventInvestigationInstallation.hash(after) }
  }))
  const fixtures = await Promise.all(["packages/deepagent-code/test/installation/fixture/native-node-work-process.ts",
    "packages/deepagent-code/test/installation/native-node-work.test.ts", "packages/deepagent-code/test/im/fixture/kernel-task-child-production.ts"].map(async (name) => {
    const bytes = await fs.readFile(path.join(repository, name))
    return { path: name, bytes: bytes.length, sha256: EventInvestigationInstallation.hash(bytes) }
  }))
  const request = { version: 1, repository, install, module: path.join(install, "node.js"),
    entry: path.join(import.meta.dir, "fixture/native-node-work-process.ts"), runtime: runtime.runtime,
    publicPinPath: "/private/tmp/dac-desktop-node-sealed-JaFi97/public.pem", origin,
    assets: ["deepagent-work-file-helper", "bun-command-runtime"].map((name) => ({ name, path: path.join(assets, name) })),
    defines: { DEEPAGENT_CODE_VERSION: JSON.stringify("2.0.3-dev"), DEEPAGENT_CODE_CHANNEL: JSON.stringify("dev"),
      DEEPAGENT_NATIVE_NODE_FIXTURE_CA: JSON.stringify(ca) },
    build: { target: "node", format: "esm", conditions: ["node"], external: ["@lydell/node-pty", "jsonc-parser", "bun", "electron"],
      naming: "node.js", tsconfig: path.join(repository, "packages/deepagent-code/tsconfig.json"),
      passwordWorkerEntry: path.join(repository, "packages/deepagent-code/src/im/auth-password-worker.node.ts") },
    overlays, fixtures,
    meaning: "Signed private startup trust/HTTPS endpoint fixture; no production pin/TLS/authority relaxation; no key/env/DB in this request" }
  await fs.writeFile(path.join(directory, "build-request.json"), JSON.stringify(request), { mode: 0o600 })
  process.stdout.write(`NODE_WORK_BUILD_REQUEST ${path.join(directory, "build-request.json")}\n`)
  const deadline = Date.now() + 300000
  while (!(await Bun.file(path.join(directory, "build-ready.json")).exists())) {
    if (Date.now() >= deadline) throw new Error("Root-owned signed Node build was not ready within the bounded fixture window")
    await Bun.sleep(100)
  }
  return readSigned(directory, origin)
}
async function readSigned(directory: string, origin: string) {
  const request = await Bun.file(path.join(directory, "build-request.json")).json() as { module: string; runtime: string; origin: string;
    fixtures: { path: string; bytes: number; sha256: string }[] }
  const ready = await Bun.file(path.join(directory, "build-ready.json")).json() as { module: string; runtime: string; componentsHash: string }
  if (ready.module !== request.module || ready.runtime !== request.runtime || request.origin !== origin || !/^[0-9a-f]{64}$/.test(ready.componentsHash))
    throw new Error("Root-owned build metadata did not match the requested physical artifacts")
  const metadata = await fs.readFile(`${ready.module}.native-components.json`, "utf8")
  const components = Schema.decodeUnknownSync(Schema.fromJsonString(NativeInstallationSchema.Components))(metadata)
  if (EventInvestigationInstallation.hash(metadata) !== ready.componentsHash)
    throw new Error("The signed source inventory changed")
  for (const fixture of request.fixtures) {
    const bytes = await fs.readFile(path.join(repository, fixture.path))
    const captured = components.components.find((entry) => entry.path === fixture.path)
    if (bytes.length !== fixture.bytes || EventInvestigationInstallation.hash(bytes) !== fixture.sha256 ||
      captured?.bytes !== fixture.bytes || captured.sha256 !== fixture.sha256)
      throw new Error("The signed fixture source cohort changed")
  }
  return Object.freeze({ directory, install: path.join(directory, "install"), executable: ready.module, origin, componentsHash: ready.componentsHash })
}
function utility(candidate: EventInvestigationInstallation.NativeCase, name: string, extra: Record<string, string | undefined>) {
  return Bun.spawn([electron, candidate.installation.executable], {
    cwd: candidate.project, env: { ...candidate.env, ...extra, DAC_NATIVE_NODE_WORK_ROLE: "main",
      DAC_NATIVE_NODE_WORK_MODULE: candidate.installation.executable, DAC_NATIVE_NODE_WORK_DIRECTORY: candidate.directory,
      DAC_NATIVE_NODE_WORK_EXIT: path.join(candidate.directory, `${name}-utility-exit.json`) },
    stdout: "pipe", stderr: "pipe", timeout: 130000,
  })
}
