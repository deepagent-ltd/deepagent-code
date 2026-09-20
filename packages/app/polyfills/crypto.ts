// Browser shims for the node builtins that reach the app bundle ONLY through the
// core/session/legacy-wire graph (snapshot-fallback converter). The runtime paths the app
// exercises never call these — they back schema ID factories (randomBytes) and Buffer
// helpers inside modules that execute server-side in production. Aliased here so rollup
// can parse the graph; behavior beyond the unused surface is intentionally minimal.
const randomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length)
  globalThis.crypto.getRandomValues(bytes)
  return bytes
}

const createHash = () => {
  throw new Error("createHash is not available in the browser bundle")
}

export { randomBytes, createHash }
export default { randomBytes, createHash }
