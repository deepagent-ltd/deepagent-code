import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { BrowserFileAuthorityFixture } from "../../../core/test/fixture/browser-file-authority"
import { BrowserFileCapability } from "@deepagent-code/core/browser/file-capability"
import { BrowserFileCapacityTable } from "@deepagent-code/core/browser/browser-file.sql"
import { BrowserFileSchema } from "@deepagent-code/core/browser/file-exchange.schema"
import { BrowserHost } from "@deepagent-code/core/browser/host"
import { SharedBrowserControl } from "@deepagent-code/core/browser/shared-control"
import { SharedBrowserSchema } from "@deepagent-code/core/browser/shared-schema"
import { Database } from "@deepagent-code/core/database/database"
import { BrowserFiles } from "../../src/browser/file-exchange"

const code = (exit: Exit.Exit<unknown, BrowserFileSchema.Error>) => Exit.isFailure(exit) ?
  Option.getOrUndefined(Cause.findErrorOption(exit.cause))?.code : undefined

test("same file factory: shared source cannot obtain Native files, mixed previews release opening custody and opaque owner handles stay distinct", () =>
  BrowserFileAuthorityFixture.isolated((fixture) => Effect.gen(function* () {
    const scope = fixture.captureInput.control.scope
    const created = yield* SharedBrowserControl.create(fixture.db, { scope, mainIncarnation: "source-main-distinct",
      sidecarIncarnation: fixture.captureInput.host.hostIncarnation, request: { version: 2, profile: SharedBrowserSchema.PROFILE,
        inputAssurance: SharedBrowserSchema.INPUT_ASSURANCE, requestID: "shared-factory", sessionID: scope.sessionID, expiresAt: Date.now() + 60_000,
        policy: { origin: "https://example.com", approvedOrigins: ["https://example.com"], manualApprovedOrigins: ["https://example.com"],
          resolverPolicy: "system", postGrants: [], filePolicy: { upload: true, download: true } } } })
    const resource = yield* SharedBrowserControl.observeCreated(fixture.db, created.resource, {
      resourceID: created.resource.resourceID, mainIncarnation: "source-main-distinct", manualEpoch: 0, barrierOrder: 0,
      resourceAlive: true, agentAccessFenced: false, leaseRevoked: false, inputIsolated: true, heldReleased: true, transportStopped: true,
      manualEnabled: false, unknownEffects: false, leaseID: created.lease.leaseID, leaseEpoch: 1 })
    const lease = yield* SharedBrowserControl.lease(fixture.db, created.lease.leaseID)
    if (!lease) throw new Error("Missing actual shared lease")
    const unused = () => Effect.die("Source factory must not confirm or dispatch Native")
    const probes = { current: 0 }
    const host: BrowserHost.Interface = { ...fixture.captureInput.host, principal: scope.principal, matchesCredentials: () => false,
      create: unused, cancel: unused, execute: unused,
      shared: { mainIncarnation: resource.mainIncarnation, validateInput: unused, create: unused, status: unused, syncProjection: unused,
        takeover: unused, confirmBarrier: unused, acquire: unused, execute: unused, close: unused,
        files: { current: () => Effect.sync(() => { probes.current++ }), confirm: unused } } }
    const layer = BrowserFiles.layer.pipe(Layer.provide(Layer.succeed(BrowserHost.Current, host)),
      Layer.provide(Layer.succeed(Database.Service, { db: fixture.db })))
    yield* Effect.gen(function* () {
      const native = yield* BrowserFileCapability.Service
      const api = yield* BrowserFiles.Service
      expect(native.shared).toBeDefined()
      const request = { direction: "upload" as const, relative: "source.bin", targetURL: "https://example.com/upload" }
      // The actual source NativeInstallation rejects this Bun interpreter. No fake asset,
      // global pin, alternate helper, original DB or signed production artifact is used.
      for (const _ of Array.from({ length: 9 })) {
        expect(code(yield* api.shared.preview({ resourceID: resource.resourceID, scope, request }).pipe(Effect.exit))).toBe("BROWSER_FILE_UNAVAILABLE")
        expect(code(yield* native.preview({ control: fixture.captureInput.control,
          request: { direction: "upload", relative: "source.bin", targetPath: "/upload" } }).pipe(Effect.exit))).toBe("BROWSER_FILE_UNAVAILABLE")
      }
      const fake = Object.freeze({}) as BrowserFileCapability.Preview
      expect(native.shared!.describePreview(fake, { resource, lease, request })).toBeUndefined()
      expect(code(yield* native.shared!.currentPreview(fake).pipe(Effect.exit))).toBe("BROWSER_FILE_CHANGED")
      expect((yield* api.shared.list({ resourceID: resource.resourceID, scope })).grants).toHaveLength(0)
      expect(yield* fixture.db.select().from(BrowserFileCapacityTable)).toEqual([])
      expect(probes.current).toBeGreaterThan(0)
    }).pipe(Effect.provide(layer))
  })), 30_000)
