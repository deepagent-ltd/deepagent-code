import { Effect, Exit, Option, Cause } from "effect"
import { BrowserNativeHost } from "../../../src/browser/native-host"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { BrowserControl } from "@deepagent-code/core/browser/control"

const port = Reflect.get(process, "parentPort") as {
  postMessage(value: unknown): void
  on(event: "message", listener: (event: { data: { type?: string } }) => void): void
}
const ready = new Promise<void>((resolve) => port.on("message", (event) => {
  if (event.data.type === "slow-ready") resolve()
}))
await BrowserNativeHost.prepare()
const host = BrowserNativeHost.current()!
const now = Date.now()
const controls: BrowserSchema.Control[] = [0, 1, 2, 3, 4].map((index) => ({
  version: 1, controlID: `control-${index}`, requestID: `create-${index}`, requestDigest: "a".repeat(64),
  scope: { principal: "deepagent-code", securityNamespaceID: "namespace-test", locationKey: "location-test", projectScopeKey: "project-scope-test",
    namespaceBindingHash: "a".repeat(64), sessionID: `session-${index}`, projectID: "project-test", directory: "/private/fixture", workspaceID: null },
  hostID: host.hostID, hostIncarnation: host.hostIncarnation, resourceID: `resource-${index}`, credentialBinding: host.credentialBinding,
  profile: BrowserSchema.PROFILE, origin: process.env.DAC_BROWSER_ORIGIN!, revision: 1, epoch: 1, policyRevision: 1,
  state: "creating", expiresAt: now + 60_000, createdAt: now, updatedAt: now, cancel: null, stopConfirmedAt: null,
}))
let sequence = 0
const execute = (control: BrowserSchema.Control, command: BrowserSchema.Command) => {
  const id = String(++sequence)
  const action: BrowserSchema.Action = { version: 1, actionID: `action-${id}`, controlID: control.controlID,
    requestID: `admission-${id}`, commandDigest: BrowserControl.hash(command), command,
    admissionID: `admission-${id}`, providerReceiptID: "provider-receipt", providerAttemptID: "provider-attempt", toolCallID: `call-${id}`,
    sessionID: control.scope.sessionID, hostIncarnation: control.hostIncarnation, resourceID: control.resourceID,
    controlEpoch: 1, policyRevision: 1, revision: 1, deadline: Date.now() + 10_000, outcome: "pending", result: null,
    errorCode: null, createdAt: Date.now(), updatedAt: Date.now(), terminalAt: null, stopConfirmedAt: null }
  return Effect.runPromise(Effect.exit(host.execute({ ...control, state: "active", revision: 2 }, action, Effect.void)))
}
const code = (exit: Exit.Exit<unknown, BrowserSchema.Error>) => Exit.isFailure(exit)
  ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))?.code : null
try {
  await Promise.all(controls.slice(0, 4).map((control) => Effect.runPromise(host.create(control))))
  const failedCreate = code(await Effect.runPromise(Effect.exit(host.create(controls[4]!))))
  const failedCreateVerified = host.verify(controls[4]!).matched
  const running = controls.slice(0, 2)
  const tabs = await Promise.all(running.map((control) => execute(control, { type: "tabs.list" })))
  const navigation = running.map((control, index) => {
    const result = tabs[index]!
    if (Exit.isFailure(result)) throw new Error("Initial tab failed")
    const tab = result.value.result.tabs[0]!
    return execute(control, { type: "navigate", tabID: tab.tabID, generation: tab.generation, url: control.origin + "/slow" })
  })
  await ready
  let rejected = 0
  let notified: () => void = () => {}
  const filled = new Promise<void>((resolve) => { notified = resolve })
  // Two resources each have a real navigation running. The seventeenth and eighteenth
  // waiting actions must be rejected globally, even though neither local queue is full.
  const queued = Array.from({ length: 18 }, (_, index) => execute(controls[index % 2]!, { type: "tabs.list" }).then((result) => {
    if (code(result) === "BROWSER_CAPACITY" && ++rejected === 2) notified()
    return result
  }))
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([filled, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1_500) })])
  clearTimeout(timer)
  const beforeCancel = rejected
  const started = Date.now()
  const cancelled = await Promise.all(running.map((control) => Effect.runPromise(host.cancel(control))))
  await Promise.all(controls.slice(2, 4).map((control) => Effect.runPromise(host.cancel(control))))
  const elapsed = Date.now() - started
  const outcomes = (await Promise.all([...navigation, ...queued])).map(code)
  port.postMessage({ type: "result", beforeCancel, elapsed, cancelled, outcomes, failedCreate, failedCreateVerified })
} catch (error) {
  await Promise.allSettled(controls.map((control) => Effect.runPromise(host.cancel(control))))
  port.postMessage({ type: "fixture-error", message: String(error), stack: error instanceof Error ? error.stack : undefined })
}
