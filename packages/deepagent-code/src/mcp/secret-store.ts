import { Context, Effect, Layer } from "effect"
import path from "path"
import nodeFs from "fs"
import { Process } from "@/util/process"
import { Global } from "@deepagent-code/core/global"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { ConfigMCPV1 } from "@deepagent-code/core/v1/config/mcp"
import { McpCatalog } from "./catalog"
import * as Log from "@deepagent-code/core/util/log"

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
 * FAIL-SAFE (never fail-open): when no OS keyring is available (headless / CI /
 * container, no daemon) the store falls back to a `chmod 0600` local credentials file
 * under the data dir + an explicit warning — it NEVER silently writes secrets into the
 * project config repo.
 *
 * HONESTY about backends (matches what claude-code itself ships — even upstream leaves
 * Linux libsecret a TODO and falls back to a 0600 file):
 *  - macOS Keychain: REAL, via the `security` subprocess.
 *  - Linux libsecret / Windows DPAPI: NOT yet implemented natively — they report
 *    `available: false` so selection degrades to the REAL 0600 file fallback. No fake
 *    backend is presented as real.
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
    readonly remove: (account: string) => Promise<void>
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

  /**
   * Fail-safe FILE backend (the fallback when no OS keyring is available). Stores secrets
   * in a single `chmod 0600` JSON file UNDER THE DATA DIR — never inside the project config
   * repo — so a config-repo leak does not leak credentials. This is not as strong as an OS
   * keychain (the value is at rest on disk, only protected by file mode), hence it warns.
   */
  export const fileBackend = (filePath: string = defaultFilePath()): Backend => {
    const fs = nodeFs
    const readAll = (): Record<string, string> => {
      try {
        const text = fs.readFileSync(filePath, "utf8")
        const parsed = JSON.parse(text)
        return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {}
      } catch {
        return {}
      }
    }
    const writeAll = (data: Record<string, string>) => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      // Write then chmod 0600 (owner read/write only).
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 })
      try {
        fs.chmodSync(filePath, 0o600)
      } catch {
        /* best-effort on platforms without POSIX modes */
      }
    }
    return {
      id: "file",
      available: async () => true,
      put: async (account, secret) => {
        const data = readAll()
        data[account] = secret
        writeAll(data)
      },
      get: async (account) => readAll()[account],
      remove: async (account) => {
        const data = readAll()
        delete data[account]
        writeAll(data)
      },
    }
  }

  /** Default location for the fail-safe credentials file: under the data dir, NOT the repo. */
  export const defaultFilePath = (): string => path.join(Global.Path.data, "mcp-secrets.json")

  const KEYCHAIN_SERVICE = "deepagent-code-mcp"

  /**
   * macOS Keychain backend — REAL, via the `security` subprocess (same mechanism
   * claude-code uses). NOTE: `security add-generic-password -w <secret>` passes the
   * secret on the command line, so it is briefly visible in this user's process table;
   * this is the documented macOS-CLI limitation, not a value that lands in config/logs.
   */
  export const macOsKeychainBackend = (): Backend => ({
    id: "macos-keychain",
    available: async () => {
      if (process.platform !== "darwin") return false
      const res = await Process.run(["security", "list-keychains"], { nothrow: true }).catch(() => undefined)
      return !!res && res.code === 0
    },
    put: async (account, secret) => {
      // -U updates an existing item instead of erroring on a duplicate.
      const res = await Process.run(
        ["security", "add-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE, "-U", "-w", secret],
        { nothrow: true },
      )
      if (res.code !== 0) throw new Error(`security add-generic-password failed (code ${res.code})`)
    },
    get: async (account) => {
      const res = await Process.run(
        ["security", "find-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE, "-w"],
        { nothrow: true },
      )
      if (res.code !== 0) return undefined
      // `-w` prints just the password; strip the trailing newline.
      return res.stdout.toString().replace(/\n$/, "")
    },
    remove: async (account) => {
      await Process.run(["security", "delete-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE], {
        nothrow: true,
      })
    },
  })

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
  export const libsecretBackend = (): Backend => ({
    id: "libsecret",
    available: async () => {
      if (process.platform !== "linux") return false
      // Check secret-tool is on PATH.
      const which = await Process.run(["which", "secret-tool"], { nothrow: true }).catch(() => undefined)
      if (!which || which.code !== 0) return false
      // Probe the Secret Service daemon with a zero-cost attributes query (no I/O expected, only
      // checking the daemon responds). We cannot call `secret-tool --version` reliably across
      // distributions; instead try a `lookup` for an account that should not exist and treat
      // daemon-unavailable (exit 2) as false vs. daemon-present/not-found (exit 1) as true.
      const probe = await Process.run(
        ["secret-tool", "lookup", "service", KEYCHAIN_SERVICE, "account", "__availability_probe__"],
        { nothrow: true },
      ).catch(() => undefined)
      // exit 1 = no matching item (daemon is up, secret not found) → available
      // exit 2+ = daemon not running or other error → not available
      return !!probe && (probe.code === 0 || probe.code === 1)
    },
    put: async (account, secret) => {
      // secret-tool reads the secret from stdin so it never appears in the process table.
      const label = `${KEYCHAIN_SERVICE}:${account}`
      const proc = Bun.spawn(
        ["secret-tool", "store", "--label", label, "service", KEYCHAIN_SERVICE, "account", account],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      )
      proc.stdin.write(secret)
      proc.stdin.end()
      const code = await proc.exited
      if (code !== 0) {
        const err = await new Response(proc.stderr).text()
        throw new Error(`secret-tool store failed (code ${code}): ${err.trim()}`)
      }
    },
    get: async (account) => {
      const res = await Process.run(
        ["secret-tool", "lookup", "service", KEYCHAIN_SERVICE, "account", account],
        { nothrow: true },
      )
      if (res.code !== 0) return undefined
      return res.stdout.toString()
    },
    remove: async (account) => {
      await Process.run(
        ["secret-tool", "clear", "service", KEYCHAIN_SERVICE, "account", account],
        { nothrow: true },
      ).catch(() => {})
    },
  })

  /**
   * Windows Credential Manager backend — via PowerShell's Windows.Security.Credentials.PasswordVault
   * (WinRT, available on Windows 8.1+ / Windows Server 2012 R2+).
   *
   * G35-1 (v4.0.4): real implementation replacing the always-unavailable stub. Uses the PasswordVault
   * API, which is backed by DPAPI under the hood — credentials are encrypted with the user's key and
   * stored in the OS credential store (visible in Windows Credential Manager → Windows Credentials).
   *
   * Note: not yet verified on Windows (no test machine in current environment). The implementation
   * follows Microsoft's documented PasswordVault PowerShell pattern. Verified path deferred to
   * v4.0.6 once a Windows CI/test machine is available.
   */
  export const dpapiBackend = (): Backend => ({
    id: "dpapi",
    available: async () => {
      if (process.platform !== "win32") return false
      // Probe PowerShell + PasswordVault availability with a minimal no-op script.
      const res = await Process.run(
        [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null; Write-Output ok",
        ],
        { nothrow: true },
      ).catch(() => undefined)
      return !!res && res.code === 0 && res.stdout.toString().includes("ok")
    },
    put: async (account, secret) => {
      const label = `${KEYCHAIN_SERVICE}:${account}`
      const script = `
        [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null
        $vault = New-Object Windows.Security.Credentials.PasswordVault
        # Remove existing entry before adding to avoid duplicates.
        try { $vault.Remove($vault.Retrieve('${label}', '${account}')) } catch {}
        $cred = New-Object Windows.Security.Credentials.PasswordCredential('${label}', '${account}', '${secret.replace(/'/g, "''")}')
        $vault.Add($cred)
        Write-Output ok
      `.trim()
      const res = await Process.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        { nothrow: true },
      )
      if (res.code !== 0 || !res.stdout.toString().includes("ok")) {
        throw new Error(`Windows Credential Manager put failed (code ${res.code})`)
      }
    },
    get: async (account) => {
      const label = `${KEYCHAIN_SERVICE}:${account}`
      const script = `
        [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null
        $vault = New-Object Windows.Security.Credentials.PasswordVault
        try {
          $cred = $vault.Retrieve('${label}', '${account}')
          $cred.RetrievePassword()
          Write-Output $cred.Password
        } catch { exit 1 }
      `.trim()
      const res = await Process.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        { nothrow: true },
      ).catch(() => undefined)
      if (!res || res.code !== 0) return undefined
      const value = res.stdout.toString().replace(/\r?\n$/, "")
      return value || undefined
    },
    remove: async (account) => {
      const label = `${KEYCHAIN_SERVICE}:${account}`
      const script = `
        [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null
        $vault = New-Object Windows.Security.Credentials.PasswordVault
        try { $vault.Remove($vault.Retrieve('${label}', '${account}')) } catch {}
      `.trim()
      await Process.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        { nothrow: true },
      ).catch(() => {})
    },
  })

  /**
   * Pick the best available backend for the current platform, fail-safe: try the native
   * OS keyring first, and on any unavailability fall back to the 0600 file backend with a
   * loud warning (never fail-open, never write into the project config repo).
   */
  export const selectBackend = async (): Promise<Backend> => {
    const native =
      process.platform === "darwin"
        ? macOsKeychainBackend()
        : process.platform === "win32"
          ? dpapiBackend()
          : libsecretBackend()
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
  }

  export class Service extends Context.Service<Service, Interface>()("@deepagent-code/McpSecretStore") {}

  /** Build the service from an injected backend (the single seam for tests + platform). */
  export const make = (backend: Backend): Interface => ({
    backendId: backend.id,
    isFallback: backend.id === "file",
    put: (account, secret) =>
      Effect.tryPromise({
        try: () => backend.put(account, secret).then(() => makeHandle(account)),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(Effect.orDie),
    resolve: (handle) =>
      Effect.tryPromise({
        try: () => backend.get(isHandle(handle) ? handleAccount(handle) : handle),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(Effect.catch(() => Effect.succeed(undefined))),
    remove: (account) =>
      Effect.tryPromise({
        try: () => backend.remove(isHandle(account) ? handleAccount(account) : account),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(Effect.catch(() => Effect.void)),
  })

  /** Default layer: select a real backend at build time (fail-safe to the 0600 file). */
  export const layer: Layer.Layer<Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const backend = yield* Effect.promise(() => selectBackend())
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
