import { Context, Effect, Layer, Option, Schema } from "effect"
import path from "path"
import nodeFs from "fs"
import { Process } from "@/util/process"
import { Global } from "@deepagent-code/core/global"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { ConfigMCPV1 } from "@deepagent-code/core/v1/config/mcp"
import { McpCatalog } from "./catalog"
import * as Log from "@deepagent-code/core/util/log"
import { buffer } from "node:stream/consumers"
import { dpapiCodec } from "#dpapi"
import type { Codec } from "./dpapi"
import { ConfigFileWrite } from "@/config/file-write"
import { SecretRefScope } from "./secret-ref-scope"
import { McpAuthStore } from "./auth-store"
import { McpWindowsStorage } from "./windows-storage"
import { WindowsPrivateStorage } from "@/installation/windows-private-storage"

const log = Log.create({ service: "mcp.secret" })

/**
 * M-CRED (S1-v3.5): MCP credential secure-storage indirection —承接 V3.4 M7 defer.
 *
 * THE PROBLEM (see catalog.ts header): until now `instantiate` spliced the raw secret
 * value (connection string / PAT) into `cfg.mcp` env/headers, so the persisted config
 * file WAS the secret. This module removes the plaintext value from config entirely:
 *
 *  - Step 1 (transition, low-cost, mirrors claude-code): config values may use
 *    `${VAR}` / `${VAR:-default}` env references that resolve from the process
 *    environment AT CONNECT TIME — the real value never lands in config or logs.
 *  - Step 2 (full indirection): values may be a `secret://<account>` HANDLE backed by
 *    an OS keychain (macOS Keychain / Linux libsecret / Windows DPAPI). The handle is
 *    resolved to the real value at connect time only.
 *
 * FAIL-SAFE: production Windows MCP requires original Native custody + DPAPI and
 * refuses unavailability. On other systems without an OS keyring, the store falls back to a `chmod 0600` local credentials file
 * under the data dir + an explicit warning — it NEVER silently writes secrets into the
 * project config repo.
 *
 * HONESTY about backends:
 *  - macOS Keychain: REAL, via the `security` subprocess.
 *  - Linux libsecret: REAL, via the `secret-tool` subprocess (G35-1).
 *  - Windows DPAPI: REAL, via the `#dpapi` codec — crypt32.dll through bun:ffi on the
 *    CLI, powershell.exe .NET ProtectedData on the node sidecar (W-b / W-01). Not yet
 *    verified on a physical Windows machine (no machine in the dev environment); that
 *    validation is on the W-d Windows acceptance list.
 */
export namespace SecretStore {
  // ════════════════════════════════════════════════════════════════════════════
  // ${VAR} env expansion (Step 1) — PURE, no I/O, no service needed.
  // ════════════════════════════════════════════════════════════════════════════

  // `${VAR}` or `${VAR:-default}`. VAR is a POSIX-ish identifier; default runs to `}`.
  const ENV_REF_G = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g
  const ENV_REF_TEST = /\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/
  /** Handle reference prefix for an OS-keychain-backed secret (Step 2). */
  export const HANDLE_PREFIX = "secret://"

  /** True if the string contains at least one `${VAR}` / `${VAR:-default}` reference. */
  export const containsEnvRef = (s: string): boolean => ENV_REF_TEST.test(s)
  /** True if the string is a keychain handle reference (`secret://<account>`). */
  export const isHandle = (s: string): boolean => s.startsWith(HANDLE_PREFIX)
  export const isScoped = (s: string): boolean => (isHandle(s) ? handleAccount(s) : s).startsWith(SecretRefScope.ACCOUNT_PREFIX)
  /** Build a handle reference for an account name. */
  export const makeHandle = (account: string): string => HANDLE_PREFIX + account
  /** Extract the account name from a handle reference. */
  export const handleAccount = (handle: string): string => handle.slice(HANDLE_PREFIX.length)
  /** True if the value is already an indirection (env ref or handle) — i.e. NOT raw plaintext. */
  export const isReference = (s: string): boolean => containsEnvRef(s) || isHandle(s)

  export interface ExpandResult {
    /** The fully-expanded string (missing vars without a default become ""). */
    value: string
    /** Names of `${VAR}` references that had no env value and no default (warned, not blocked). */
    missing: string[]
  }

  /**
   * Expand every `${VAR}` / `${VAR:-default}` in `input` using `env`. Semantics match
   * claude-code: an unset (or empty) var with a `:-default` uses the default; an unset
   * var WITHOUT a default expands to "" and is reported in `missing` (the caller WARNS
   * but does not block — a missing var must not crash the connection path).
   */
  export const expandEnvRefs = (input: string, env: NodeJS.ProcessEnv = process.env): ExpandResult => {
    const missing: string[] = []
    const value = input.replace(ENV_REF_G, (_m, name: string, def: string | undefined) => {
      const raw = env[name]
      if (raw !== undefined && raw !== "") return raw
      if (def !== undefined) return def
      missing.push(name)
      return ""
    })
    return { value, missing }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Keychain backends (Step 2) — INJECTABLE so tests never touch the real OS.
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * A pluggable secret backend. The store layer picks one via `selectBackend`, but tests
   * inject an in-memory / file backend so they never read or write the real OS keychain.
   */
  export interface Backend {
    readonly id: string
    /** True if this backend can be used in the current environment (no side effects). */
    readonly available: () => Promise<boolean>
    readonly put: (account: string, secret: string) => Promise<void>
    readonly get: (account: string) => Promise<string | undefined>
    /** A managed read may validate custody and decrypt together, retaining its intermediate permit fence. */
    readonly getScoped?: (account: string, beforeDecrypt: () => void) => Promise<string | undefined>
    readonly remove: (account: string) => Promise<void>
    /** Strict custody check for a new scoped reference; legacy APIs retain their platform semantics. */
    readonly validateScoped?: () => Promise<void>
  }

  /** In-memory backend — TEST ONLY. Never persists; isolated per instance. */
  export const inMemoryBackend = (id = "memory"): Backend => {
    const map = new Map<string, string>()
    return {
      id,
      available: async () => true,
      put: async (account, secret) => void map.set(account, secret),
      get: async (account) => map.get(account),
      remove: async (account) => void map.delete(account),
    }
  }

  export class FileError extends Schema.TaggedErrorClass<FileError>()("McpSecretFileError", {
    reason: Schema.Literals(["invalid", "io", "unknown", "legacy_unverified"]),
  }) {
    override get message() {
      return this.reason === "legacy_unverified" ? "Legacy MCP credentials require explicit re-entry before use"
        : `MCP secret file ${this.reason}`
    }
  }

  /**
   * Fail-safe FILE backend (the fallback when no OS keyring is available). Stores secrets
   * in a single `chmod 0600` JSON file UNDER THE DATA DIR — never inside the project config
   * repo — so a config-repo leak does not leak credentials. This is not as strong as an OS
   * keychain (the value is at rest on disk, only protected by file mode), hence it warns.
   */
  export const fileBackend = (filePath: string = defaultFilePath()): Backend => {
    const fs = nodeFs
    const readAll = (): Record<string, string> => {
      const bytes = (() => {
        try {
          return fs.readFileSync(filePath)
        } catch (error) {
          // A damaged or unreadable store must never become an empty replacement.
          if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
            return undefined
          throw new FileError({ reason: "io" })
        }
      })()
      if (bytes === undefined) return {}
      const text = (() => {
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        } catch {
          throw new FileError({ reason: "invalid" })
        }
      })()
      const parsed = Option.flatMap(
        Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text),
        Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.String)),
      )
      if (Option.isNone(parsed)) throw new FileError({ reason: "invalid" })
      return parsed.value
    }
    const write = (change: (data: Record<string, string>) => Record<string, string> | undefined) =>
      ConfigFileWrite.run(ConfigFileWrite.edit(filePath, (current) => {
        if (process.platform !== "win32" && current.stamp && (current.stamp.mode & 0o077) !== 0) throw new FileError({ reason: "io" })
        const data = readAll()
        const next = change(data)
        return { text: next === undefined ? undefined : JSON.stringify(next, null, 2), value: undefined }
      })).catch((error: unknown) => { throw error instanceof FileError ? error : new FileError({ reason: error instanceof ConfigFileWrite.Error && error.reason === "invalid" ? "invalid" : "io" }) })
    return {
      id: "file",
      available: async () => true,
      put: (account, secret) => write((data) => ({ ...data, [account]: secret })),
      get: async (account) => {
        const data = readAll()
        return Object.hasOwn(data, account) ? data[account] : undefined
      },
      remove: (account) => write((data) => {
        if (!Object.hasOwn(data, account)) return undefined
        return Object.fromEntries(Object.entries(data).filter(([key]) => key !== account))
      }),
      validateScoped: async () => { await McpAuthStore.read(filePath) },
    }
  }

  /** Default location for the fail-safe credentials file: the roaming config home, NOT the repo. */
  export const defaultFilePath = (): string => path.join(Global.Path.config, "mcp-secrets.json")

  const KEYCHAIN_SERVICE = "deepagent-code-mcp"

  /**
   * macOS Keychain backend — REAL, via the `security` subprocess (same mechanism
   * claude-code uses). NOTE: `security add-generic-password -w <secret>` passes the
   * secret on the command line, so it is briefly visible in this user's process table;
   * this is the documented macOS-CLI limitation, not a value that lands in config/logs.
   */
  export const macOsKeychainBackend = (
    service = KEYCHAIN_SERVICE,
    stdinOnly = false,
    credential?: { readonly home: string },
  ): Backend => {
    const command = credential ? "/usr/bin/security" : "security"
    const environment = credential ? { HOME: credential.home } : undefined
    return {
      id: "macos-keychain",
      available: async () => {
        if (process.platform !== "darwin") return false
        const res = await Process.run([command, "list-keychains"], {
          nothrow: true,
          ...(environment ? { env: environment } : {}),
          ...(stdinOnly ? { abort: AbortSignal.timeout(10000) } : {}),
        }).catch(() => undefined)
        return !!res && res.code === 0
      },
      put: async (account, secret) => {
        if (stdinOnly) {
          // security's interactive parser reads stdin, not a shell. Hex preserves arbitrary UTF-8
          // bytes and prevents newlines in a secret from becoming another command.
          if (/[\r\n\0]/.test(account + service)) throw new Error("Invalid Keychain account")
          const quote = (value: string) => '"' + value.replace(/[\\"]/g, (character) => "\\" + character) + '"'
          // Printable envelope avoids security -w's ambiguous hex output for binary/newline data.
          const encoded = encodeProtectedSecret(secret)
          const command = `add-generic-password -a ${quote(account)} -s ${quote(service)} -U -X ${Buffer.from(encoded).toString("hex")}\n`
          // Apple's parser has a 4096-byte line buffer; truncation must never store partial custody.
          if (Buffer.byteLength(command) >= 4096) throw new Error("Keychain secret exceeds the protected input limit")
          const proc = Process.spawn(["/usr/bin/security", "-i", "-q"], {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
            ...(environment ? { env: environment } : {}),
            abort: AbortSignal.timeout(10000),
          })
          if (!proc.stdin) throw new Error("Keychain protected input is unavailable")
          proc.stdin.end(command)
          if ((await proc.exited) !== 0) throw new Error("Keychain protected write failed")
          return
        }
        // -U updates an existing item instead of erroring on a duplicate.
        const res = await Process.run(
          [command, "add-generic-password", "-a", account, "-s", service, "-U", "-w", secret],
          {
            nothrow: true,
            ...(environment ? { env: environment } : {}),
            ...(stdinOnly ? { abort: AbortSignal.timeout(10000) } : {}),
          },
        )
        if (res.code !== 0) throw new Error(`security add-generic-password failed (code ${res.code})`)
      },
      get: async (account) => {
        const res = await Process.run([command, "find-generic-password", "-a", account, "-s", service, "-w"], {
          nothrow: true,
          ...(environment ? { env: environment } : {}),
          ...(stdinOnly ? { abort: AbortSignal.timeout(10000) } : {}),
        })
        if (res.code !== 0) {
          if (stdinOnly && res.code !== 44) throw new Error("Keychain protected read failed")
          return undefined
        }
        // `-w` prints just the password; strip the trailing newline.
        const value = res.stdout.toString().replace(/\n$/, "")
        if (!stdinOnly) return value
        return decodeProtectedSecret(value)
      },
      remove: async (account) => {
        const result = await Process.run([command, "delete-generic-password", "-a", account, "-s", service], {
          nothrow: true,
          ...(environment ? { env: environment } : {}),
          ...(stdinOnly ? { abort: AbortSignal.timeout(10000) } : {}),
        })
        if (stdinOnly && result.code !== 0 && result.code !== 44) throw new Error("Keychain protected removal failed")
      },
    }
  }

  /**
   * Linux libsecret (Secret Service) backend — via the `secret-tool` CLI (part of libsecret-tools).
   * Requires a running Secret Service daemon (GNOME Keyring, KWallet with the KSecretService module,
   * or a headless daemon like `gnome-keyring-daemon --daemonize --components=secrets`).
   *
   * G35-1 (v4.0.4): real implementation replacing the always-unavailable stub. The secret is passed
   * via stdin (not a CLI argument) so it does not appear in the process table — unlike the macOS
   * backend which has a documented process-table exposure from `security -w`.
   *
   * Validated on Ubuntu 22.04+ with gnome-keyring. Remote/headless verification: SSH into the
   * target machine (port 5070) and confirm `secret-tool --version` + daemon presence.
   */
  export const libsecretBackend = (service = KEYCHAIN_SERVICE, strict = false): Backend => ({
    id: "libsecret",
    available: async () => {
      if (process.platform !== "linux") return false
      // Check secret-tool is on PATH.
      const which = await Process.run(["which", "secret-tool"], { nothrow: true, ...(strict ? { abort: AbortSignal.timeout(10000) } : {}) }).catch(() => undefined)
      if (!which || which.code !== 0) return false
      // Probe the Secret Service daemon with a zero-cost attributes query (no I/O expected, only
      // checking the daemon responds). We cannot call `secret-tool --version` reliably across
      // distributions; instead try a `lookup` for an account that should not exist and treat
      // daemon-unavailable (exit 2) as false vs. daemon-present/not-found (exit 1) as true.
      const probe = await Process.run(
        ["secret-tool", "lookup", "service", service, "account", "__availability_probe__"],
        { nothrow: true, ...(strict ? { abort: AbortSignal.timeout(10000) } : {}) },
      ).catch(() => undefined)
      // exit 1 = no matching item (daemon is up, secret not found) → available
      // exit 2+ = daemon not running or other error → not available
      return !!probe && (probe.code === 0 || probe.code === 1 && (!strict || probe.stderr.length === 0))
    },
    put: async (account, secret) => {
      // secret-tool reads the secret from stdin so it never appears in the process table.
      const label = `${service}:${account}`
      const proc = Process.spawn(
        ["secret-tool", "store", "--label", label, "service", service, "account", account],
        { stdin: "pipe", stdout: "ignore", stderr: "pipe", ...(strict ? { abort: AbortSignal.timeout(10000) } : {}) },
      )
      if (!proc.stdin || !proc.stderr) throw new Error("secret-tool process pipes are unavailable")
      proc.stdin.end(strict ? encodeProtectedSecret(secret) : secret)
      const [code, stderr] = await Promise.all([proc.exited, buffer(proc.stderr)])
      if (code !== 0) {
        throw new Error(`secret-tool store failed (code ${code}): ${stderr.toString().trim()}`)
      }
    },
    get: async (account) => {
      const res = await Process.run(["secret-tool", "lookup", "service", service, "account", account], {
        nothrow: true, ...(strict ? { abort: AbortSignal.timeout(10000) } : {}),
      })
      if (res.code !== 0) {
        if (strict && (res.code !== 1 || res.stderr.length !== 0)) throw new Error("Secret Service protected read failed")
        return undefined
      }
      return strict ? decodeProtectedSecret(res.stdout.toString().replace(/\n$/, "")) : res.stdout.toString()
    },
    remove: async (account) => {
      const result = await Process.run(["secret-tool", "clear", "service", service, "account", account], {
        nothrow: true, ...(strict ? { abort: AbortSignal.timeout(10000) } : {}),
      }).catch((error: unknown) => { if (strict) throw error; return undefined })
      if (strict && result && result.code !== 0 && result.code !== 1) throw new Error("Secret Service protected removal failed")
    },
  })

  /**
   * Windows DPAPI backend (W-b / W-01) — REAL DPAPI at CurrentUser scope via the `#dpapi`
   * runtime-split codec: the CLI (bun) calls crypt32.dll's CryptProtectData/
   * CryptUnprotectData directly through bun:ffi; the desktop sidecar (node) uses
   * powershell.exe .NET ProtectedData, which invokes the same win32 functions, so blobs
   * interop across runtimes.
   *
   * DPAPI encrypts but does not store, so the backend persists each ciphertext as a base64
   * value in a chmod 0600 JSON envelope under the data dir — never plaintext, never inside
   * the project config repo. Only the OS key holder (the same user on the same machine) can
   * decrypt; a leaked envelope file alone yields nothing.
   *
   * The codec is injectable so tests exercise the store logic (envelope, accounts, failure
   * paths) without needing Windows; the real codec is platform-guarded and reports
   * unavailable off win32, degrading to the fail-safe file backend.
   */
  export const defaultDpapiFilePath = (): string => path.join(Global.Path.data, "mcp-secrets.dpapi.json")

  export const dpapiBackend = (filePath: string = defaultDpapiFilePath(), codec: Codec = dpapiCodec): Backend => {
    // Reuse the 0600 JSON envelope mechanics of the file backend; values stored here are
    // base64 DPAPI ciphertext, not plaintext.
    const envelopes = fileBackend(filePath)
    return {
      id: "dpapi",
      available: async () => process.platform === "win32" && (await codec.available()),
      put: async (account, secret) => {
        const ciphertext = await codec.protect(new TextEncoder().encode(secret))
        await envelopes.put(account, Buffer.from(ciphertext).toString("base64"))
      },
      get: async (account) => {
        const envelope = await envelopes.get(account)
        if (envelope === undefined) return undefined
        return new TextDecoder().decode(await codec.unprotect(Buffer.from(envelope, "base64")))
      },
      remove: (account) => envelopes.remove(account),
    }
  }

  /** MCP alone uses the original Root's fixed native envelope custody. The
   * IM device backend retains its separate, already established custody path. */
  export const windowsBackend = (native: McpWindowsStorage.Port | undefined, codec?: Codec): Backend => {
    // Node managed credentials require the original Native codec. The separate
    // legacy DPAPI backend retains its established PowerShell compatibility.
    const engine = codec ?? native?.codec ?? (process.versions.bun ? dpapiCodec : undefined)
    const decode = (text: string | undefined): Record<string, string> => {
      if (text === undefined) return {}
      if (Buffer.byteLength(text, "utf8") > McpAuthStore.MAX_BYTES) throw new FileError({ reason: "invalid" })
      const decoded = Option.flatMap(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text),
        Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.String)))
      if (Option.isNone(decoded) || Object.keys(decoded.value).length > 512 ||
        Object.entries(decoded.value).some(([key, value]) => !key || key.length > 4096 ||
          value.length > 131072 || Buffer.from(value, "base64").toString("base64") !== value))
        throw new FileError({ reason: "invalid" })
      return decoded.value
    }
    const custody = () => {
      if (!native) throw new FileError({ reason: "io" })
      return native
    }
    const mutation = async (change: (data: Record<string, string>) => Record<string, string> | undefined | Promise<Record<string, string> | undefined>) => {
      try {
        await custody().mutateSecrets(async (text) => {
          const next = await change(decode(text))
          return next === undefined ? undefined : JSON.stringify(next, null, 2)
        })
      } catch (error) {
        throw error instanceof FileError ? error : new FileError({
          reason: error instanceof WindowsPrivateStorage.Error && error.reason === "unknown" ? "unknown" : "io",
        })
      }
    }
    const secure = async <T>(operation: () => Promise<T>, scopedErrors = false) => {
      try { return await operation() }
      catch (error) {
        throw error instanceof FileError || (scopedErrors && error instanceof SecretRefScope.Error) ? error : new FileError({
          reason: error instanceof WindowsPrivateStorage.Error && error.reason === "unknown" ? "unknown" : "io",
        })
      }
    }
    const reads = { sequence: 0, nativeObserved: false }
    const get = (account: string, beforeDecrypt?: () => void) =>
      secure(async () => {
        const started = performance.now()
        const sequence = ++reads.sequence
        const timing = {
          stage: "read" as "read" | "before_current" | "legacy" | "unprotect" | "after_current" | "decode",
          since: started,
          success: false,
          phases: { read: 0, before_current: 0, legacy: 0, unprotect: 0, after_current: 0, decode: 0 },
        }
        const phase = (stage: typeof timing.stage) => {
          const now = performance.now()
          timing.phases[timing.stage] += now - timing.since
          timing.stage = stage
          timing.since = now
        }
        try {
          const original = custody()
          const data = decode((await original.read("mcp_secret_envelopes"))?.text)
          phase("before_current")
          await original.current()
          beforeDecrypt?.()
          if (!Object.hasOwn(data, account)) {
            phase("legacy")
            if (await original.legacySecrets()) throw new FileError({ reason: "legacy_unverified" })
            timing.success = true
            return undefined
          }
          phase("unprotect")
          if (!engine) throw new FileError({ reason: "io" })
          const bytes = await engine.unprotect(Buffer.from(data[account]!, "base64"))
          try {
            phase("after_current")
            await original.current()
            phase("decode")
            if (bytes.length > 65_536) throw new FileError({ reason: "invalid" })
            const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
            timing.success = true
            return value
          } finally {
            bytes.fill(0)
          }
        } finally {
          phase(timing.stage)
          const elapsedMs = Math.round(performance.now() - started)
          const firstNative = beforeDecrypt && engine?.id === "native-helper-crypt32-current-user" &&
            timing.success && timing.stage === "decode" && !reads.nativeObserved
          if (firstNative) reads.nativeObserved = true
          if (beforeDecrypt && (firstNative || !timing.success || elapsedMs >= 1000))
            log.warn("MCP managed credential timing", {
              sequence,
              engine: engine?.id === "native-helper-crypt32-current-user" ? "native" : "compat",
              stage: timing.stage,
              success: timing.success,
              elapsedMs,
              readMs: Math.round(timing.phases.read),
              beforeCurrentMs: Math.round(timing.phases.before_current),
              legacyMs: Math.round(timing.phases.legacy),
              unprotectMs: Math.round(timing.phases.unprotect),
              afterCurrentMs: Math.round(timing.phases.after_current),
              decodeMs: Math.round(timing.phases.decode),
            })
        }
      }, beforeDecrypt !== undefined)
    return {
      id: "dpapi",
      available: async () => !!native && process.platform === "win32" && !!engine && await engine.available(),
      validateScoped: () => secure(async () => {
        const original = custody()
        decode((await original.read("mcp_secret_envelopes"))?.text)
        await original.current()
      }),
      put: (account, secret) => secure(async () => {
        const original = custody()
        await original.current()
        const bytes = new TextEncoder().encode(secret)
        if (bytes.length > 65_536) { bytes.fill(0); throw new FileError({ reason: "invalid" }) }
        try {
          if (!engine) throw new FileError({ reason: "io" })
          const ciphertext = await engine.protect(bytes)
          await original.current()
          await mutation((data) => ({ ...data, [account]: Buffer.from(ciphertext).toString("base64") }))
        } finally { bytes.fill(0) }
      }),
      get,
      getScoped: get,
      remove: (account) => mutation(async (data) => {
        if (Object.hasOwn(data, account)) return Object.fromEntries(Object.entries(data).filter(([key]) => key !== account))
        if (await custody().legacySecrets()) throw new FileError({ reason: "legacy_unverified" })
        return undefined
      }),
    }
  }

  /**
   * Pick the best available backend for the current platform, fail-safe: try the native
   * OS keyring first, and on any unavailability fall back to the 0600 file backend with a
   * loud warning (never fail-open, never write into the project config repo).
   */
  export const selectBackend = async (windows?: McpWindowsStorage.Port): Promise<Backend> => {
    // A missing native port or DPAPI never enables plaintext Windows fallback.
    if (process.platform === "win32") return windowsBackend(windows)
    const native =
      process.platform === "darwin" ? macOsKeychainBackend() : libsecretBackend()
    try {
      if (await native.available()) return native
    } catch {
      /* fall through to file fallback */
    }
    log.warn("no OS keyring available; falling back to a chmod 0600 local credentials file", {
      attempted: native.id,
      file: defaultFilePath(),
    })
    return fileBackend()
  }

  function encodeProtectedSecret(secret: string) {
    return "dac-im-secret-v1:" + Buffer.from(secret).toString("base64")
  }

  function decodeProtectedSecret(value: string) {
    if (!value.startsWith("dac-im-secret-v1:")) throw new Error("Protected secret envelope is invalid")
    const payload = value.slice("dac-im-secret-v1:".length)
    const bytes = Buffer.from(payload, "base64")
    if (bytes.toString("base64") !== payload) throw new Error("Protected secret envelope is invalid")
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  }

  /** Device-bound IM custody cannot use MCP's compatibility plaintext fallback. */
  export const selectNativeBackend = async (service: string, dpapiFile: string): Promise<Backend> => {
    const native = process.platform === "darwin" ? macOsKeychainBackend(service, true)
      : process.platform === "win32" ? dpapiBackend(dpapiFile) : libsecretBackend(service, true)
    if (!await native.available()) throw new Error("im_device_store_unavailable")
    return native
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Service
  // ════════════════════════════════════════════════════════════════════════════

  export interface Interface {
    /** Store a secret under an account, returning the `secret://<account>` handle to embed. */
    readonly put: (account: string, secret: string) => Effect.Effect<string>
    /** Resolve a `secret://<account>` handle (or bare account) to its value, or undefined. */
    readonly resolve: (handle: string) => Effect.Effect<string | undefined>
    /** Remove a stored secret. */
    readonly remove: (account: string) => Effect.Effect<void>
    /** The id of the active backend (e.g. "macos-keychain" | "file"). */
    readonly backendId: string
    /** True when the active backend is the fail-safe file fallback (a degraded posture). */
    readonly isFallback: boolean
    readonly putScoped: (permit: SecretRefScope.Permit, value: string) => Effect.Effect<void, FileError | SecretRefScope.Error>
    readonly resolveScoped: (permit: SecretRefScope.Permit) => Effect.Effect<string | undefined, FileError | SecretRefScope.Error>
  }

  export class Service extends Context.Service<Service, Interface>()("@deepagent-code/McpSecretStore") {}

  /** Build the service from an injected backend (the single seam for tests + platform). */
  export const make = (backend: Backend): Interface => ({
    backendId: backend.id,
    isFallback: backend.id === "file",
    put: (account, secret) => isScoped(account) ? Effect.die(new SecretRefScope.Error({ reason: "unavailable" })) :
      Effect.tryPromise({
        try: () => backend.put(account, secret).then(() => makeHandle(account)),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(Effect.orDie),
    resolve: (handle) => isScoped(handle) ? Effect.die(new SecretRefScope.Error({ reason: "unavailable" })) :
      Effect.tryPromise({
        try: () => backend.get(isHandle(handle) ? handleAccount(handle) : handle),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(Effect.catch((error) => (error instanceof FileError ? Effect.die(error) : Effect.succeed(undefined)))),
    remove: (account) => isScoped(account) ? Effect.die(new SecretRefScope.Error({ reason: "unavailable" })) :
      Effect.tryPromise({
        try: () => backend.remove(isHandle(account) ? handleAccount(account) : account),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(Effect.catch((error) => (error instanceof FileError ? Effect.die(error) : Effect.void))),
    putScoped: (permit, value) => Effect.tryPromise({
      try: async () => { const account = SecretRefScope.account(permit); await backend.validateScoped?.(); SecretRefScope.account(permit); await backend.put(account, value); SecretRefScope.account(permit) },
      catch: (error) => error instanceof FileError || error instanceof SecretRefScope.Error ? error : new FileError({ reason: "io" }),
    }),
    resolveScoped: (permit) => Effect.tryPromise({
      try: async () => {
        const account = SecretRefScope.account(permit)
        if (backend.getScoped) {
          const value = await backend.getScoped(account, () => { SecretRefScope.account(permit) })
          SecretRefScope.account(permit)
          log.debug("MCP managed credential read", { backend: backend.id === "dpapi" ? "dpapi" : "other", found: value !== undefined })
          return value
        }
        await backend.validateScoped?.()
        SecretRefScope.account(permit)
        const value = await backend.get(account)
        SecretRefScope.account(permit)
        return value
      },
      catch: (error) => error instanceof FileError || error instanceof SecretRefScope.Error ? error : new FileError({ reason: "io" }),
    }),
  })

  /** Windows requires original Native custody; other platforms retain the existing keyring/file selection. */
  export const layer: Layer.Layer<Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const windows = yield* McpWindowsStorage.Current
      const backend = yield* Effect.promise(() => selectBackend(windows))
      return Service.of(make(backend))
    }),
  )

  export const defaultLayer = layer

  /** Test layer with an injectable backend (defaults to in-memory). */
  export const testLayer = (backend: Backend = inMemoryBackend()): Layer.Layer<Service> =>
    Layer.succeed(Service, make(backend))

  // ════════════════════════════════════════════════════════════════════════════
  // Connect-time resolution (used by mcp/index.ts) — values never written back.
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Resolve a single config value: expand `${VAR}` from env, resolve a `secret://` handle
   * via the store, or pass through a literal. Returns `undefined` when a handle cannot be
   * resolved (caller drops the key). Missing `${VAR}` references warn (by NAME only — never
   * the value) but still return the partially-expanded string (warn, don't block).
   */
  export const resolveValue = (
    value: string,
    store: Interface,
    env: NodeJS.ProcessEnv = process.env,
  ): Effect.Effect<string | undefined> =>
    Effect.gen(function* () {
      if (isHandle(value)) {
        const resolved = yield* store.resolve(value)
        if (resolved === undefined) {
          log.warn("could not resolve secret handle; dropping value", { handle: value })
          return undefined
        }
        return resolved
      }
      if (containsEnvRef(value)) {
        const { value: expanded, missing } = expandEnvRefs(value, env)
        if (missing.length > 0) {
          // Warn by VARIABLE NAME only — the resolved value never enters the log.
          log.warn("MCP credential env var(s) not set; connecting without them", { missing })
        }
        return expanded
      }
      return value
    })

  /**
   * Resolve every value in an env/headers record for the connection path. The result is a
   * fresh object — the original config (and the persisted file) keep their `${VAR}`/handle
   * references; only the live transport sees real values. Handle entries that fail to
   * resolve are dropped.
   */
  export const resolveRecord = (
    record: Record<string, string> | undefined,
    store: Interface,
    env: NodeJS.ProcessEnv = process.env,
  ): Effect.Effect<Record<string, string>> =>
    Effect.gen(function* () {
      const out: Record<string, string> = {}
      if (!record) return out
      for (const [key, value] of Object.entries(record)) {
        const resolved = yield* resolveValue(value, store, env)
        if (resolved !== undefined) out[key] = resolved
      }
      return out
    })

  // ════════════════════════════════════════════════════════════════════════════
  // Migration: existing plaintext secrets in cfg.mcp → keychain handles.
  // ════════════════════════════════════════════════════════════════════════════

  export interface MigrationMove {
    server: string
    field: "environment" | "headers"
    key: string
    handle: string
  }
  export interface MigrationFailure {
    server: string
    field: "environment" | "headers"
    key: string
    error: string
  }
  export interface MigrationOutcome {
    /** A NEW config map with migrated secrets replaced by handles (originals untouched). */
    config: Record<string, ConfigMCPV1.Info>
    moved: MigrationMove[]
    failures: MigrationFailure[]
    /** True if anything changed (caller should persist `config`). */
    changed: boolean
  }

  /** Header names whose VALUE is treated as secret-bearing by default (case-insensitive). */
  const DEFAULT_SECRET_HEADERS = new Set(["authorization", "x-api-key", "api-key"])

  /** All `secret:true` credential KEY names declared across the preset catalog. */
  export const catalogSecretEnvKeys = (): Set<string> => {
    const keys = new Set<string>()
    for (const entry of McpCatalog.list()) {
      for (const cred of entry.credentials) if (cred.secret) keys.add(cred.key)
    }
    return keys
  }

  const accountFor = (server: string, field: string, key: string) => `mcp:${server}:${field}:${key}`

  /**
   * One-shot startup migration: find PLAINTEXT secret values in `cfg.mcp` (env values whose
   * key is a known secret credential; secret-bearing header values) and move them into the
   * secret store, replacing each with a `secret://` handle, then return a new config to
   * persist. Existing `${VAR}` references and handles are left alone.
   *
   * TRANSACTIONAL / no credential loss: each secret is `put` AND read back to verify BEFORE
   * its plaintext is replaced. A failed put/verify leaves THAT plaintext intact (reported in
   * `failures`) while already-migrated secrets stay migrated — a partial failure never drops
   * a credential. The caller persists `config` only when `changed` is true.
   */
  export const migratePlaintextSecrets = (
    mcp: Record<string, ConfigMCPV1.Info>,
    store: Interface,
    opts?: { secretEnvKeys?: Set<string>; secretHeaders?: Set<string> },
  ): Effect.Effect<MigrationOutcome> =>
    Effect.gen(function* () {
      const secretEnvKeys = opts?.secretEnvKeys ?? catalogSecretEnvKeys()
      const secretHeaders = opts?.secretHeaders ?? DEFAULT_SECRET_HEADERS
      // Work on a deep copy so a mid-loop failure never corrupts the caller's object.
      const next: Record<string, ConfigMCPV1.Info> = structuredClone(mcp)
      const moved: MigrationMove[] = []
      const failures: MigrationFailure[] = []

      // Commit one secret transactionally: put → verify resolve → only then replace.
      const commit = (
        server: string,
        field: "environment" | "headers",
        key: string,
        plaintext: string,
        assign: (handle: string) => void,
      ) =>
        Effect.gen(function* () {
          const account = accountFor(server, field, key)
          const putExit = yield* Effect.exit(store.put(account, plaintext))
          if (putExit._tag === "Failure") {
            failures.push({ server, field, key, error: "put failed; plaintext preserved" })
            return
          }
          const handle = putExit.value
          // Verify the secret is actually retrievable before erasing the plaintext.
          const check = yield* store.resolve(handle)
          if (check !== plaintext) {
            failures.push({ server, field, key, error: "verify failed; plaintext preserved" })
            return
          }
          assign(handle)
          moved.push({ server, field, key, handle })
        })

      for (const [server, config] of Object.entries(next)) {
        if (config.type === "local" && config.environment) {
          const env = config.environment as Record<string, string>
          for (const [envKey, value] of Object.entries(env)) {
            if (isReference(value)) continue // already a ${VAR} / handle
            if (!secretEnvKeys.has(envKey)) continue // not a known secret env var
            yield* commit(server, "environment", envKey, value, (handle) => {
              env[envKey] = handle
            })
          }
        }
        if (config.type === "remote" && config.headers) {
          const headers = config.headers as Record<string, string>
          for (const [headerName, value] of Object.entries(headers)) {
            if (isReference(value)) continue
            if (!secretHeaders.has(headerName.toLowerCase())) continue
            yield* commit(server, "headers", headerName, value, (handle) => {
              headers[headerName] = handle
            })
          }
        }
      }

      return { config: next, moved, failures, changed: moved.length > 0 }
    })
}

export * as McpSecretStore from "./secret-store"
