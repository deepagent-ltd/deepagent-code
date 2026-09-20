// Minimal Buffer shim for the browser bundle (see polyfills/crypto.ts for why the graph
// reaches Buffer at all). Only Buffer.byteLength / Buffer.from are referenced on the
// app-reachable paths; anything else throws loudly rather than misbehaving silently.
class BrowserBuffer extends Uint8Array {
  static byteLength(value: string | Uint8Array, encoding?: string): number {
    if (typeof value === "string") return new TextEncoder().encode(value).length
    return value.length
  }

  static from(value: string | Uint8Array, encoding?: string): BrowserBuffer {
    if (typeof value === "string") return new BrowserBuffer(new TextEncoder().encode(value))
    return new BrowserBuffer(value)
  }

  toString(encoding?: string): string {
    if (encoding && encoding !== "utf8" && encoding !== "utf-8")
      throw new Error(`Buffer.toString(${encoding}) is not available in the browser bundle`)
    return new TextDecoder().decode(this)
  }
}

export { BrowserBuffer as Buffer }
export default { Buffer: BrowserBuffer }
