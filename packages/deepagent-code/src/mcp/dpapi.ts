/**
 * Windows DPAPI codec — shared interface (W-b / W-01 mcp/secret-store Windows backend).
 *
 * DPAPI (CryptProtectData / CryptUnprotectData at CurrentUser scope) encrypts bytes with a
 * key the OS derives for the logged-in user; the ciphertext is only decryptable by that user
 * on that machine. DPAPI encrypts but never stores, so the secret store keeps the returned
 * ciphertext in its own envelope file (see `dpapiBackend` in secret-store.ts).
 *
 * The codec is runtime-split through the `#dpapi` package.json imports condition, following
 * the `#wiki-fts-db` / `#db` pattern:
 *  - `dpapi.bun.ts` — the CLI (bun, compiled binary) calls crypt32.dll directly via bun:ffi.
 *  - `dpapi.node.ts` — the desktop sidecar (node) shells out to powershell.exe .NET
 *    ProtectedData, which invokes the same win32 CryptProtectData under the hood.
 *
 * Both engines produce interchangeable blobs, so a secret stored by the CLI is readable by
 * the sidecar and vice versa. Consumers import `dpapiCodec` from "#dpapi" — never a `bun:`
 * or `node:` specifier directly (the node bundle must stay free of bun:ffi).
 */
export interface Codec {
  /** Identifies the engine (e.g. "crypt32-ffi" | "powershell-protecteddata") for diagnostics. */
  readonly id: string
  /** True when DPAPI is callable in this runtime (win32 + engine reachable); no side effects. */
  readonly available: () => Promise<boolean>
  /** Encrypt bytes with the current user's DPAPI key. Throws on failure. */
  readonly protect: (plaintext: Uint8Array) => Promise<Uint8Array>
  /** Decrypt DPAPI ciphertext for the current user. Throws on failure. */
  readonly unprotect: (ciphertext: Uint8Array) => Promise<Uint8Array>
}
