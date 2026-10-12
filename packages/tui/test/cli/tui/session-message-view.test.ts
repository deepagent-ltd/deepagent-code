import { expect, test } from "bun:test"
import type { Message } from "@deepagent-code/sdk"
import {
  sessionMessageView,
  pendingAssistantIndex,
  sessionMessageBoundary,
} from "../../../src/util/session-message-view"

test("Session view follows canonical promotion order without changing the ID-indexed source", () => {
  const indexed = [
    { id: "msg_000_assistant", canonicalSeq: 27, time: { created: 200 } },
    { id: "msg_001_final", canonicalSeq: 85, time: { created: 400 } },
    { id: "msg_111_p2_hash", canonicalSeq: 101, time: { created: 150 } },
    { id: "msg_zzz_p1_hash", canonicalSeq: 2, time: { created: 100 } },
  ]
  expect(sessionMessageView(indexed).map((message) => message.id)).toEqual([
    "msg_zzz_p1_hash",
    "msg_000_assistant",
    "msg_001_final",
    "msg_111_p2_hash",
  ])
  expect(indexed.map((message) => message.id)).toEqual([
    "msg_000_assistant",
    "msg_001_final",
    "msg_111_p2_hash",
    "msg_zzz_p1_hash",
  ])
  expect(sessionMessageView(indexed).at(-1)?.canonicalSeq).toBe(101)
  expect(
    sessionMessageView([
      { id: "legacy_b", time: { created: 2 } },
      { id: "legacy_a", time: { created: 1 } },
    ]).map((message) => message.id),
  ).toEqual(["legacy_a", "legacy_b"])
})

test("pending and queued positions follow the visible sequence rather than hashed IDs", () => {
  const messages = [
    { role: "user", id: "msg_zzz_user", time: { created: 1 } },
    { role: "assistant", id: "msg_aaa_streaming", time: { created: 2 } },
    { role: "user", id: "msg_000_followup", time: { created: 1 } },
  ] as Message[]
  expect(pendingAssistantIndex(messages)).toBe(1)
  expect(messages.map((_, index) => index > pendingAssistantIndex(messages)!)).toEqual([false, false, true])
  expect(
    pendingAssistantIndex([
      ...messages,
      { role: "assistant", id: "msg_001_final", time: { created: 4, completed: 5 } },
    ] as Message[]),
  ).toBeUndefined()
  expect(pendingAssistantIndex([])).toBeUndefined()
})

test("undo redo copy and hidden-message boundaries use canonical positions, including missing history", () => {
  const messages = sessionMessageView([
    { id: "msg_000_p2", canonicalSeq: 101, time: { created: 150 } },
    { id: "msg_001_final", canonicalSeq: 85, time: { created: 400 } },
    { id: "msg_zzz_p1", canonicalSeq: 2, time: { created: 100 } },
  ])
  const boundary = sessionMessageBoundary(messages, "msg_000_p2")
  expect(messages.filter((message) => boundary.before(message.id)).map((message) => message.id)).toEqual([
    "msg_zzz_p1",
    "msg_001_final",
  ])
  expect(messages.filter((message) => boundary.atOrAfter(message.id)).map((message) => message.id)).toEqual([
    "msg_000_p2",
  ])
  expect(sessionMessageBoundary(messages, "msg_zzz_p1").after("msg_000_p2")).toBe(true)
  expect(sessionMessageBoundary(messages, "missing-history").before("msg_zzz_p1")).toBe(false)
  expect(sessionMessageBoundary(messages, "missing-history").atOrAfter("msg_000_p2")).toBe(false)
  expect(sessionMessageBoundary(messages).before("msg_000_p2")).toBe(true)
  expect(boundary.after("unknown-message")).toBe(false)
})
