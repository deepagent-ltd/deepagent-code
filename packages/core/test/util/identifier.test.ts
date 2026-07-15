import { describe, expect, test } from "bun:test"
import { Identifier } from "@deepagent-code/core/util/identifier"

// The sortable time component lives in the first 12 hex chars of the id (6 bytes). Callers only ever
// sort ids lexically, so comparing this prefix is exactly the `(created_at, id)` tiebreak the bus uses.
const timePrefix = (id: string) => id.slice(0, 12)

describe("Identifier same-millisecond ordering", () => {
  test("same-ms ids are strictly increasing and stably sortable", () => {
    const at = 1_700_000_000_000
    const ids = Array.from({ length: 64 }, () => Identifier.create(false, at))

    // Emission order == ascending lexical order of the time prefix, with no duplicates.
    const prefixes = ids.map(timePrefix)
    const sorted = [...prefixes].sort()
    expect(prefixes).toEqual(sorted)
    for (let i = 1; i < prefixes.length; i++) {
      expect(prefixes[i] > prefixes[i - 1]).toBe(true)
    }
    expect(new Set(prefixes).size).toBe(prefixes.length)
  })

  test("an interleaved call on another clock cannot collide same-ms ids (counter-reset hazard)", () => {
    const at = 1_700_000_000_000

    const a = Identifier.create(false, at)
    // Another subsystem generates an id on a DIFFERENT clock/timestamp between our two calls. Under the
    // old per-timestamp counter this reset the shared counter to 0, so `c` below would re-use the same
    // low bits as `a` and tie in the causal sort. The non-resetting sequence must prevent that.
    Identifier.create(false, at + 5)
    Identifier.create(false, at - 10)
    Identifier.create(false, 0)
    const c = Identifier.create(false, at)

    expect(timePrefix(c) > timePrefix(a)).toBe(true)
    expect(timePrefix(c)).not.toBe(timePrefix(a))
  })

  test("ordering stays monotonic across a long interleaved burst", () => {
    const at = 1_700_000_000_050
    const emitted: string[] = []
    for (let i = 0; i < 200; i++) {
      // Alternate same-ms bus events with foreign-clock ids to force the reset path repeatedly.
      emitted.push(Identifier.create(false, at))
      Identifier.create(false, at + (i % 7))
    }
    const prefixes = emitted.map(timePrefix)
    for (let i = 1; i < prefixes.length; i++) {
      expect(prefixes[i] > prefixes[i - 1]).toBe(true)
    }
  })

  test("descending ids invert order for the same-ms sequence", () => {
    const at = 1_700_000_000_100
    const d1 = Identifier.descending()
    const d2 = Identifier.descending()
    // Later descending id sorts BEFORE the earlier one (newest-first), and they never tie.
    expect(timePrefix(d2) < timePrefix(d1)).toBe(true)
    void at
  })
})
