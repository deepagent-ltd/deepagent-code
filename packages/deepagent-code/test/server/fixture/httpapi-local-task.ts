import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import net from "node:net"
import { Effect, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { LocalTaskAuthority } from "@/im/local-task-authority"
import { ServerAuth } from "@/server/auth"
import { command } from "@/cli/cmd/operator"
import { AppRuntime } from "@/effect/app-runtime"
import { Server } from "@/server/server"

const root = process.argv[2]!
const directory = path.join(root, "project")
const cases: Record<string, number | string> = {}
await Bun.write(
  path.join(directory, "deepagent-code.json"),
  JSON.stringify({
    formatter: false,
    lsp: false,
    model: "fixture/test-model",
    providers: {
      fixture: {
        api: {
          type: "native",
          url: "https://example.invalid/v1/responses",
          settings: {},
          protocol: "openai.responses",
        },
        models: { "test-model": { api: { id: "test-model" } } },
      },
    },
  }),
)
const policyPath = path.join(root, "policy.json")
await Bun.write(
  policyPath,
  JSON.stringify({
    version: 1,
    targets: [
      {
        id: "review",
        directory,
        agentID: "auto",
        providerID: "fixture",
        modelID: "test-model",
        budget: { ...WorkAuthorityPolicy.TEXT_ONLY_PROFILE.budget, maxTotalTokens: 8_000 },
      },
    ],
  }),
)
const database = Database.defaultLayer
const offline = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(LocationIdentity.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer))),
    Effect.provide(database),
    Effect.provide(ServerAuth.Config.defaultLayer),
    Effect.scoped,
  )
const enrollment = await Effect.runPromise(
  offline(command({ action: "enroll", operationID: "enroll-http", policyPath })),
)
assert.ok(enrollment && "state" in enrollment)
assert.equal(enrollment.state, "active")
cases.enrolled = enrollment.state
assert.deepEqual(
  await Effect.runPromise(offline(command({ action: "enroll", operationID: "enroll-http", policyPath }))),
  enrollment,
)
cases.enrollmentRetry = "exact"
assert.equal((await fs.stat(LocalTaskAuthority.installationPath())).mode & 0o777, 0o600)
const rg = Bun.which("rg")
assert(rg)
const bin = path.join(root, "home/.deepagent/code/cache/bin")
await fs.mkdir(bin, { recursive: true })
await fs.copyFile(rg, path.join(bin, "rg"))
await AppRuntime.runPromise(Database.Service)
const probe = net.createServer()
await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
const address = probe.address()
assert(address && typeof address !== "string")
await new Promise<void>((resolve) => probe.close(() => resolve()))
const listener = await Server.listen({ hostname: "127.0.0.1", port: address.port, cors: ["http://127.0.0.1:45123"] })
const auth = ServerAuth.header({ username: "isolated-operator", password: "isolated-local-task-password" })!
const facts = () =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      return (yield* (yield* Database.Service).db.all<{
        origins: number
        requests: number
        grants: number
        work: number
        sessions: number
        inputs: number
        providers: number
        intents: number
      }>(
        "SELECT (SELECT count(*) FROM im_local_origin_receipt) origins,(SELECT count(*) FROM im_task_request) requests,(SELECT count(*) FROM im_task_grant) grants,(SELECT count(*) FROM work_execution) work,(SELECT count(*) FROM session) sessions,(SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM session_provider_attempt) providers,(SELECT count(*) FROM im_mention_intent) intents",
      ))[0]
    }),
  )
async function request(
  route: string,
  body?: unknown,
  options: { origin?: string; directory?: string; queryAuth?: boolean; method?: string; host?: string } = {},
) {
  const response = await fetch(
    new URL(route + (options.queryAuth ? `?auth_token=${encodeURIComponent(auth.slice(6))}` : ""), listener.url),
    {
      method: options.method ?? (body ? "POST" : "GET"),
      headers: {
        "content-type": "application/json",
        "x-deepagent-code-directory": options.directory ?? directory,
        ...(options.queryAuth ? {} : { authorization: auth }),
        ...(options.origin ? { origin: options.origin } : {}),
        ...(options.host ? { host: options.host } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    },
  )
  const text = await response.text()
  const value = text ? JSON.parse(text) : undefined
  return { status: response.status, value }
}
try {
  cases.capability = (await request("/api/v1/im/tasks/capability")).status
  assert.equal(cases.capability, 200)
  const created = await request("/api/v1/im/groups", { type: "project", name: "localtask" })
  assert.equal(created.status, 200, JSON.stringify(created))
  const groupID = created.value.id
  const enabling = { operationID: "enable", expectedRevision: 0, targetID: "review" }
  cases.crossProject = (
    await request(`/api/v1/im/tasks/conversations/${groupID}`, enabling, { directory: path.join(root, "other") })
  ).status
  const ordinary = await request(`/api/v1/im/tasks/conversations/${groupID}`)
  assert.equal(ordinary.status, 200)
  assert.deepEqual(ordinary.value, { groupID, mode: "ordinary", revision: 0, target: null })
  assert.equal((await request(`/api/v1/im/tasks/conversations/${groupID}?directory=${encodeURIComponent(path.join(root, "other"))}`)).status, 403)
  cases.enabled = (await request(`/api/v1/im/tasks/conversations/${groupID}`, enabling)).status
  assert.equal(cases.enabled, 200)
  const conversation = await request(`/api/v1/im/tasks/conversations/${groupID}`)
  assert.equal(conversation.status, 200)
  assert.equal(conversation.value.mode, "explicit_task")
  assert.equal(conversation.value.target.workspaceID, null)
  assert.equal(conversation.value.target.tools.fileScope, null)
  cases.wrongOrigin = (
    await request("/api/v1/im/tasks/capability", undefined, { origin: "http://127.0.0.1.evil.invalid:4444" })
  ).status
  cases.otherLoopbackOrigin = (
    await request("/api/v1/im/tasks/capability", undefined, { origin: "http://127.0.0.1:45124" })
  ).status
  assert.equal(cases.otherLoopbackOrigin, 403)
  cases.sameListenerOrigin = (
    await request("/api/v1/im/tasks/capability", undefined, { origin: listener.url.origin })
  ).status
  assert.equal(cases.sameListenerOrigin, 200)
  cases.explicitOrigin = (
    await request("/api/v1/im/tasks/capability", undefined, { origin: "http://127.0.0.1:45123" })
  ).status
  assert.equal(cases.explicitOrigin, 200)
  cases.nativeOrigin = (await request("/api/v1/im/tasks/capability", undefined, { origin: "oc://renderer" })).status
  assert.equal(cases.nativeOrigin, 200)
  cases.forgedHostOrigin = (
    await request("/api/v1/im/tasks/capability", undefined, {
      origin: "http://127.0.0.1:45124",
      host: "127.0.0.1:45124",
    })
  ).status
  assert.equal(cases.forgedHostOrigin, 403)
  cases.originWithPath = (
    await request("/api/v1/im/tasks/capability", undefined, { origin: listener.url.origin + "/" })
  ).status
  assert.equal(cases.originWithPath, 403)
  cases.queryCredential = (await request("/api/v1/im/tasks/capability", undefined, { queryAuth: true })).status
  // An allowed HTTP chat request with a rejected task witness still persists plain text only.
  const plain = { senderType: "user", type: "text", content: "@auto old untrusted text", clientRequestID: "plain" }
  const first = await request(`/api/v1/im/groups/${groupID}/messages`, plain, { origin: "https://unapproved.invalid" })
  assert.equal(first.status, 200, JSON.stringify(first))
  assert.equal((await request(`/api/v1/im/groups/${groupID}/messages`, plain)).status, 200)
  cases.plainOrigin = (await facts()).origins
  const fresh = await request(`/api/v1/im/groups/${groupID}/messages`, {
    senderType: "user",
    type: "text",
    content: "@auto review this text only",
    clientRequestID: "fresh",
  })
  assert.equal(fresh.status, 200, JSON.stringify(fresh))
  cases.freshOrigin = (await facts()).origins
  const proposal = { clientRequestID: "proposal", messageID: fresh.value.id, auditedText: fresh.value.content }
  const proposed = await request("/api/v1/im/tasks/requests", proposal)
  cases.proposal = proposed.status
  assert.equal(proposed.value.expiresAt, fresh.value.createdAt + 86_400_000)
  assert.equal(proposed.status, 200, JSON.stringify(proposed))
  assert.deepEqual(proposed.value.review.source, { messageID: fresh.value.id, groupID, senderID: "server" })
  assert.equal(proposed.value.review.target.workspaceID, null)
  assert.equal(proposed.value.review.target.tools.fileScope, null)
  assert.equal(proposed.value.review.target.tools.children, "deny_all")
  assert.equal(proposed.value.review.target.directory, directory)
  assert.equal(proposed.value.review.target.budget.maxProviderDispatches > 0, true)
  assert.equal("provider" in proposed.value.review.target, false)
  const reviewed = await request(`/api/v1/im/tasks/requests/${proposed.value.id}`)
  assert.equal(reviewed.status, 200)
  assert.deepEqual(reviewed.value.review, proposed.value.review)
  assert.deepEqual(await request("/api/v1/im/tasks/requests", proposal), proposed)
  cases.proposalRetry = "exact"
  const blockedCLI = Bun.spawn(
    [
      process.execPath,
      path.resolve(import.meta.dir, "../../../src/index.ts"),
      "operator",
      "revoke",
      "--request-id",
      "must-not-write-live",
      "--expected-revision",
      "1",
    ],
    { cwd: directory, env: process.env, stdout: "pipe", stderr: "pipe" },
  )
  const timer = setTimeout(() => blockedCLI.kill("SIGKILL"), 10_000)
  const blocked = await Promise.all([
    blockedCLI.exited,
    new Response(blockedCLI.stdout).text(),
    new Response(blockedCLI.stderr).text(),
  ]).finally(() => clearTimeout(timer))
  assert.equal(blocked[0], 1)
  assert(!blocked[1].includes("isolated-local-task-password") && !blocked[2].includes("isolated-local-task-password"))
  cases.liveEnrollmentLock = "refused"
  const before = await facts()
  const accepted = await request(`/api/v1/im/tasks/requests/${proposed.value.id}/accept`, {
    operationID: "accept-http",
    expectedRevision: 1,
  })
  cases.accepted = accepted.status
  cases.acceptedCode = accepted.value.code
  assert.deepEqual(await facts(), before)
  cases.queryRead = (
    await request(`/api/v1/im/tasks/requests/${proposed.value.id}`, undefined, { queryAuth: true })
  ).status
  const revoked = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const config = yield* ServerAuth.Config
      const configured = yield* LocalTaskAuthority.configured(config)
      const witness = yield* LocalTaskAuthority.authenticatePassword(
        db,
        configured.runtime,
        config.username,
        configured.password,
      )
      return yield* LocalTaskAuthority.provide(
        { runtime: configured.runtime, witness },
        LocalOperator.revoke(db, { operationID: "revoke", expectedRevision: 1 }),
      )
    }).pipe(Effect.provide(ServerAuth.Config.defaultLayer)),
  )
  cases.revoked = revoked.state
  cases.generation = revoked.credentialGeneration
  cases.revokedRead = (await request(`/api/v1/im/tasks/requests/${proposed.value.id}`)).status
  assert.deepEqual(await facts(), before)
  await listener.stop(true)
  await Bun.write(
    path.join(root, "result.json"),
    JSON.stringify({ pid: process.pid, counts: await facts(), cases, closed: true }, null, 2),
  )
} finally {
  await listener.stop(true)
}
process.exit(0)
