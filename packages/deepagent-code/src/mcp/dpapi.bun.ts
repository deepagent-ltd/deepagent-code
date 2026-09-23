import { dlopen, FFIType, ptr, read, toBuffer, type Pointer } from "bun:ffi"
import type { Codec } from "./dpapi"

/**
 * Bun implementation of the DPAPI codec: direct bun:ffi calls into crypt32.dll — zero
 * dependencies, no subprocess. Selected under the `bun` import condition (CLI + tests).
 * See dpapi.ts for the runtime-split rationale.
 *
 * win32 x64 and arm64 both use a single native calling convention, so the C convention
 * bun:ffi compiles is compatible with the WinAPI stdcall exports of crypt32.
 */

// CRYPTPROTECT_UI_FORBIDDEN: never show a UI prompt (this runs inside services/agents).
const CRYPTPROTECT_UI_FORBIDDEN = 0x1

// DATA_BLOB layout on win32 x64/arm64: { u32 cbData; 4 bytes padding; u64 pbData } = 16 bytes.
const BLOB_SIZE = 16
const PB_DATA_OFFSET = 8

const openCrypt32 = () =>
  dlopen("crypt32.dll", {
    CryptProtectData: {
      // (DATA_BLOB* in, LPCWSTR descr, DATA_BLOB* entropy, PVOID reserved,
      //  PROMPTSTRUCT*, DWORD flags, DATA_BLOB* out) -> BOOL
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.bool,
    },
    CryptUnprotectData: {
      // (DATA_BLOB* in, LPWSTR* descr_out, DATA_BLOB* entropy, PVOID reserved,
      //  PROMPTSTRUCT*, DWORD flags, DATA_BLOB* out) -> BOOL
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.bool,
    },
  })

const openKernel32 = () =>
  dlopen("kernel32.dll", {
    // CryptProtectData/CryptUnprotectData allocate the output pbData with LocalAlloc;
    // the caller must release it with LocalFree.
    LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
  })

let crypt32: ReturnType<typeof openCrypt32> | undefined
let kernel32: ReturnType<typeof openKernel32> | undefined

// Marshal a JS buffer into a DATA_BLOB struct view; keep the data buffer alive in the
// caller's scope for the duration of the FFI call.
const blobOf = (data: Uint8Array) => {
  const view = new DataView(new ArrayBuffer(BLOB_SIZE))
  view.setUint32(0, data.length, true)
  view.setBigUint64(PB_DATA_OFFSET, BigInt(ptr(data)), true)
  return view
}

const emptyBlob = () => new DataView(new ArrayBuffer(BLOB_SIZE))

// Copy the output blob's bytes out, then LocalFree the native allocation.
const takeBlob = (view: DataView) => {
  const structPtr = ptr(view)
  const length = read.u32(structPtr, 0)
  // read.ptr types the address as a bare number; it is a real native pointer here.
  const dataPtr = read.ptr(structPtr, PB_DATA_OFFSET) as Pointer
  if (dataPtr === 0 || length === 0) return new Uint8Array(0)
  // toBuffer views the native memory; copy before LocalFree releases it.
  const bytes = new Uint8Array(toBuffer(dataPtr, 0, length))
  kernel32?.symbols.LocalFree(dataPtr)
  return bytes
}

const crypt32Lib = (action: string) => {
  if (process.platform !== "win32") throw new Error(`DPAPI ${action} is only available on win32`)
  crypt32 ??= openCrypt32()
  kernel32 ??= openKernel32()
  return crypt32
}

export const dpapiCodec: Codec = {
  id: "crypt32-ffi",
  available: async () => {
    if (process.platform !== "win32") return false
    try {
      crypt32Lib("availability check")
      return true
    } catch {
      return false
    }
  },
  protect: async (plaintext) => {
    const lib = crypt32Lib("protect")
    const output = emptyBlob()
    const ok = lib.symbols.CryptProtectData(
      ptr(blobOf(plaintext)),
      null,
      null,
      null,
      null,
      CRYPTPROTECT_UI_FORBIDDEN,
      ptr(output),
    )
    if (!ok) throw new Error("CryptProtectData failed")
    return takeBlob(output)
  },
  unprotect: async (ciphertext) => {
    const lib = crypt32Lib("unprotect")
    const output = emptyBlob()
    const ok = lib.symbols.CryptUnprotectData(
      ptr(blobOf(ciphertext)),
      null,
      null,
      null,
      null,
      CRYPTPROTECT_UI_FORBIDDEN,
      ptr(output),
    )
    if (!ok) throw new Error("CryptUnprotectData failed")
    return takeBlob(output)
  },
}
