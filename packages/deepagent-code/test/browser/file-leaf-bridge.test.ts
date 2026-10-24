import { expect, test } from "bun:test"
import { Context, Effect, Exit } from "effect"
import { BrowserFileCapability } from "@deepagent-code/core/browser/file-capability"
import { BrowserFileSchema } from "@deepagent-code/core/browser/file-exchange.schema"
import { BrowserFileLeafBridge } from "../../src/browser/file-leaf-bridge"

test("original binary leaf bridge serializes one captured transfer, rejects changed authority and reconciles only exact native observations", async () => {
  const observed = Object.freeze({}) as BrowserFileCapability.Observation
  const transfer = Object.freeze({}) as BrowserFileCapability.Transfer
  const publication: BrowserFileSchema.Publication = { version: 1, artifactID: "artifact", grantID: "grant", direction: "upload",
    rootIdentity: { kind: "posix", device: "1", inode: "2" }, stageIdentity: { kind: "posix", device: "1", inode: "3" },
    fileIdentity: { kind: "posix", device: "1", inode: "4" }, bytes: 1, sha256: "a".repeat(64), helperHash: "b".repeat(64), observedAt: 1, outcome: "selected" }
  const facts = { current: 0, read: 0, write: 0, observe: 0, recorded: 0, cleanup: 0, unknown: 0 }
  const gate = Promise.withResolvers<boolean>()
  const state = { allowed: true, first: true }
  const unavailable = () => Effect.die("Unrelated producer method must not run")
  // Controlled opaque producer for the shared leaf implementation. This is not Native qualification.
  const capability: BrowserFileCapability.Interface = {
    preview: unavailable, describePreview: () => undefined, currentPreview: unavailable, confirm: unavailable, approved: () => false,
    describeApproval: () => undefined, acceptGrant: () => false, prepare: unavailable,
    current: (handle) => Effect.sync(() => { expect(handle).toBe(transfer); facts.current++ }),
    readUpload: (handle) => Effect.sync(() => { expect(handle).toBe(transfer); facts.read++; return Uint8Array.of(0xff) }),
    writeDownload: () => Effect.sync(() => { facts.write++ }), sealUpload: () => Effect.void,
    observeUpload: () => Effect.sync(() => { facts.observe++; return observed }), publishDownload: unavailable,
    describe: (handle) => handle === observed ? publication : undefined, cleanup: () => Effect.sync(() => { facts.cleanup++; return Object.freeze({}) as BrowserFileCapability.Released }),
    describeReleased: () => undefined, recordObservation: (handle, id, value) => Effect.sync(() => {
      expect(handle).toBe(transfer); expect(id).toBe("artifact"); expect(value).toBe(observed); facts.recorded++
    }), unknownAction: () => Effect.sync(() => { facts.unknown++ }),
  }
  const bridge = BrowserFileLeafBridge.make({ capability, transfer, files: [{ grant: { preview: { name: "actual.bin" } }, artifact: { artifactID: "artifact" } }],
    context: Context.empty(), current: () => { if (state.first) { state.first = false; return gate.promise } return Promise.resolve(state.allowed) } })
  const first = bridge.leaf({ operation: "upload.read", artifactID: "artifact", offset: 0, length: 1 })
  expect((await bridge.leaf({ operation: "upload.read", artifactID: "artifact", offset: 0, length: 1 })).error).toBe("BROWSER_FILE_CHANGED")
  expect(facts.read).toBe(0)
  gate.resolve(true)
  expect(await first).toEqual({ payload: "/w==" })
  state.allowed = false
  expect((await bridge.leaf({ operation: "upload.read", artifactID: "artifact", offset: 1, length: 1 })).error).toBe("BROWSER_FILE_CHANGED")
  expect(facts.read).toBe(1)
  state.allowed = true
  expect((await bridge.leaf({ operation: "download.write", artifactID: "artifact", offset: 0, payload: "AB==" })).error).toBe("BROWSER_FILE_INVALID")
  expect(facts.write).toBe(0)
  expect((await bridge.leaf({ operation: "upload.observe", artifactID: "other", bytes: 1, sha256: publication.sha256 })).error).toBe("BROWSER_FILE_CHANGED")
  expect(await bridge.leaf({ operation: "upload.observe", artifactID: "artifact", bytes: 1, sha256: publication.sha256 })).toEqual({ publication })
  expect(facts.recorded).toBe(1)
  expect((await bridge.leaf({ operation: "upload.observe", artifactID: "artifact", bytes: 1, sha256: publication.sha256 })).error).toBe("BROWSER_FILE_CHANGED")
  expect(Exit.isFailure(await Effect.runPromiseExit(bridge.complete({ tabs: [], files: [] })))).toBe(true)
  expect(facts.cleanup).toBe(0)
  await Effect.runPromise(bridge.complete({ tabs: [], files: [{ artifactID: "artifact", grantID: "grant", name: "actual.bin", direction: "upload", bytes: 1,
    sha256: publication.sha256, state: "selected", nativeVerified: true }] }))
  expect(facts.cleanup).toBe(1)
  await Effect.runPromise(bridge.unknown)
  expect(facts.unknown).toBe(1)
})
