import { describe, expect, test } from "bun:test"
import { terminalInputWriter } from "./terminal-input-writer"

describe("terminalInputWriter", () => {
  test("buffers restored terminal input until the connection opens", () => {
    const calls: string[] = []
    let connected = false
    const writer = terminalInputWriter((data) => calls.push(data), () => connected, true)

    writer.push("queued")
    expect(calls).toEqual([])

    connected = true
    writer.flush()
    writer.push("h")
    writer.push("\u007f")

    expect(calls).toEqual(["queued", "h", "\u007f"])

    connected = false
    writer.push("reconnecting")
    connected = true
    writer.flush()

    expect(calls).toEqual(["queued", "h", "\u007f", "reconnecting"])
  })

  test("drops disconnected input when buffering is disabled", () => {
    const calls: string[] = []
    const writer = terminalInputWriter((data) => calls.push(data), () => false)

    writer.push("h")
    writer.flush()

    expect(calls).toEqual([])
  })
})
