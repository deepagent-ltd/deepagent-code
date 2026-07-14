import { randomBytes } from "crypto"

export namespace Identifier {
  const LENGTH = 26

  // State for monotonic ID generation.
  //
  // `lastValue` is a single, module-private, strictly-increasing per-process sequence. It is NEVER
  // reset — not on a timestamp change, and not by any other subsystem (nothing outside this module
  // can reach it). This is what makes the same-millisecond ordering tiebreak robust: every ID domain
  // (`dae_`, `evt_`, `ses_`, …) funnels through `create`, and different callers legitimately use
  // different clocks (e.g. the event bus injects its own `now`, while most callers use `Date.now()`).
  // An earlier per-timestamp counter reset to 0 whenever the incoming timestamp differed from the
  // previous call's, so an interleaved call from another subsystem on a different clock could reset
  // the counter mid-stream and hand two same-millisecond events the SAME low bits — breaking the
  // `(created_at, id)` causal sort. Encoding a non-resetting sequence removes that hazard entirely:
  // same-ms ids are strictly increasing by construction regardless of interleaving.
  let lastValue = 0n

  export function ascending() {
    return create(false)
  }

  export function descending() {
    return create(true)
  }

  function randomBase62(length: number): string {
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    let result = ""
    const bytes = randomBytes(length)
    for (let i = 0; i < length; i++) {
      result += chars[bytes[i] % 62]
    }
    return result
  }

  export function create(descending: boolean, timestamp?: number): string {
    const currentTimestamp = timestamp ?? Date.now()

    // The ordering key is monotonic-by-construction. Each timestamp is given a block of 0x1000 low
    // slots (`ts << 12`); we advance into that block, but if the resulting value would not be strictly
    // greater than the last one emitted (a same-ms call, or an interleaved call on an earlier/other
    // clock), we simply take `lastValue + 1`. Result: `now` is strictly increasing for the whole
    // process, so same-millisecond ids always sort in emission order and no external reset can collide
    // two ids — even if a burst overflows a single ms block it just borrows from the next block's range
    // while staying monotonic.
    let now = BigInt(currentTimestamp) * BigInt(0x1000)
    if (now <= lastValue) now = lastValue + 1n
    lastValue = now

    now = descending ? ~now : now

    const timeBytes = Buffer.alloc(6)
    for (let i = 0; i < 6; i++) {
      timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff))
    }

    return timeBytes.toString("hex") + randomBase62(LENGTH - 12)
  }
}
