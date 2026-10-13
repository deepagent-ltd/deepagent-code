import { expect, test } from "bun:test"
import { clientMessageID } from "@deepagent-code/core/im/repository"
import { MediaResumeFixture } from "./fixture/media-resume"

test("actual fixed engine cold explicit same-ID retry only sends missing chunks after a lost chunk ACK", async () => {
  await using value = await MediaResumeFixture.make("caller", "resume")
  const first = await value.run("first")
  expect(first.outcome).toBe("Failure")
  expect(first.copies).toEqual({ messages: 0, receipts: 0 })
  expect(value.puts).toEqual([{ stage: 1, index: 0 }])
  const expiry = value.metadata.expiresAt
  value.phase.value = 2
  const resumed = await value.run("resume")
  expect(resumed.pid).not.toBe(first.pid)
  expect(resumed.outcome).toBe("Success")
  expect(resumed.hasTransferCapabilities).toBe(true)
  expect(resumed.hasUploadProgress).toBe(true)
  expect(resumed.localCreatedAt).toBe(first.localCreatedAt)
  expect(resumed.messageID).toBe(clientMessageID("server", "original-cold-resume"))
  expect(resumed.copies).toEqual({ messages: 1, receipts: 1 })
  expect(value.puts).toEqual([
    { stage: 1, index: 0 },
    { stage: 2, index: 1 },
    { stage: 2, index: 2 },
  ])
  expect(value.calls.filter((call) => call.path.endsWith("/upload-progress"))).toHaveLength(1)
  expect(new Set(value.uploadIDs).size).toBe(1)
  expect(value.metadata.expiresAt).toBe(expiry)
  expect(value.phase.publishes).toBe(0)
}, 20000)

test("actual fixed engine progress denial does not fall back to chunk dispatch or finalize", async () => {
  await using value = await MediaResumeFixture.make("caller", "denied")
  expect((await value.run("first")).outcome).toBe("Failure")
  const expiry = value.metadata.expiresAt
  value.phase.value = 2
  const resumed = await value.run("resume")
  expect(resumed.outcome).toBe("Failure")
  expect(resumed.copies).toEqual({ messages: 0, receipts: 0 })
  expect(value.puts).toEqual([{ stage: 1, index: 0 }])
  expect(value.calls.filter((call) => call.path.endsWith("/upload-progress"))).toHaveLength(1)
  expect(value.calls.some((call) => call.path.endsWith("/finalize"))).toBe(false)
  expect(value.metadata.receivedChunks).toBe(1)
  expect(new Set(value.uploadIDs).size).toBe(1)
  expect(value.metadata.expiresAt).toBe(expiry)
  expect(value.phase.publishes).toBe(0)
}, 20000)

test("actual fixed engine falls back only for missing transfer capability, preserving the original object", async () => {
  await using value = await MediaResumeFixture.make("caller", "legacy")
  expect((await value.run("first")).outcome).toBe("Failure")
  const expiry = value.metadata.expiresAt
  value.phase.value = 2
  const resumed = await value.run("resume")
  expect(resumed.outcome).toBe("Success")
  expect(resumed.copies).toEqual({ messages: 1, receipts: 1 })
  expect(value.puts).toEqual([
    { stage: 1, index: 0 },
    { stage: 2, index: 0 },
    { stage: 2, index: 1 },
    { stage: 2, index: 2 },
  ])
  expect(value.calls.filter((call) => call.path.endsWith("/transfer/capabilities"))).toHaveLength(1)
  expect(value.calls.filter((call) => call.path.endsWith("/upload-progress"))).toHaveLength(0)
  expect(new Set(value.uploadIDs).size).toBe(1)
  expect(value.metadata.expiresAt).toBe(expiry)
  expect(value.phase.publishes).toBe(0)
}, 20000)

test("actual fixed engine missing progress is not the missing-capability fallback", async () => {
  await using value = await MediaResumeFixture.make("caller", "missing-progress")
  expect((await value.run("first")).outcome).toBe("Failure")
  const expiry = value.metadata.expiresAt
  value.phase.value = 2
  const resumed = await value.run("resume")
  expect(resumed.outcome).toBe("Failure")
  expect(resumed.copies).toEqual({ messages: 0, receipts: 0 })
  expect(value.puts).toEqual([{ stage: 1, index: 0 }])
  expect(value.calls.filter((call) => call.path.endsWith("/upload-progress"))).toHaveLength(1)
  expect(value.calls.some((call) => call.path.endsWith("/finalize"))).toBe(false)
  expect(value.metadata.receivedChunks).toBe(1)
  expect(new Set(value.uploadIDs).size).toBe(1)
  expect(value.metadata.expiresAt).toBe(expiry)
  expect(value.phase.publishes).toBe(0)
}, 20000)
