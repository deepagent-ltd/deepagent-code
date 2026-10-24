import { expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { SharedBrowserTuiSchema } from "../src/browser/shared-tui-schema"

const connect = { attachID: "attach", generation: "generation", secret: "a".repeat(64) }
const reserve = {
  ...connect,
  expectedBarrierOrder: 3,
  inputID: "message",
  originalSubmissionID: "submission",
  rawInput: "继续处理",
}

test("TUI public input shapes cannot smuggle a native issuer, stream binding or source kind", () => {
  const decode = Schema.decodeUnknownOption(SharedBrowserTuiSchema.Reserve, { onExcessProperty: "error" })
  expect(Option.isSome(decode(reserve))).toBe(true)
  for (const extra of [
    { sourceKind: "gui_composer" },
    { hostIncarnation: "invented" },
    { streamID: "invented" },
    { submissionOrder: 99 },
  ])
    expect(Option.isNone(decode({ ...reserve, ...extra }))).toBe(true)
  expect(Option.isNone(decode({ ...reserve, secret: "small" }))).toBe(true)
  expect(Option.isNone(decode({ ...reserve, expectedBarrierOrder: -1 }))).toBe(true)
  expect(
    Option.isNone(
      decode({ ...reserve, rawInput: "中".repeat(Math.floor(SharedBrowserTuiSchema.MAX_INPUT_BYTES / 3) + 1) }),
    ),
  ).toBe(true)
  expect(Option.isSome(decode({ ...reserve, rawInput: "a".repeat(SharedBrowserTuiSchema.MAX_INPUT_BYTES) }))).toBe(true)
})
