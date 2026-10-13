import { expect, test } from "bun:test"
import { displayMessages, messageBoundary } from "./message-display"
import { findMessageIndex } from "./message-order"

test("canonical display orders a promoted queued turn after the preceding final without changing identities or legacy time", () => {
  const messages = [
    { id: "hashed-first-input", role: "user", time: { created: 100 }, canonicalSeq: 3 },
    { id: "hashed-queued-input", role: "user", time: { created: 110 }, canonicalSeq: 101 },
    { id: "first-final", role: "assistant", time: { created: 120 }, canonicalSeq: 85 },
    { id: "second-final", role: "assistant", time: { created: 130 }, canonicalSeq: 104 },
  ]
  const snapshot = structuredClone(messages)
  expect(displayMessages(messages).map((message) => message.id)).toEqual([
    "hashed-first-input",
    "first-final",
    "hashed-queued-input",
    "second-final",
  ])
  expect(messages).toEqual(snapshot)
  expect(findMessageIndex(messages, "hashed-queued-input")).toBe(1)
  expect(
    displayMessages([
      { id: "legacy-last", time: { created: 30 } },
      { id: "legacy-first", time: { created: 10 } },
    ]).map((message) => message.id),
  ).toEqual(["legacy-first", "legacy-last"])
  expect(
    displayMessages([
      { id: "known-later", time: { created: 10 }, canonicalSeq: 200 },
      { id: "legacy", time: { created: 20 } },
      { id: "known-earlier", time: { created: 30 }, canonicalSeq: 100 },
    ]).map((message) => message.id),
  ).toEqual(["known-earlier", "legacy", "known-later"])
})

test("canonical boundaries select visible, rolled, undo and redo positions while rejecting a missing target", () => {
  const turns = [
    { id: "msg_z-first", time: { created: 10 }, canonicalSeq: 3 },
    { id: "msg_a-queued", time: { created: 20 }, canonicalSeq: 201 },
    { id: "msg_m-steered", time: { created: 30 }, canonicalSeq: 101 },
  ]
  const boundary = messageBoundary(turns, "msg_m-steered")!
  expect(boundary.visible.map((item) => item.id)).toEqual(["msg_z-first"])
  expect(boundary.rolled.map((item) => item.id)).toEqual(["msg_m-steered", "msg_a-queued"])
  expect(boundary.previous?.id).toBe("msg_z-first")
  expect(boundary.next?.id).toBe("msg_a-queued")
  expect(messageBoundary(turns, "unloaded-target")).toBeUndefined()
  expect(turns.map((item) => item.id)).toEqual(["msg_z-first", "msg_a-queued", "msg_m-steered"])
})
