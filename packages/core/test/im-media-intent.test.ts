import { expect, test } from "bun:test"
import { MediaIntent } from "../src/im/media-intent"

const scope = {
  server: "http://127.0.0.1:1234",
  directory: "/project",
  workspaceID: "/project",
  groupID: "group",
  memberID: "server",
}
const file = { name: "fixture.txt", mime: "application/octet-stream", sizeBytes: 7, checksum: "a".repeat(64) }
const receipt = () => ({
  id: "ima_one",
  workspaceID: scope.workspaceID,
  projectID: null,
  groupID: scope.groupID,
  messageID: null,
  uploadedBy: scope.memberID,
  filename: file.name,
  mime: file.mime,
  sizeBytes: file.sizeBytes,
  checksum: file.checksum,
  createdAt: 1000,
  expiresAt: 86_401_000,
  preview: false,
})

test("a lost upload receipt cannot be retried; a lost send keeps the exact attachment and request identity", () => {
  const prepared = MediaIntent.create(scope, file)
  const uploading = MediaIntent.change(prepared, "uploading")
  expect(MediaIntent.observedPhase(uploading)).toBe("upload_outcome_unknown")
  const unknown = MediaIntent.change(uploading, "upload_outcome_unknown")
  expect(() => MediaIntent.change(unknown, "uploading")).toThrow()
  const uploaded = MediaIntent.change(uploading, "uploaded_unbound", receipt())
  const sending = MediaIntent.change(uploaded, "sending")
  expect(MediaIntent.observedPhase(sending)).toBe("send_outcome_unknown")
  const retry = MediaIntent.change(MediaIntent.change(sending, "send_outcome_unknown"), "sending")
  expect(retry.requestID).toBe(prepared.requestID)
  expect(retry.attachment?.id).toBe("ima_one")
  const bound = MediaIntent.change(retry, "bound", { ...receipt(), messageID: "message" })
  expect(() => MediaIntent.change(bound, "sending")).toThrow()
  expect(bound.attachment?.expiresAt).toBe(86_401_000)
})

test("strict wire facts reject nullable drift, forged binding, changed expiry, stale store revision and extra secrets", () => {
  const prepared = MediaIntent.create(scope, file)
  const uploading = MediaIntent.change(prepared, "uploading")
  expect(MediaIntent.attachment(receipt()).messageID).toBeNull()
  for (const patch of [
    { groupID: "other" },
    { uploadedBy: "other" },
    { checksum: "b".repeat(64) },
    { sizeBytes: 8 },
    { expiresAt: 86_401_001 },
  ])
    expect(() => MediaIntent.change(uploading, "uploaded_unbound", { ...receipt(), ...patch })).toThrow()
  expect(() => MediaIntent.decode({ ...prepared, authorization: "secret" })).toThrow()
  expect(() => MediaIntent.create({ ...scope, server: "http://user:secret@localhost" }, file)).toThrow()
  expect(() => MediaIntent.upsert([prepared], uploading, 9)).toThrow()
  expect(() => MediaIntent.records(Array.from({ length: 33 }, () => MediaIntent.create(scope, file)))).toThrow()
})
