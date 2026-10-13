import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Option, Schema } from "effect"

const source = process.env.DAC_NATIVE_READ_RECOVERY_SOURCE

;(source ? test : test.skip)("real Native read admission remains recovery-required over HTTP and both SSE routes", async () => {
  const root = await fs.realpath(await fs.mkdtemp("/private/tmp/dac-read-recovery-http-"))
  const paths = ["database.sqlite", "database.sqlite-wal", "database.sqlite-shm", "private-env.json",
    "project/guard.test.ts", "project/deepagent-code.json"]
  const original = async () => Promise.all(paths.map(async (name) => ({ name,
    sha256: createHash("sha256").update(new Uint8Array(await Bun.file(path.join(source!, name)).arrayBuffer())).digest("hex"),
  })))
  const before = await original()
  expect((await fs.stat(path.join(source!, "database.sqlite-wal"))).size).toBe(0)
  // The stopped original has an empty WAL. SQLite only opens this private byte copy;
  // immutable mode avoids creating source-side WAL/SHM files during consistent backup.
  const stage = path.join(root, "stage.sqlite")
  await fs.writeFile(stage, new Uint8Array(await Bun.file(path.join(source!, "database.sqlite")).arrayBuffer()), { mode: 0o600 })
  const backup = Bun.spawnSync(["/usr/bin/sqlite3", `file:${stage}?immutable=1`, `.backup '${path.join(root, "authority.sqlite")}'`])
  expect({ code: backup.exitCode, error: backup.stderr.toString() }).toEqual({ code: 0, error: "" })
  expect(await original()).toEqual(before)
  const protectedTables = ["session", "session_input", "session_message", "session_activity", "session_activity_input",
    "session_context_selection", "session_provider_attempt", "session_provider_owner_lease", "session_v2_provider_turn_receipt",
    "session_v2_tool_effect_admission", "session_v2_tool_effect", "work_execution", "work_dispatch_reservation",
    "work_count_acquisition", "work_known_recovery", "work_known_recovery_resume", "event_validation_investigation_receipt"]
  const readProtected = () => protectedTables.map((table) => {
    const query = Bun.spawnSync(["/usr/bin/sqlite3", `file:${path.join(root, "authority.sqlite")}?immutable=1`, "-json", `SELECT * FROM "${table}"`])
    expect(query.exitCode).toBe(0)
    const rows: Record<string, unknown>[] = JSON.parse(query.stdout.toString() || "[]")
    return { table, hashes: rows.map((row) => createHash("sha256").update(CanonicalJson.stringify(row)).digest("hex")).sort() }
  })
  const protectedSnapshot = readProtected()
  const beforeHeader = new Uint8Array(await Bun.file(path.join(root, "authority.sqlite")).arrayBuffer()).slice(18, 20)
  // Snapshot publication format only: a standalone WAL-header file cannot be opened
  // by Core's cold readonly preflight without sidecars. No business row is changed.
  const format = Bun.spawnSync(["/usr/bin/sqlite3", path.join(root, "authority.sqlite"), "PRAGMA journal_mode=DELETE"])
  expect({ code: format.exitCode, journal: format.stdout.toString().trim() }).toEqual({ code: 0, journal: "delete" })
  expect(readProtected()).toEqual(protectedSnapshot)
  await fs.writeFile(path.join(root, "backup-format.json"), JSON.stringify({ beforeHeader: [...beforeHeader],
    afterHeader: [...new Uint8Array(await Bun.file(path.join(root, "authority.sqlite")).arrayBuffer()).slice(18, 20)],
    protectedRowDrift: 0, evidenceClass: "private backup publication format correction only" }), { mode: 0o600 })
  await fs.writeFile(path.join(root, "protected-before.json"), JSON.stringify(protectedSnapshot), { mode: 0o600 })
  await Promise.all(["home", "tmp", "config", "data", "cache", "state", "managed"].map((name) => fs.mkdir(path.join(root, name))))
  await fs.mkdir(path.join(root, "data/local-operator"), { mode: 0o700 })
  await fs.copyFile(path.join(source!, "data/local-operator/installation.json"), path.join(root, "data/local-operator/installation.json"))
  const decoded = Schema.decodeUnknownOption(Schema.Struct({ DEEPAGENT_CODE_MODELS_PATH: Schema.String,
    DEEPAGENT_CODE_SERVER_USERNAME: Schema.String, DEEPAGENT_CODE_SERVER_PASSWORD: Schema.String }))(
    await Bun.file(path.join(source!, "private-env.json")).json(),
  )
  if (Option.isNone(decoded)) throw new Error("Original private fixture environment is unavailable")
  const env = decoded.value
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture/httpapi-read-recovery-actual.ts"), root], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"),
      XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
      DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"), DEEPAGENT_CODE_HOME: path.join(root, "data"),
      DEEPAGENT_CODE_DB: path.join(root, "authority.sqlite"), DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1", DEEPAGENT_CODE_MODELS_PATH: env.DEEPAGENT_CODE_MODELS_PATH,
      DEEPAGENT_CODE_SERVER_USERNAME: env.DEEPAGENT_CODE_SERVER_USERNAME,
      DEEPAGENT_CODE_SERVER_PASSWORD: env.DEEPAGENT_CODE_SERVER_PASSWORD,
      DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "", DEEPAGENT_CODE_V2_OWNER_CAMPAIGN: "", DEEPAGENT_CODE_V2_OWNER_PUBLIC_KEY: "",
      DEEPAGENT_IM_AGENT_RESPONDER: "off", NO_COLOR: "1",
    }, stdout: "pipe", stderr: "pipe",
  })
  const deadline = setTimeout(() => child.kill("SIGKILL"), 110_000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    await fs.writeFile(path.join(root, "child.log"), stdout + stderr, { mode: 0o600 })
    expect({ code, output: code === 0 ? "ok" : stdout + stderr }).toEqual({ code: 0, output: "ok" })
    const result = await Bun.file(path.join(root, "result.json")).json()
    expect(result).toMatchObject({ closed: true, statusGet: "recovery_required", sse: ["recovery_required", "recovery_required"],
      originalToolStatus: "running", readAdmissions: 1, toolTerminals: 0, protectedDrift: 0,
      providerAttempts: 1, newProviderAttempts: 0, countAcquisitions: 1, newCountAcquisitions: 0,
      protectedTables: 16, administrativeOwner: { newOwners: 1, originalOwnersUnchanged: true },
      evidenceClass: "actual production HTTP over original signed Native read history; terminal notification probe only" })
    expect(result.administrativeOwner.releasedAt).toBeNumber()
    expect(await original()).toEqual(before)
    console.info("NATIVE_READ_RECOVERY_HTTP_EVIDENCE", root)
  } finally {
    clearTimeout(deadline)
    child.kill()
    expect(await original()).toEqual(before)
  }
}, 120_000)
