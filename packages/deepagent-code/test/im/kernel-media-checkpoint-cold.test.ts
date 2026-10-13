import { expect, test } from "bun:test"
import { clientMessageID } from "@deepagent-code/core/im/repository"
import { MediaResumeFixture } from "./fixture/media-resume"

test("current protected origin survives real cold token rotation and hands its exact upload into real media custody", async () => {
  await using value = await MediaResumeFixture.make("checkpoint", "resume")
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
  ])
  expect(value.calls.filter((call) => call.path.endsWith("/upload-progress"))).toHaveLength(1)
  expect(new Set(value.uploadIDs).size).toBe(1)
  expect(value.metadata.expiresAt).toBe(expiry)
  expect(value.phase.publishes).toBe(0)
  expect(resumed.checkpoints).toEqual({records:1,bytes:92,rows:0})
}, 30000)

test("cold successor credential progress denial preserves charged original upload and sends no late chunk", async () => {
  await using value = await MediaResumeFixture.make("checkpoint", "denied")
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
}, 30000)



test("local origin rejection happens before Platform inspection, FD open or media Begin", async () => {
  await using value = await MediaResumeFixture.make("checkpoint", "no-origin")
  const rejected = await value.run("first")
  expect(rejected.outcome).toBe("Failure")
  expect(rejected.inspectionCalls).toBe(0)
  expect(rejected.fileOpens).toBe(0)
  expect(value.calls).toEqual([])
  expect(rejected.copies).toEqual({messages:0,receipts:0})
}, 30000)

test("local changed-request rejection happens before Platform inspection, FD open or media Begin", async () => {
  await using value = await MediaResumeFixture.make("checkpoint", "changed-request")
  expect((await value.run("first")).outcome).toBe("Failure")
  value.phase.value = 2
  const rejected = await value.run("resume")
  expect(rejected.outcome).toBe("Failure")
  expect(rejected.inspectionCalls).toBe(0)
  expect(rejected.fileOpens).toBe(0)
  expect(value.calls.filter((call)=>call.stage===2)).toEqual([])
  expect(rejected.copies).toEqual({messages:0,receipts:0})
  expect(value.puts).toEqual([{stage:1,index:0}])
}, 30000)
