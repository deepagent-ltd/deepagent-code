import { Effect, Exit, Option, Cause } from "effect"
import { BrowserNativeHost } from "../../../src/browser/native-host"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { BrowserControl } from "@deepagent-code/core/browser/control"
import type { ServerAuth } from "../../../src/server/auth"
import crypto from "node:crypto"

const port = Reflect.get(process, "parentPort") as { postMessage(value: unknown): void }
await BrowserNativeHost.prepare()
const host = BrowserNativeHost.current()!
const now = Date.now()
const control: BrowserSchema.Control = { version: 1, controlID: "control-test", requestID: "create-test", requestDigest: "a".repeat(64),
  scope: { principal: "deepagent-code", securityNamespaceID: "namespace-test", locationKey: "location-test", projectScopeKey: "project-scope-test",
    namespaceBindingHash: "a".repeat(64), sessionID: "session-test", projectID: "project-test", directory: "/private/fixture", workspaceID: null },
  hostID: host.hostID, hostIncarnation: host.hostIncarnation, resourceID: "resource-test", credentialBinding: host.credentialBinding,
  profile: BrowserSchema.PROFILE, origin: process.env.DAC_BROWSER_ORIGIN!, revision: 1, epoch: 1, policyRevision: 1,
  state: "creating", expiresAt: now + 60_000, createdAt: now, updatedAt: now, cancel: null, stopConfirmedAt: null }
let seq = 0
let checks = 0
let allowed = true
const execute = (command: BrowserSchema.Command) => {
  const action: BrowserSchema.Action = { version: 1, actionID: `action-${++seq}`, controlID: control.controlID,
    requestID: `admission-${seq}`, commandDigest: BrowserControl.hash(command), command,
    admissionID: `admission-${seq}`, providerReceiptID: "provider-receipt", providerAttemptID: "provider-attempt", toolCallID: `call-${seq}`,
    sessionID: control.scope.sessionID, hostIncarnation: control.hostIncarnation, resourceID: control.resourceID,
    controlEpoch: 1, policyRevision: 1, revision: 1, deadline: Date.now() + 10_000, outcome: "pending", result: null,
    errorCode: null, createdAt: Date.now(), updatedAt: Date.now(), terminalAt: null, stopConfirmedAt: null }
  return host.execute({ ...control, state: "active", revision: 2 }, action, Effect.suspend(() => {
    checks++
    return allowed ? Effect.void : Effect.fail(BrowserControl.failure("BROWSER_SCOPE_DENIED"))
  }))
}
const code = (exit: Exit.Exit<unknown, BrowserSchema.Error>) => Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))?.code : null
try {
  await Effect.runPromise(host.create(control))
  const first = await Effect.runPromise(execute({ type: "tabs.list" }))
  const tab = first.result.tabs[0]!
  const navigated = await Effect.runPromise(execute({ type: "navigate", tabID: tab.tabID, generation: tab.generation, url: control.origin + "/" }))
  const current = navigated.result.tabs[0]!
  const snapshot = await Effect.runPromise(execute({ type: "snapshot", tabID: current.tabID, generation: current.generation }))
  const png = await Effect.runPromise(execute({ type: "screenshot", tabID: current.tabID, generation: current.generation }))
  const external = code(await Effect.runPromise(Effect.exit(execute({ type: "navigate", tabID: current.tabID, generation: current.generation, url: process.env.DAC_BROWSER_DENIED! }))))
  const stale = code(await Effect.runPromise(Effect.exit(execute({ type: "screenshot", tabID: current.tabID, generation: tab.generation }))))
  allowed = false
  const revoked = code(await Effect.runPromise(Effect.exit(execute({ type: "navigate", tabID: current.tabID, generation: current.generation, url: control.origin + "/revoked" }))))
  allowed = true
  BrowserNativeHost.captureServerConfiguration({ username: "deepagent-code", password: Option.some("rotated-fixture-password") } satisfies ServerAuth.Info)
  const rotated = code(await Effect.runPromise(Effect.exit(execute({ type: "tabs.list" }))))
  const cancellations = await Effect.runPromise(Effect.all(Array.from({ length: 24 }, () => host.cancel({ ...control, state: "cancel_requested", revision: 3, epoch: 2,
    cancel: { requestID: "cancel", expectedRevision: 2, requestedAt: Date.now() } })), { concurrency: "unbounded" }))
  const stopped = cancellations.every(Boolean)
  port.postMessage({ type: "result", first, navigated, snapshot, image: png.result.image, pngHash: BrowserControl.hash(png.png),
    runtime: { node: process.versions.node, electron: process.versions.electron,
      argon2: typeof Reflect.get(crypto, "argon2"), argon2Sync: typeof Reflect.get(crypto, "argon2Sync") },
    external, stale, revoked, rotated, stopped, cancellationCount: cancellations.length, checks, verify: host.verify(control), authOld: host.matchesCredentials("deepagent-code", "fixture-password") })
} catch (error) {
  port.postMessage({ type: "fixture-error", message: String(error), stack: error instanceof Error ? error.stack : undefined })
}
