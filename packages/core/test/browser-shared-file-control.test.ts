import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { BrowserFileControl } from "../src/browser/file-control"
import { BrowserFileSchema } from "../src/browser/file-exchange.schema"
import type { BrowserHost } from "../src/browser/host"
import { SharedBrowserSchema } from "../src/browser/shared-schema"
import { SharedBrowserControl } from "../src/browser/shared-control"
import { SharedBrowserFileBinding } from "../src/browser/shared-file-binding"
import { BrowserFileAuthorityFixture } from "./fixture/browser-file-authority"

test("shared file custody needs its same live opaque capture and never starts Main I/O in a SQL transaction", () =>
  BrowserFileAuthorityFixture.isolated((fixture) => Effect.gen(function* () {
    const scope = fixture.captureInput.control.scope
    const created = yield* SharedBrowserControl.create(fixture.db, { scope, mainIncarnation: "main-distinct",
      sidecarIncarnation: fixture.captureInput.host.hostIncarnation,
      request: { version: 2, profile: SharedBrowserSchema.PROFILE, inputAssurance: SharedBrowserSchema.INPUT_ASSURANCE,
        requestID: "shared-file-control-create", sessionID: scope.sessionID, expiresAt: Date.now() + 60_000,
        policy: { origin: "https://example.com", approvedOrigins: ["https://example.com"],
          manualApprovedOrigins: ["https://example.com"], resolverPolicy: "system", postGrants: [],
          filePolicy: { upload: true, download: true } } } })
    const resource = yield* SharedBrowserControl.observeCreated(fixture.db, created.resource,
      { resourceID: created.resource.resourceID, mainIncarnation: "main-distinct", manualEpoch: 0, barrierOrder: 0,
        resourceAlive: true, agentAccessFenced: false, leaseRevoked: false, inputIsolated: true,
        heldReleased: true, transportStopped: true, manualEnabled: false, unknownEffects: false,
        leaseID: created.lease.leaseID, leaseEpoch: 1 })
    const lease = yield* SharedBrowserControl.lease(fixture.db, created.lease.leaseID)
    if (!lease) throw new Error("Missing actual durable lease")
    const boundary = { calls: 0, live: true }
    const unused = () => Effect.die("This storage/current boundary oracle does not execute Native operations")
    const host: BrowserHost.Interface = { ...fixture.captureInput.host, principal: scope.principal,
      matchesCredentials: () => false, create: unused, cancel: unused, execute: unused,
      shared: { mainIncarnation: "main-distinct", validateInput: unused, create: unused, status: unused,
        syncProjection: unused, takeover: unused, confirmBarrier: unused, acquire: unused, execute: unused, close: unused,
        // Controlled Main seam only. This is not a qualification of the real private port or native confirmation.
        files: { current: (currentResource, currentLease) => Effect.gen(function* () {
          boundary.calls++
          expect(currentResource.resourceID).toBe(resource.resourceID)
          expect(currentLease.leaseID).toBe(lease.leaseID)
          if (!boundary.live) return yield* new BrowserFileSchema.Error({ code: "BROWSER_FILE_CHANGED", message: "Original Main fence" })
        }), confirm: unused } } }
    const before = boundary.calls
    expect(Exit.isFailure(yield* fixture.db.transaction(() =>
      BrowserFileControl.captureShared(fixture.db, resource, lease, host).pipe(Effect.exit)))).toBe(true)
    expect(boundary.calls).toBe(before)
    const handle = yield* Effect.scoped(Effect.gen(function* () {
      const caller = { ...resource, scope: { ...resource.scope } }
      const handle = yield* BrowserFileControl.captureShared(fixture.db, caller, lease, host)
      caller.expiresAt = 0
      caller.scope.directory += "/caller-changed"
      expect(Exit.isSuccess(yield* BrowserFileControl.requireCurrent(fixture.db, handle).pipe(Effect.exit))).toBe(true)
      const calls = boundary.calls
      expect(Exit.isFailure(yield* fixture.db.transaction(() => BrowserFileControl.requireCurrent(fixture.db, handle).pipe(Effect.exit)))).toBe(true)
      expect(boundary.calls).toBe(calls)
      expect(Exit.isFailure(yield* fixture.db.transaction((tx) => BrowserFileControl.requireCurrent(tx, handle).pipe(Effect.exit)))).toBe(true)
      expect(boundary.calls).toBe(calls)
      expect(Exit.isFailure(yield* BrowserFileControl.requireCurrent(fixture.db, { ...handle }).pipe(Effect.exit))).toBe(true)
      boundary.live = false
      expect(Exit.isFailure(yield* BrowserFileControl.requireCurrent(fixture.db, handle).pipe(Effect.exit))).toBe(true)
      boundary.live = true
      const binding = SharedBrowserFileBinding.from(resource, lease)
      expect(binding.policyHash).toBe(SharedBrowserFileBinding.hash(resource.policy))
      expect(binding.scopeHash).toBe(SharedBrowserFileBinding.hash(resource.scope))
      expect(binding.mainIncarnation).not.toBe(binding.sidecarIncarnation)
      return handle
    }))
    const calls = boundary.calls
    expect(Exit.isFailure(yield* BrowserFileControl.requireCurrent(fixture.db, handle).pipe(Effect.exit))).toBe(true)
    expect(boundary.calls).toBe(calls)
  })), 30_000)
