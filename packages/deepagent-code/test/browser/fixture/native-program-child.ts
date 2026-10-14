import { Cause, Effect, Exit, Option } from "effect"
import { BrowserNativeHost } from "../../../src/browser/native-host"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { BrowserControl } from "@deepagent-code/core/browser/control"
import { Hash } from "@deepagent-code/core/util/hash"

const port = Reflect.get(process, "parentPort") as {
  postMessage(value: unknown): void
  on(event: "message", callback: (event: { data: { type: string } }) => void): void
}
await BrowserNativeHost.prepare()
const host = BrowserNativeHost.current()!
const sources = {
  normal:
    "if (document.querySelector('h1').textContent !== 'Program fixture') throw Error('Wrong page'); return {version:1,steps:[{type:'fill',target:'name',text:args.text},{type:'select',target:'choice',values:['b']},{type:'click',target:'submit',waitForNavigation:true}]};",
  mutation: "document.body.setAttribute('data-program-write','yes'); return {version:1,steps:[]};",
  network: "fetch(args.url); return {version:1,steps:[]};",
  clipboard: "navigator.clipboard.writeText('forbidden'); return {version:1,steps:[]};",
  invalid: "return {version:1,steps:[{type:'clipboard.write',target:'name',text:'forbidden'}]};",
  oversized: "return {version:1,steps:Array.from({length:17},()=>({type:'fill',target:'name',text:'forbidden'}))};",
  preflight:
    "return {version:1,steps:[{type:'fill',target:'name',text:args.text},{type:'select',target:document.body.hasAttribute('data-select-tail')?'tail':'choice',values:['absent']}]};",
  read: "return {name:document.querySelector('input')?.value,choice:document.querySelector('select')?.value,tail:document.querySelector('input[aria-label=Tail]')?.value,write:document.body.getAttribute('data-program-write')};",
}
const argsJSON = JSON.stringify({ text: "program value" })
const grants = [
  { source: sources.normal, argsJSON },
  { source: sources.mutation, argsJSON: "null" },
  {
    source: sources.network,
    argsJSON: JSON.stringify({ url: process.env.DAC_BROWSER_ORIGIN! + "/program-planner-network" }),
  },
  { source: sources.network, argsJSON: JSON.stringify({ url: process.env.DAC_BROWSER_DENIED! }) },
  { source: sources.clipboard, argsJSON: "null" },
  { source: sources.invalid, argsJSON: "null" },
  { source: sources.oversized, argsJSON: "null" },
  { source: sources.preflight, argsJSON },
]
const now = Date.now()
const control: BrowserSchema.Control = {
  version: 1,
  controlID: "program-control",
  requestID: "program-create",
  requestDigest: "a".repeat(64),
  scope: {
    principal: "deepagent-code",
    securityNamespaceID: "namespace-program",
    locationKey: "location-program",
    projectScopeKey: "scope-program",
    namespaceBindingHash: "a".repeat(64),
    sessionID: "session-program",
    projectID: "project-program",
    directory: "/private/program-fixture",
    workspaceID: null,
  },
  hostID: host.hostID,
  hostIncarnation: host.hostIncarnation,
  resourceID: "program-resource",
  credentialBinding: host.credentialBinding,
  profile: BrowserSchema.INTERACTION_PROFILE,
  postPaths: ["/program-submit", "/program-hold-submit", "/program-late-post"],
  programGrants: grants.map((grant) => ({
    scriptHash: Hash.sha256(grant.source),
    argsHash: Hash.sha256(grant.argsJSON),
    operations: ["fill", "select", "click", "press", "scroll", "drag"],
    maxSteps: 16,
  })),
  scriptGrants: [{ scriptHash: Hash.sha256(sources.read), argsHash: Hash.sha256("null"), readOnly: true }],
  origin: process.env.DAC_BROWSER_ORIGIN!,
  revision: 1,
  epoch: 1,
  policyRevision: 1,
  state: "creating",
  expiresAt: now + 60_000,
  createdAt: now,
  updatedAt: now,
  cancel: null,
  stopConfirmedAt: null,
}
const active = { ...control, state: "active" as const, revision: 2 }
let seq = 0
let allowed = true
const current = Effect.suspend(() =>
  allowed ? Effect.void : Effect.fail(BrowserControl.failure("BROWSER_SCOPE_DENIED")),
)
const action = (command: BrowserSchema.Command): BrowserSchema.Action => ({
  version: 1,
  actionID: `program-action-${++seq}`,
  controlID: control.controlID,
  requestID: `program-request-${seq}`,
  commandDigest: BrowserControl.hash(command),
  command,
  admissionID: `program-admission-${seq}`,
  providerReceiptID: "program-receipt",
  providerAttemptID: "program-attempt",
  toolCallID: `program-call-${seq}`,
  sessionID: control.scope.sessionID,
  hostIncarnation: control.hostIncarnation,
  resourceID: control.resourceID,
  controlEpoch: 1,
  policyRevision: 1,
  revision: 1,
  deadline: Date.now() + 10_000,
  outcome: "pending",
  result: null,
  errorCode: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  terminalAt: null,
  stopConfirmedAt: null,
})
const code = (exit: Exit.Exit<unknown, BrowserSchema.Error>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))?.code : null
const unexpectedFailures: unknown[] = []
const execute = (command: BrowserSchema.Command) => {
  const admitted = action(command)
  return Effect.runPromise(
    host.execute(active, admitted, current).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          // Observe only after the original failure. Never dispatch the failed command again.
          const observed = yield* host.execute(active, action({ type: "tabs.list" }), current).pipe(Effect.exit)
          unexpectedFailures.push({
            commandType: command.type,
            tabID: "tabID" in command ? command.tabID : null,
            commandGeneration: "generation" in command ? command.generation : null,
            actionID: admitted.actionID,
            admittedOutcome: admitted.outcome,
            terminalOutcome: null,
            terminalOutcomeUnavailable: "Native host execute errors expose an error code, not a durable action outcome",
            errorCode: Option.getOrUndefined(Cause.findErrorOption(cause))?.code,
            latestTabs: Exit.isSuccess(observed) ? observed.value.result.tabs : null,
            generationAfterFailure:
              Exit.isSuccess(observed) && "tabID" in command
                ? (observed.value.result.tabs.find((tab) => tab.tabID === command.tabID)?.generation ?? null)
                : null,
            observationError: Exit.isFailure(observed) ? code(observed) : null,
          })
          return yield* Effect.failCause(cause)
        }),
      ),
    ),
  )
}
const rejected = (command: BrowserSchema.Command) =>
  Effect.runPromise(host.execute(active, action(command), current).pipe(Effect.exit)).then(code)

try {
  await Effect.runPromise(host.create(control))
  let tab = (await execute({ type: "tabs.list" })).result.tabs[0]!
  const page = async (url: string) => {
    tab = (await execute({ type: "navigate", tabID: tab.tabID, generation: tab.generation, url: control.origin + url }))
      .result.tabs[0]!
    return (await execute({ type: "snapshot", tabID: tab.tabID, generation: tab.generation })).result
  }
  const snapshot = () =>
    execute({ type: "snapshot", tabID: tab.tabID, generation: tab.generation }).then((value) => value.result)
  const command = (
    observed: BrowserSchema.Result,
    source = sources.normal,
    parameters = argsJSON,
  ): BrowserSchema.Command => ({
    type: "program",
    tabID: tab.tabID,
    generation: tab.generation,
    frameID: observed.frameID!,
    observationRevision: observed.observationRevision!,
    scriptHash: Hash.sha256(source),
    source,
    argsJSON: parameters,
    targets: [
      { name: "name", ref: observed.refs!.find((value) => value.name === "Name")!.ref },
      { name: "choice", ref: observed.refs!.find((value) => value.name === "Choice")!.ref },
      { name: "submit", ref: observed.refs!.find((value) => value.name === "Submit")!.ref },
      { name: "tail", ref: observed.refs!.find((value) => value.name === "Tail")!.ref },
    ],
  })
  const read = async () => {
    const observed = await snapshot()
    return JSON.parse(
      (
        await execute({
          type: "evaluate",
          tabID: tab.tabID,
          generation: tab.generation,
          frameID: observed.frameID!,
          observationRevision: observed.observationRevision!,
          scriptHash: Hash.sha256(sources.read),
          source: sources.read,
          argsJSON: "null",
        })
      ).result.scriptResultJSON!,
    )
  }
  const observed = await page("/program-page")
  const wrongSource = await rejected(command(observed, sources.normal + "\nreturn null;"))
  const wrongArgs = await rejected(command(observed, sources.normal, '{"text":"changed"}'))
  const clone = code(
    await Effect.runPromise(
      host.execute({ ...active, programGrants: [] }, action(command(observed)), current).pipe(Effect.exit),
    ),
  )
  allowed = false
  const revoked = await rejected(command(observed))
  allowed = true
  const normal = await execute(command(observed))
  tab = normal.result.tabs[0]!
  const staleObservation = await rejected(command(observed))
  const failures: Array<{ kind: string; code: string | null | undefined }> = []
  const preflight: Array<{ kind: string; code: string | null | undefined; observed: unknown }> = []
  for (const kind of ["option", "target"]) {
    const result = await rejected(command(await page(`/program-preflight-${kind}`), sources.preflight))
    preflight.push({ kind, code: result, observed: await read() })
  }
  await page("/program-page")
  for (const grant of grants.slice(1, 7)) {
    failures.push({
      kind: Object.entries(sources).find((value) => value[1] === grant.source)![0],
      code: await rejected(command(await snapshot(), grant.source, grant.argsJSON)),
    })
  }
  const untouched = await read()
  const stale = await rejected(command(await page("/program-stale")))
  const prefix = await read()
  const hold = command(await page("/program-hold"))
  const pendingAction = action(hold)
  const holdReady = new Promise<void>((resolve) =>
    port.on("message", (event) => {
      if (event.data.type === "hold-ready") resolve()
    }),
  )
  const lateComplete = new Promise<void>((resolve) =>
    port.on("message", (event) => {
      if (event.data.type === "late-complete") resolve()
    }),
  )
  const pending = Effect.runPromise(host.execute(active, pendingAction, current).pipe(Effect.exit))
  await Promise.all([holdReady, lateComplete])
  const stopped = await Effect.runPromise(
    host.cancel({
      ...active,
      state: "cancel_requested",
      revision: 3,
      epoch: 2,
      cancel: { requestID: "program-cancel", expectedRevision: 2, requestedAt: Date.now() },
    }),
  )
  const cancelled = code(await pending)
  const repeat = code(await Effect.runPromise(host.execute(active, pendingAction, current).pipe(Effect.exit)))
  port.postMessage({
    type: "result",
    normal: normal.result,
    wrongSource,
    wrongArgs,
    clone,
    revoked,
    staleObservation,
    preflight,
    failures,
    untouched,
    stale,
    prefix,
    cancelled,
    repeat,
    stopped,
    verify: host.verify(active),
  })
} catch (error) {
  port.postMessage({
    type: "fixture-error",
    message: String(error),
    stack: error instanceof Error ? error.stack : undefined,
    unexpectedFailures,
  })
}
