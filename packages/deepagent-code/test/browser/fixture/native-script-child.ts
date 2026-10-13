import { Effect, Exit, Option, Cause } from "effect"
import { BrowserNativeHost } from "../../../src/browser/native-host"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { BrowserControl } from "@deepagent-code/core/browser/control"
import { Hash } from "@deepagent-code/core/util/hash"

const port = Reflect.get(process, "parentPort") as { postMessage(value: unknown): void }
await BrowserNativeHost.prepare()
const host = BrowserNativeHost.current()!
const programs = {
  read: "return {heading:document.querySelector('h1').textContent, label:args.label, host:[typeof process,typeof require,typeof window.api]};",
  write: "document.body.setAttribute('data-script-write','yes'); return true;",
  network: "fetch(args.url); return true;",
  promise: "return Promise.resolve(1);",
  large: "return 'x'.repeat(65537);",
  endless: "for (;;) {}",
  checkDOM: "return document.body.getAttribute('data-script-write');",
}
const args = JSON.stringify({ label: "验证参数" })
const grants = [
  { source: programs.read, argsJSON: args }, { source: programs.write, argsJSON: "null" },
  { source: programs.network, argsJSON: JSON.stringify({ url: process.env.DAC_BROWSER_ORIGIN! + "/script-network" }) },
  { source: programs.network, argsJSON: JSON.stringify({ url: process.env.DAC_BROWSER_DENIED! }) },
  { source: programs.promise, argsJSON: "null" }, { source: programs.large, argsJSON: "null" },
  { source: programs.endless, argsJSON: "null" },
  { source: programs.checkDOM, argsJSON: "null" },
]
const now = Date.now()
const control: BrowserSchema.Control = {
  version: 1, controlID: "script-control", requestID: "script-create", requestDigest: "a".repeat(64),
  scope: { principal: "deepagent-code", securityNamespaceID: "namespace-test", locationKey: "location-test",
    projectScopeKey: "project-scope-test", namespaceBindingHash: "a".repeat(64), sessionID: "session-test",
    projectID: "project-test", directory: "/private/fixture", workspaceID: null },
  hostID: host.hostID, hostIncarnation: host.hostIncarnation, resourceID: "script-resource",
  credentialBinding: host.credentialBinding, profile: BrowserSchema.INTERACTION_PROFILE,
  postPaths: [], scriptGrants: grants.map((grant) => ({ scriptHash: Hash.sha256(grant.source),
    argsHash: Hash.sha256(grant.argsJSON), readOnly: true })),
  origin: process.env.DAC_BROWSER_ORIGIN!, revision: 1, epoch: 1, policyRevision: 1, state: "creating",
  expiresAt: now + 60_000, createdAt: now, updatedAt: now, cancel: null, stopConfirmedAt: null,
}
let seq = 0
let allowed = true
const active = { ...control, state: "active" as const, revision: 2 }
const action = (command: BrowserSchema.Command): BrowserSchema.Action => ({
  version: 1, actionID: `script-action-${++seq}`, controlID: control.controlID, requestID: `script-request-${seq}`,
  commandDigest: BrowserControl.hash(command), command, admissionID: `script-admission-${seq}`,
  providerReceiptID: "provider-receipt", providerAttemptID: "provider-attempt", toolCallID: `script-call-${seq}`,
  sessionID: control.scope.sessionID, hostIncarnation: control.hostIncarnation, resourceID: control.resourceID,
  controlEpoch: 1, policyRevision: 1, revision: 1, deadline: Date.now() + 10_000, outcome: "pending", result: null,
  errorCode: null, createdAt: Date.now(), updatedAt: Date.now(), terminalAt: null, stopConfirmedAt: null,
})
const current = Effect.suspend(() => allowed ? Effect.void : Effect.fail(BrowserControl.failure("BROWSER_SCOPE_DENIED")))
const execute = (command: BrowserSchema.Command) => Effect.runPromise(host.execute(active, action(command), current))
const code = (exit: Exit.Exit<unknown, BrowserSchema.Error>) => Exit.isFailure(exit)
  ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))?.code : null
const rejected = (command: BrowserSchema.Command) => Effect.runPromise(Effect.exit(host.execute(active, action(command), current))).then(code)

try {
  await Effect.runPromise(host.create(control))
  const original = (await execute({ type: "tabs.list" })).result.tabs[0]!
  const navigated = await execute({ type: "navigate", tabID: original.tabID, generation: original.generation,
    url: control.origin + "/script-page" })
  const tab = navigated.result.tabs[0]!
  const snapshot = () => execute({ type: "snapshot", tabID: tab.tabID, generation: tab.generation })
  const command = (page: BrowserSchema.Result, source: string, argsJSON: string): BrowserSchema.Command => ({
    type: "evaluate", tabID: tab.tabID, generation: tab.generation, frameID: page.frameID!,
    observationRevision: page.observationRevision!, scriptHash: Hash.sha256(source), source, argsJSON,
  })
  const observed = (await snapshot()).result
  const wrongSource = await rejected(command(observed, programs.read + "\nreturn 2;", args))
  const wrongArgs = await rejected(command(observed, programs.read, JSON.stringify({ label: "other" })))
  const copiedDescriptor = code(await Effect.runPromise(Effect.exit(host.execute({ ...active, scriptGrants: [] },
    action(command(observed, programs.read, args)), current))))
  allowed = false
  const revoked = await rejected(command(observed, programs.read, args))
  allowed = true
  const normal = await execute(command(observed, programs.read, args))
  const stale = await rejected(command(observed, programs.read, args))
  const failures: Array<{ kind: string; code: string | null | undefined }> = []
  let repeat: string | null | undefined
  for (const grant of grants.slice(1, 7)) {
    const page = (await snapshot()).result
    const dispatched = action(command(page, grant.source, grant.argsJSON))
    failures.push({ kind: grant.source === programs.network ? grant.argsJSON.includes("script-network") ? "sameNetwork" : "foreignNetwork" :
      Object.entries(programs).find((entry) => entry[1] === grant.source)![0],
      code: code(await Effect.runPromise(Effect.exit(host.execute(active, dispatched, current)))) })
    if (grant.source === programs.endless)
      repeat = code(await Effect.runPromise(Effect.exit(host.execute(active, dispatched, current))))
  }
  const untouched = await execute(command((await snapshot()).result, programs.checkDOM, "null"))
  const checkDOM = programs.checkDOM + "\nreturn 'unapproved';"
  // A different approved source cannot be added by changing the public descriptor.
  const cannotAddGrant = code(await Effect.runPromise(Effect.exit(host.execute({ ...active,
    scriptGrants: [...active.scriptGrants!, { scriptHash: Hash.sha256(checkDOM), argsHash: Hash.sha256("null"), readOnly: true }] },
    action(command((await snapshot()).result, checkDOM, "null")), current))))
  let capacity: string | null | undefined
  let extraSuccess = 0
  for (let index = 0; index <= BrowserSchema.MAX_SCRIPT_WORLDS; index++) {
    const page = (await snapshot()).result
    const result = await Effect.runPromise(Effect.exit(host.execute(active, action(command(page, programs.read, args)), current)))
    if (Exit.isFailure(result)) { capacity = code(result); break }
    extraSuccess++
  }
  const stopped = await Effect.runPromise(host.cancel({ ...active, state: "cancel_requested", revision: 3, epoch: 2,
    cancel: { requestID: "script-cancel", expectedRevision: 2, requestedAt: Date.now() } }))
  port.postMessage({ type: "result", normal: normal.result, wrongSource, wrongArgs, copiedDescriptor, revoked,
    stale, failures, repeat, untouched: untouched.result.scriptResultJSON, cannotAddGrant, capacity, extraSuccess,
    stopped, verify: host.verify(control) })
} catch (error) {
  port.postMessage({ type: "fixture-error", message: String(error), stack: error instanceof Error ? error.stack : undefined })
}
