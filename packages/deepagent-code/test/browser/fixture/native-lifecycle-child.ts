import { Effect, Exit, Option, Cause } from "effect"
import { BrowserNativeHost } from "../../../src/browser/native-host"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { BrowserControl } from "@deepagent-code/core/browser/control"

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
  const original = first.result.tabs[0]!
  const created = await Effect.runPromise(execute({ type: "tabs.create", url: control.origin + "/new" }))
  const second = created.result.tabs.find((tab) => tab.tabID !== original.tabID)!
  const moved = await Effect.runPromise(execute({ type: "navigate", tabID: second.tabID, generation: second.generation, url: control.origin + "/next" }))
  const next = moved.result.tabs.find((tab) => tab.tabID === second.tabID)!
  const back = await Effect.runPromise(execute({ type: "back", tabID: next.tabID, generation: next.generation }))
  const prior = back.result.tabs.find((tab) => tab.tabID === second.tabID)!
  const forward = await Effect.runPromise(execute({ type: "forward", tabID: prior.tabID, generation: prior.generation }))
  const following = forward.result.tabs.find((tab) => tab.tabID === second.tabID)!
  const reload = await Effect.runPromise(execute({ type: "reload", tabID: following.tabID, generation: following.generation }))
  const reloaded = reload.result.tabs.find((tab) => tab.tabID === second.tabID)!
  const stopped = await Effect.runPromise(execute({ type: "stop", tabID: reloaded.tabID, generation: reloaded.generation }))
  const selected = await Effect.runPromise(execute({ type: "tabs.select", tabID: original.tabID, generation: original.generation }))
  const stale = code(await Effect.runPromise(Effect.exit(execute({ type: "snapshot", tabID: second.tabID, generation: second.generation }))))
  const foreign = code(await Effect.runPromise(Effect.exit(execute({ type: "tabs.create", url: process.env.DAC_BROWSER_DENIED! }))))
  await Effect.runPromise(execute({ type: "tabs.create" }))
  const full = await Effect.runPromise(execute({ type: "tabs.create" }))
  const capacity = code(await Effect.runPromise(Effect.exit(execute({ type: "tabs.create" }))))
  const closed = await Effect.runPromise(execute({ type: "tabs.close", tabID: reloaded.tabID, generation: reloaded.generation }))
  const oldClosed = code(await Effect.runPromise(Effect.exit(execute({ type: "snapshot", tabID: reloaded.tabID, generation: reloaded.generation }))))
  const replacement = await Effect.runPromise(execute({ type: "tabs.create" }))
  const cancel = await Effect.runPromise(host.cancel({ ...control, state: "cancel_requested", revision: 3, epoch: 2,
    cancel: { requestID: "cancel", expectedRevision: 2, requestedAt: Date.now() } }))
  port.postMessage({ type: "result", original, second, next, prior, following, reloaded, stopped: stopped.result,
    selected: selected.result, full: full.result, capacity, closed: closed.result, oldClosed, replacement: replacement.result,
    stale, foreign, cancel, verify: host.verify(control), checks })
} catch (error) {
  port.postMessage({ type: "fixture-error", message: String(error), stack: error instanceof Error ? error.stack : undefined })
}
