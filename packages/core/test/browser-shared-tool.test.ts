import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import { BrowserControl } from "../src/browser/control"
import { BrowserSchema } from "../src/browser/schema"
import { SharedBrowserControl } from "../src/browser/shared-control"
import { SharedBrowserSchema } from "../src/browser/shared-schema"
import type { SharedBrowserHost } from "../src/browser/shared-host"
import { SharedBrowserTool } from "../src/tool/browser-shared"
import { CurrentToolExecution } from "../src/session/runner/current-tool-execution"
import { BrowserFileAuthorityFixture } from "./fixture/browser-file-authority"
import { AgentV2 } from "../src/agent"
import { PermissionV2 } from "../src/permission"
import { Hash } from "../src/util/hash"
import { SharedBrowserScriptPolicy } from "../src/browser/shared-script-policy"
import { CanonicalJson } from "../src/util/canonical-json"

const code = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
const observe = (
  resource: SharedBrowserSchema.Resource,
  lease: SharedBrowserSchema.Lease,
): SharedBrowserSchema.Observation => ({
  resourceID: resource.resourceID,
  mainIncarnation: resource.mainIncarnation,
  manualEpoch: resource.manualEpoch,
  barrierOrder: resource.barrierOrder,
  resourceAlive: true,
  agentAccessFenced: false,
  leaseRevoked: false,
  inputIsolated: true,
  heldReleased: true,
  transportStopped: false,
  manualEnabled: false,
  unknownEffects: false,
  leaseID: lease.leaseID,
  leaseEpoch: lease.leaseEpoch,
})

test("snapshot-json is opt-in and both original source and argument bytes are required by shared script policy", () => {
  const source = "return page.text"
  const command: Extract<BrowserSchema.Command, { type: "evaluate" }> = { type: "evaluate", tabID: "tab", generation: 1,
    frameID: "frame", observationRevision: 1, source, scriptHash: Hash.sha256(source), argsJSON: "{}" }
  const original = { origin: "http://127.0.0.1:4455", approvedOrigins: ["http://127.0.0.1:4455"],
    manualApprovedOrigins: ["http://127.0.0.1:4455"], resolverPolicy: "system", postGrants: [],
    scriptGrants: [{ scriptHash: command.scriptHash, argsHash: Hash.sha256("{}"), readOnly: true }] }
  const legacy = Schema.decodeUnknownSync(SharedBrowserSchema.Policy)(original)
  expect(CanonicalJson.stringify(legacy)).toBe(CanonicalJson.stringify(original))
  expect("scriptContext" in legacy).toBe(false)
  expect(SharedBrowserScriptPolicy.allowsScript(legacy, command)).toBe(false)
  const policy = Schema.decodeUnknownSync(SharedBrowserSchema.Policy)({ ...original, scriptContext: "snapshot-json-v1" })
  expect(SharedBrowserScriptPolicy.allowsScript(policy, command)).toBe(true)
  expect(SharedBrowserScriptPolicy.allowsScript(policy, { ...command, source: "return document.cookie" })).toBe(false)
  expect(SharedBrowserScriptPolicy.allowsScript(policy, { ...command, argsJSON: "{ }" })).toBe(false)
})

for (const mode of ["basic", "script", "program", "origins"] as const) test(
  mode === "origins" ? "shared origin expansion requires its exact Permission before canonical input and leaves policy unchanged on denial"
    : mode === "program" ? "shared snapshot-json program requires independent program permission and preserves canonical result"
    : mode === "script" ? "shared snapshot-json tool requires independent script permission and persists only the context digest"
    : "shared browser tool uses original canonical admission and permission with one strict private-port dispatch",
  () =>
    BrowserFileAuthorityFixture.isolated((fixture) =>
      Effect.gen(function* () {
        const scripted = mode === "script" || mode === "program"
        const programmed = mode === "program"
        const location = fixture.captureInput.location
        const context = fixture.captureInput.context
        const source = programmed ? "return { version: 1, steps: [{ type: 'fill', target: 'field', text: args.value }] }"
          : "return { count: page.refs.length, text: page.text, echo: args.value }"
        const argsJSON = '{"value":"ok"}'
        const created = yield* SharedBrowserControl.create(fixture.db, {
          request: {
            version: 2,
            profile: SharedBrowserSchema.PROFILE,
            inputAssurance: SharedBrowserSchema.INPUT_ASSURANCE,
            requestID: "shared-tool",
            sessionID: fixture.session.id,
            expiresAt: Date.now() + 60_000,
            policy: {
              origin: "http://127.0.0.1:4455",
              approvedOrigins: ["http://127.0.0.1:4455"],
              manualApprovedOrigins: ["http://127.0.0.1:4455"],
              resolverPolicy: "system",
              postGrants: [],
              ...(scripted ? { scriptContext: "snapshot-json-v1" as const,
                ...(programmed ? { programGrants: [{ scriptHash: Hash.sha256(source), argsHash: Hash.sha256(argsJSON),
                  operations: ["fill"] as const, maxSteps: 1 }] }
                  : { scriptGrants: [{ scriptHash: Hash.sha256(source), argsHash: Hash.sha256(argsJSON), readOnly: true as const }] }) } : {}),
            },
          },
          scope: fixture.captureInput.control.scope,
          mainIncarnation: "shared-main",
          sidecarIncarnation: fixture.captureInput.host.hostIncarnation,
        })
        const resource = yield* SharedBrowserControl.observeCreated(
          fixture.db,
          created.resource,
          observe(created.resource, created.lease),
        )
        const lease = (yield* SharedBrowserControl.lease(fixture.db, created.lease.leaseID))!
        const calls = { execute: 0, acquire: 0 }
        // Only the Main transport is a deterministic seam here. Session creation/admission,
        // claim, canonical selection/receipt, wire sealing, tool admission and permission are real.
        const unavailable = Effect.fail(BrowserControl.failure("BROWSER_DRIVER_UNAVAILABLE"))
        const shared: SharedBrowserHost.Interface = {
          mainIncarnation: resource.mainIncarnation,
          validateInput: () => Effect.succeed(false),
          create: () => unavailable,
          status: () => Effect.succeed(observe(resource, lease)),
          syncProjection: () => Effect.succeed(observe(resource, lease)),
          takeover: () => unavailable,
          confirmBarrier: () => unavailable,
          close: () => unavailable,
          acquire: () =>
            Effect.sync(() => {
              calls.acquire++
            }).pipe(Effect.andThen(unavailable)),
          execute: (_resource, _lease, action, current) =>
            Effect.gen(function* () {
              // The strict private-port schema rejects ActionRecord outcome/journal fields.
              expect(
                Option.isSome(
                  Schema.decodeUnknownOption(SharedBrowserSchema.Action, { onExcessProperty: "error" })(action),
                ),
              ).toBeTrue()
              expect("outcome" in action).toBeFalse()
              yield* current
              calls.execute++
              return { result: { tabs: [], ...(scripted ? { ...(programmed ? { program: { version: 1 as const,
                  planHash: Hash.sha256("approved-plan"), totalSteps: 1, completedSteps: 1,
                  steps: [{ ordinal: 0, operation: "fill" as const }] } } : { scriptResultJSON: '{"done":true}' }),
                scriptContextEvidence: { version: 1 as const, context: "snapshot-json-v1" as const,
                  sha256: Hash.sha256("approved-public-observation"), bytes: 100, frameID: "frame_fixture",
                  observationRevision: 1, generation: 1 } } : {}) } }
            }),
        }
        const services = {
          db: fixture.db,
          location,
          permission: fixture.captureInput.permission,
          host: {
            ...fixture.captureInput.host,
            principal: resource.scope.principal,
            shared,
            matchesCredentials: () => false,
            create: () => unavailable,
            cancel: () => Effect.succeed(false),
            execute: () => unavailable,
          },
        }
        const frame = <A, E, R>(input: SharedBrowserSchema.Invoke, body: Effect.Effect<A, E, R>) =>
          CurrentToolExecution.withAdmission(
            fixture.db,
            { admission: fixture.admission, context, location, input, provider: fixture.turns },
            body,
          )
        if (mode === "origins") {
          const ticket: SharedBrowserSchema.BarrierTicket = { resourceID: resource.resourceID, rootSessionID: resource.rootSessionID,
            mainIncarnation: resource.mainIncarnation, requestID: "origin-barrier", expectedRevision: resource.revision,
            manualEpoch: 1, barrierOrder: 10, reason: "human_takeover" }
          const fenced = yield* SharedBrowserControl.recordBarrier(fixture.db, ticket)
          const manual = yield* SharedBrowserControl.observeBarrier(fixture.db, ticket, { ...observe(fenced.resource, lease),
            manualEpoch: 1, barrierOrder: 10, agentAccessFenced: true, leaseRevoked: true,
            leaseID: null, leaseEpoch: 0, transportStopped: true, manualEnabled: true })
          const human = yield* SharedBrowserControl.approveOrigin(fixture.db, manual, { resourceID: manual.resourceID,
            requestID: "origin-permission", expectedRevision: manual.revision, expectedManualEpoch: 1,
            expectedPolicyHash: manual.policyHash, origin: "https://manual.example" }, () => Effect.void)
          const input: SharedBrowserSchema.Invoke = { operation: "acquire", resourceID: human.resourceID,
            requestID: "origin-acquire", expectedManualEpoch: 1, approvedOrigins: human.policy.manualApprovedOrigins }
          const edit = yield* (yield* AgentV2.Service).transform()
          const rule = (effect: "allow" | "deny") => edit((state) => state.update(context.agent, (agent) => {
            agent.permissions = [{ action: "browser", resource: "*", effect: "allow" },
              { action: "browser", resource: `${human.resourceID}/origins/*`, effect }]
          }))
          yield* rule("deny")
          expect(code(yield* frame(input, SharedBrowserTool.execute(services, input, context)).pipe(Effect.exit)))
            .toBeInstanceOf(PermissionV2.DeniedError)
          expect(yield* SharedBrowserControl.get(fixture.db, human.resourceID)).toEqual(human)
          expect(calls.acquire).toBe(0)
          yield* rule("allow")
          // This original provider receipt predates the manual barrier. Permission alone
          // must not manufacture the new canonical user-input witness needed to acquire.
          expect(code(yield* frame(input, SharedBrowserTool.execute(services, input, context)).pipe(Effect.exit)))
            .toMatchObject({ code: "BROWSER_AUTHORITY_REQUIRED" })
          expect(yield* SharedBrowserControl.get(fixture.db, human.resourceID)).toEqual(human)
          expect(calls.acquire).toBe(0)
          return
        }
        if (scripted) {
          const edit = yield* (yield* AgentV2.Service).transform()
          const permissionAction = programmed ? "browser-program" : "browser-script"
          const scriptRule = (effect: "allow" | "deny") => edit((state) => state.update(context.agent, (agent) => {
            agent.permissions = [...agent.permissions.filter((rule) => rule.action !== permissionAction),
              { action: permissionAction, resource: "*", effect }]
          }))
          const input: SharedBrowserSchema.Invoke = { operation: "execute", resourceID: resource.resourceID,
            command: programmed
              ? { type: "program", tabID: "tab_fixture", frameID: "frame_fixture", generation: 1,
                observationRevision: 1, scriptHash: Hash.sha256(source), source, argsJSON,
                targets: [{ name: "field", ref: "ref_fixture" }] }
              : { type: "evaluate", tabID: "tab_fixture", frameID: "frame_fixture", generation: 1,
                observationRevision: 1, scriptHash: Hash.sha256(source), source, argsJSON } }
          yield* scriptRule("deny")
          expect(code(yield* frame(input, SharedBrowserTool.execute(services, input, context)).pipe(Effect.exit)))
            .toBeInstanceOf(PermissionV2.DeniedError)
          expect(calls.execute).toBe(0)
          yield* scriptRule("allow")
          const output: SharedBrowserTool.Output = yield* frame(input, SharedBrowserTool.execute(services, input, context))
          expect(calls.execute).toBe(1)
          expect(output.result?.scriptContextEvidence?.sha256).toBe(Hash.sha256("approved-public-observation"))
          const persisted = yield* SharedBrowserControl.getAction(fixture.db, output.actionID!)
          expect(persisted?.outcome).toBe("completed")
          expect(persisted?.result).toEqual(output.result)
          expect(JSON.stringify(persisted?.result)).not.toContain("approved-public-observation")
          return
        }
        const status: SharedBrowserSchema.Invoke = { operation: "status", resourceID: resource.resourceID }
        expect(code(yield* SharedBrowserTool.execute(services, status, context).pipe(Effect.exit))).toMatchObject({
          code: "BROWSER_AUTHORITY_REQUIRED",
        })
        const viewed = yield* frame(status, SharedBrowserTool.execute(services, status, context))
        expect(viewed.shared.state).toBe("agent_owned")
        expect("result" in viewed).toBeFalse()
        const input: SharedBrowserSchema.Invoke = {
          operation: "execute",
          resourceID: resource.resourceID,
          command: { type: "tabs.list" },
        }
        const output: SharedBrowserTool.Output = yield* frame(input, SharedBrowserTool.execute(services, input, context))
        expect(output.result).toEqual({ tabs: [] })
        expect(calls.execute).toBe(1)
        expect((yield* SharedBrowserControl.getAction(fixture.db, output.actionID!))?.outcome).toBe("completed")
        expect(
          code(yield* frame(input, SharedBrowserTool.execute(services, input, context)).pipe(Effect.exit)),
        ).toMatchObject({ code: "BROWSER_UNKNOWN" })
        expect(calls.execute).toBe(1)
        const disabled: SharedBrowserSchema.Invoke = {
          operation: "execute",
          resourceID: resource.resourceID,
          command: { type: "files.list" },
        }
        // No native file-custody bridge exists for the shared path, even though this fixture's
        // independent old file profile has a valid browser-file permission and original grant.
        expect(
          code(yield* frame(disabled, SharedBrowserTool.execute(services, disabled, context)).pipe(Effect.exit)),
        ).toMatchObject({ code: "BROWSER_DRIVER_UNAVAILABLE" })
        expect(calls.acquire).toBe(0)
      }),
    ),
  30_000,
)

test("shared file tool checks actual Main readiness before approval and preserves independent browser-file denial before any action", () =>
  BrowserFileAuthorityFixture.isolated((fixture) => Effect.gen(function* () {
    const created = yield* SharedBrowserControl.create(fixture.db, { scope: fixture.captureInput.control.scope,
      mainIncarnation: "file-tool-main", sidecarIncarnation: fixture.captureInput.host.hostIncarnation,
      request: { version: 2, profile: SharedBrowserSchema.PROFILE, inputAssurance: SharedBrowserSchema.INPUT_ASSURANCE,
        requestID: "file-tool-readiness", sessionID: fixture.session.id, expiresAt: Date.now() + 60_000,
        policy: { origin: "https://example.com", approvedOrigins: ["https://example.com"], manualApprovedOrigins: ["https://example.com"],
          resolverPolicy: "system", postGrants: [], filePolicy: { upload: true, download: true } } } })
    const resource = yield* SharedBrowserControl.observeCreated(fixture.db, created.resource, observe(created.resource, created.lease))
    const facts = { ready: false, dispatch: 0 }
    const unavailable = () => Effect.die("No Native or binary producer dispatch is allowed in the tool admission oracle")
    const sharedFiles = {
      preview: unavailable, describePreview: () => undefined, currentPreview: unavailable, confirm: unavailable, approved: () => false,
      describeApproval: () => undefined, acceptGrant: () => false, prepare: unavailable, executionFiles: unavailable, finishAction: unavailable,
    }
    const shared: SharedBrowserHost.Interface = { mainIncarnation: resource.mainIncarnation, validateInput: unavailable, create: unavailable,
      status: unavailable, syncProjection: unavailable, takeover: unavailable, confirmBarrier: unavailable, acquire: unavailable, close: unavailable,
      files: { current: () => Effect.void, ready: () => Effect.succeed(facts.ready), confirm: unavailable },
      execute: () => Effect.sync(() => { facts.dispatch++; throw new Error("No file action may be dispatched") }) }
    const services = { db: fixture.db, location: fixture.captureInput.location, permission: fixture.captureInput.permission,
      files: { shared: sharedFiles }, host: { ...fixture.captureInput.host, principal: resource.scope.principal, shared, matchesCredentials: () => false,
        create: unavailable, cancel: unavailable, execute: unavailable } }
    const input: SharedBrowserSchema.Invoke = { operation: "execute", resourceID: resource.resourceID, command: { type: "file.upload",
      tabID: "tab", generation: 1, frameID: "frame", observationRevision: 1, ref: "ref", grantIDs: ["not-an-approved-grant"] } }
    const frame = <A, E, R>(body: Effect.Effect<A, E, R>) => CurrentToolExecution.withAdmission(fixture.db,
      { admission: fixture.admission, context: fixture.captureInput.context, location: services.location, input, provider: fixture.turns }, body)
    const edit = yield* (yield* AgentV2.Service).transform()
    const fileRule = (effect: "allow" | "deny") => edit((state) => state.update(fixture.captureInput.context.agent, (agent) => {
      agent.permissions = [...agent.permissions.filter((rule) => rule.action !== "browser-file"), { action: "browser-file", resource: "*", effect }]
    }))
    yield* fileRule("deny")
    expect(code(yield* frame(SharedBrowserTool.execute(services, input, fixture.captureInput.context)).pipe(Effect.exit)))
      .toMatchObject({ code: "BROWSER_DRIVER_UNAVAILABLE" })
    facts.ready = true
    expect(code(yield* frame(SharedBrowserTool.execute(services, input, fixture.captureInput.context)).pipe(Effect.exit)))
      .toBeInstanceOf(PermissionV2.DeniedError)
    expect(yield* fixture.db.all("SELECT action_id FROM browser_shared_action")).toEqual([])
    yield* fileRule("allow")
    expect(code(yield* frame(SharedBrowserTool.execute(services, input, fixture.captureInput.context)).pipe(Effect.exit)))
      .toMatchObject({ code: "BROWSER_SCOPE_DENIED" })
    expect(yield* fixture.db.all("SELECT action_id FROM browser_shared_action")).toEqual([])
    expect(facts.dispatch).toBe(0)
  })), 30_000)
