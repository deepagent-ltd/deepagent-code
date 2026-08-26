import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@deepagent-code/sdk/v2/client"
import {
  compareMessages,
  compareParts,
  findMessageIndex,
  locateMessage,
  locatePart,
  messageOrderKey,
  messageTime,
  partOrderKey,
  partTime,
} from "./message-order"

// Regression fixture from provider lifecycle: the 26th wrap of the 6-byte ID time field happened on
// 2026-08-14, so the chronologically NEWER message carries a lexicographically SMALLER ID.
const WRAP_OLD_ID = "msg_ffa88f0840015Xj7vIrcdNEJJB" // 2026-08-13 17:51:46, before the wrap
const WRAP_NEW_ID = "msg_00d62a3c4001KqYw3o8wBBH6qm" // 2026-08-17 09:42:43, after the wrap
const WRAP_OLD_TIME = 1786614706000
const WRAP_NEW_TIME = 1786930963000

const userMessage = (id: string, created: number) =>
  ({
    id,
    sessionID: "ses_1",
    role: "user",
    time: { created },
    agent: "assistant",
    model: { providerID: "openai", modelID: "gpt" },
  }) as Message

const textPart = (id: string, start?: number) =>
  ({
    id,
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "text",
    text: id,
    ...(start === undefined ? {} : { time: { start } }),
  }) as Part

describe("message order (provider lifecycle root cause B)", () => {
  test("orders messages by time.created first, then by ID", () => {
    const older = userMessage(WRAP_OLD_ID, WRAP_OLD_TIME)
    const newer = userMessage(WRAP_NEW_ID, WRAP_NEW_TIME)
    expect(WRAP_NEW_ID < WRAP_OLD_ID).toBe(true) // sanity: raw ID order is reversed
    expect(compareMessages(newer, older)).toBeGreaterThan(0)
    expect(compareMessages(older, newer)).toBeLessThan(0)
    expect(messageOrderKey(older) < messageOrderKey(newer)).toBe(true)
    expect([newer, older].sort((a, b) => compareMessages(a, b)).map((m) => m.id)).toEqual([
      WRAP_OLD_ID,
      WRAP_NEW_ID,
    ])
  })

  test("falls back to ID order when time.created is equal or missing", () => {
    const a = userMessage("msg_a", 5)
    const b = userMessage("msg_b", 5)
    expect(compareMessages(a, b)).toBeLessThan(0)
    expect(messageTime({ id: "msg_x" })).toBe(0)
    expect(compareMessages({ id: "msg_x" }, a)).toBeLessThan(0) // missing time sorts earliest
  })

  test("locates a wrapped newer message at the tail, never at the head", () => {
    const sorted = [userMessage(WRAP_OLD_ID, WRAP_OLD_TIME)]
    const insert = locateMessage(sorted, userMessage(WRAP_NEW_ID, WRAP_NEW_TIME))
    expect(insert).toEqual({ found: false, index: 1 })
    const existing = locateMessage(sorted, userMessage(WRAP_OLD_ID, WRAP_OLD_TIME))
    expect(existing).toEqual({ found: true, index: 0 })
    expect(findMessageIndex(sorted, WRAP_OLD_ID)).toBe(0)
  })

  test("locateMessage finds an item by identity even when its time differs", () => {
    const sorted = [userMessage(WRAP_OLD_ID, WRAP_OLD_TIME)]
    const drifted = locateMessage(sorted, { id: WRAP_OLD_ID, time: { created: 1 } })
    expect(drifted).toEqual({ found: true, index: 0 })
  })
})

describe("part order (provider lifecycle root cause B)", () => {
  test("orders parts by time.start first, then by ID", () => {
    const older = textPart("prt_ffa88f084001aaaa", WRAP_OLD_TIME)
    const newer = textPart("prt_00d62a3c4001bbbb", WRAP_NEW_TIME)
    expect(newer.id < older.id).toBe(true) // sanity: raw ID order is reversed
    expect(compareParts(newer, older)).toBeGreaterThan(0)
    expect(partOrderKey(older) < partOrderKey(newer)).toBe(true)
    expect([newer, older].sort((a, b) => compareParts(a, b)).map((p) => p.id)).toEqual([older.id, newer.id])
  })

  test("parts without time.start fall back to 0 and locate by identity", () => {
    const timeless = textPart("prt_tool")
    expect(partTime(timeless)).toBe(0)
    const timed = textPart("prt_aaaa", WRAP_OLD_TIME)
    expect(compareParts(timeless, timed)).toBeLessThan(0)
    const located = locatePart([timeless], { ...timed, id: "prt_tool" })
    expect(located.found).toBe(true)
  })
})
