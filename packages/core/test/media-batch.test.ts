import { expect, test } from "bun:test"
import { MediaBatch } from "../src/im/media-batch"
import { MediaIntent } from "../src/im/media-intent"

const scope = {
  server: "http://127.0.0.1:1234",
  directory: "/private",
  workspaceID: "workspace",
  groupID: "group",
  memberID: "viewer",
}
function item(index: number) {
  const createdAt = Date.now()
  return {
    intentID: `intent-${index}`,
    attachment: MediaIntent.attachment({
      id: `attachment-${index}`,
      workspaceID: scope.workspaceID,
      projectID: null,
      groupID: scope.groupID,
      messageID: null,
      uploadedBy: scope.memberID,
      filename: `file-${index}.txt`,
      mime: "application/octet-stream",
      sizeBytes: 1,
      checksum: "a".repeat(64),
      createdAt,
      expiresAt: createdAt + 86_400_000,
      preview: false,
    }),
  }
}

test("ordered batch capacity and receipts reject duplicates, foreign scope, wrong TTL and a fifth file", () => {
  const first = MediaBatch.create(scope, item(1), "batch")
  const four = MediaBatch.edit(first, { files: [item(1), item(2), item(3), item(4)] })
  expect(four.files.map((file) => file.attachment.id)).toEqual([
    "attachment-1",
    "attachment-2",
    "attachment-3",
    "attachment-4",
  ])
  expect(() => MediaBatch.edit(first, { files: [...four.files, item(5)] })).toThrow()
  expect(() => MediaBatch.edit(first, { files: [item(1), item(1)] })).toThrow()
  expect(() => MediaBatch.edit(first, { files: [{ ...item(2), intentID: item(1).intentID }, item(1)] })).toThrow()
  for (const patch of [
    { groupID: "other" },
    { uploadedBy: "other" },
    { workspaceID: "other" },
    { expiresAt: Date.now() },
  ])
    expect(() =>
      MediaBatch.create(scope, { ...item(1), attachment: { ...item(1).attachment, ...patch } }, "batch"),
    ).toThrow()
})

test("sending freezes exact body, ordered IDs and request; cold projection is unknown and does not mutate facts", () => {
  const draft = MediaBatch.edit(MediaBatch.create(scope, item(1), "batch"), {
    files: [item(1), item(2)],
    content: "  caption\n",
  })
  const sending = MediaBatch.change(draft, "sending")
  const before = JSON.stringify(sending)
  expect(MediaBatch.observedPhase(sending)).toBe("send_outcome_unknown")
  expect(JSON.stringify(sending)).toBe(before)
  expect(() => MediaBatch.edit(sending, { content: "new" })).toThrow()
  const unknown = MediaBatch.change(sending, "send_outcome_unknown")
  const retry = MediaBatch.change(unknown, "sending")
  expect(retry.requestID).toBe(draft.requestID)
  expect(retry.content).toBe(draft.content)
  expect(retry.files).toEqual(draft.files)
  for (const patch of [
    { content: "new" },
    { files: [...retry.files].reverse() },
    { requestID: "new" },
    { scope: { ...scope, directory: "/other" } },
  ])
    expect(() => MediaBatch.upsert([unknown], { ...retry, ...patch }, unknown.revision)).toThrow()
  expect(() => MediaBatch.change(retry, "bound")).toThrow()
  expect(MediaBatch.change(retry, "bound", "message").messageID).toBe("message")
})

test("receipt confirms the exact caption, ordered batch markers and message identity; legacy remains separate", () => {
  const draft = MediaBatch.edit(MediaBatch.create(scope, item(1), "batch"), { files: [item(1), item(2)], content: "" })
  const sending = MediaBatch.change(draft, "sending")
  const message = {
    id: "message",
    groupID: "group",
    senderID: "viewer",
    type: "file",
    content: "",
    metadata: sending.files.map((file) => ({ type: "attachment_ref", attachmentID: file.attachment.id, batch: true })),
  }
  expect(MediaBatch.matches(sending, message)).toBe(true)
  for (const patch of [
    { content: "filename" },
    { senderID: "other" },
    { groupID: "other" },
    { metadata: [...message.metadata].reverse() },
    { metadata: message.metadata.map(({ batch, ...value }) => value) },
  ])
    expect(MediaBatch.matches(sending, { ...message, ...patch })).toBe(false)
  const legacy = MediaBatch.change(
    MediaBatch.edit(MediaBatch.create(scope, item(1), "legacy"), { content: "file-1.txt" }),
    "sending",
  )
  expect(
    MediaBatch.matches(legacy, {
      ...message,
      content: "file-1.txt",
      metadata: { type: "attachment_ref", attachmentID: "attachment-1" },
    }),
  ).toBe(true)
  expect(MediaBatch.matches(legacy, { ...message, content: "file-1.txt", metadata: [message.metadata[0]] })).toBe(false)
})

test("CAS excludes stale edits, sharing a receipt across drafts and reopening a bound message", () => {
  const draft = MediaBatch.create(scope, item(1), "batch")
  const next = MediaBatch.edit(draft, { content: "one" })
  expect(MediaBatch.upsert([draft], next, draft.revision)).toEqual([next])
  expect(() => MediaBatch.upsert([next], MediaBatch.edit(draft, { content: "late" }), draft.revision)).toThrow()
  expect(() => MediaBatch.upsert([draft], MediaBatch.create(scope, item(1), "batch"))).toThrow()
  const bound = MediaBatch.change(MediaBatch.change(next, "sending"), "bound", "message")
  expect(() =>
    MediaBatch.upsert(
      [bound],
      { ...bound, revision: bound.revision + 1, phase: "draft", messageID: undefined },
      bound.revision,
    ),
  ).toThrow()
})
