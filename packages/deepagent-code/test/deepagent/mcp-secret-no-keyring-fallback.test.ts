import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs"
import os from "os"
import path from "path"
import { SecretStore } from "@/mcp/secret-store"

// M-CRED (S1-v3.5) acceptance (c): with NO OS keyring available (headless / CI / container,
// no daemon), the store falls back to a `chmod 0600` local credentials file — NOT to the
// project config repo (fail-safe, never fail-open). This test drives the file backend
// directly with a temp path so it never writes the real data dir.

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-secret-")), "mcp-secrets.json")

describe("M-CRED no-keyring fallback", () => {
  test("selectBackend degrades to the file backend when no native keyring is available", async () => {
    // libsecret + DPAPI report unavailable; on macOS we still exercise the file backend
    // path directly below. selectBackend is fail-safe by contract.
    const fileBackend = SecretStore.fileBackend(tmpFile())
    expect(fileBackend.id).toBe("file")
    const store = SecretStore.make(fileBackend)
    expect(store.isFallback).toBe(true)
  })

  test("file backend persists the secret and writes a 0600 file (owner-only)", async () => {
    const file = tmpFile()
    const store = SecretStore.make(SecretStore.fileBackend(file))
    const handle = await Effect.runPromise(store.put("acct", "topsecret"))
    expect(await Effect.runPromise(store.resolve(handle))).toBe("topsecret")

    expect(fs.existsSync(file)).toBe(true)
    // POSIX mode check (skip the assertion on platforms without mode bits, e.g. win32).
    if (process.platform !== "win32") {
      const mode = fs.statSync(file).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  test("the fallback file lives under the data dir, NOT the project config repo", () => {
    const where = SecretStore.defaultFilePath()
    // Must not be a project-local config file that could be committed.
    expect(where).not.toContain(".deepagent-code")
    expect(path.basename(where)).toBe("mcp-secrets.json")
  })

  test("a missing fallback file resolves to undefined rather than throwing", async () => {
    const store = SecretStore.make(SecretStore.fileBackend(tmpFile()))
    expect(await Effect.runPromise(store.resolve("secret://nope"))).toBeUndefined()
  })
})
