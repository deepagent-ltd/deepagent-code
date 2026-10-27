import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { managedBrowserInputFixtureDefine } from "./fixture/managed-browser-input-build"
import { managedBrowserInputFixtureEnvironment, managedBrowserInputFixtureExecutable } from "./fixture/managed-browser-input-runtime"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { Hash } from "@deepagent-code/core/util/hash"

test.skipIf(process.platform !== "darwin")("original canonical Session runner admits approved browser program with independent once permissions and real Main effects", async () => {
  const replay = process.env.DAC_BROWSER_PROGRAM_CANONICAL_REPLAY
  const root = await fs.realpath(replay ?? (await fs.mkdtemp(path.join(os.tmpdir(), "dac-browser-program-canonical-"))))
  if (replay && !root.startsWith("/private/tmp/dac-browser-program-canonical-"))
    throw new Error("Replay is limited to the private artifact from this fixture")
  if (!replay) {
    await fs.chmod(root, 0o700)
    await Promise.all(
      ["home", "tmp", "project", "config", "data", "cache", "state"].map((name) =>
        fs.mkdir(path.join(root, name), { mode: 0o700 }),
      ),
    )
    await fs.symlink(path.resolve(import.meta.dir, "../../node_modules"), path.join(root, "node_modules"), "dir")
    const bin = path.join(root, "home/.deepagent/code/cache/bin")
    await fs.mkdir(bin, { recursive: true })
    const rg = Bun.which("rg")
    expect(rg).not.toBeNull()
    await fs.copyFile(rg!, path.join(bin, "rg"))
    const main = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "fixture/managed-browser-program-canonical.ts")],
      outdir: root,
      target: "node",
      external: ["electron"],
      naming: "main.mjs",
      define: await managedBrowserInputFixtureDefine(root),
      sourcemap: "external",
    })
    const child = await Bun.build({
      entrypoints: [
        path.join(import.meta.dir, "../../../deepagent-code/test/browser/fixture/native-program-canonical-child.ts"),
      ],
      outdir: root,
      target: "node",
      external: ["electron", "jsonc-parser", "@lydell/node-pty", "bun"],
      naming: "child.mjs",
      define: { DEEPAGENT_CODE_VERSION: '"0.0.0-browser-program-canonical-dev"', DEEPAGENT_CODE_CHANNEL: '"dev"' },
      files: { "deepagent-code-web-ui.gen.ts": "" },
      sourcemap: "external",
    })
    expect(main.logs).toEqual([])
    expect(child.logs).toEqual([])
    expect(main.success && child.success).toBe(true)
    const repository = path.resolve(import.meta.dir, "../../../..")
    const sources = new Map<string, string>()
    const maps = Schema.Struct({
      sources: Schema.Array(Schema.String),
      sourcesContent: Schema.Array(Schema.NullOr(Schema.String)),
    })
    for (const build of [main, child]) {
      const map = build.outputs.find((value) => value.path.endsWith(".map"))!
      const parsed = Schema.decodeUnknownSync(maps)(await Bun.file(map.path).json())
      parsed.sources.forEach((value, index) => {
        const absolute = path.resolve(path.dirname(map.path), value)
        const contents = parsed.sourcesContent[index]
        if (!absolute.startsWith(path.join(repository, "packages") + path.sep) || absolute.includes(path.sep + "node_modules" + path.sep) || contents == null)
          return
        sources.set(absolute, Hash.sha256(contents))
      })
    }
    const snapshot = await Promise.all(
      Array.from(sources, async ([filename, hash]) => ({
        path: path.relative(repository, filename),
        sha256: hash,
        current: Hash.sha256(await fs.readFile(filename)),
      })),
    )
    const drift = snapshot.filter((value) => value.sha256 !== value.current)
    expect(drift).toEqual([])
    await fs.writeFile(
      path.join(root, "source-cohort.json"),
      JSON.stringify(
        { evidence: "actual compiled sourcemap sourcesContent", checked: snapshot.length, drift, sources: snapshot },
        null,
        2,
      ),
    )
    console.log("CANONICAL_SOURCE_CAPTURED", root)
    const process = Bun.spawn(
      [
        managedBrowserInputFixtureExecutable,
        main.outputs.find((value) => value.path.endsWith("main.mjs"))!.path,
      ],
      {
        env: {
          ...managedBrowserInputFixtureEnvironment,
          PATH: globalThis.process.env.PATH,
          HOME: root,
          TMPDIR: root,
          XDG_DATA_HOME: root,
          XDG_CONFIG_HOME: root,
          XDG_CACHE_HOME: root,
          DAC_BROWSER_TEST_ROOT: root,
          DAC_BROWSER_CHILD: child.outputs.find((value) => value.path.endsWith("child.mjs"))!.path,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const timeout = setTimeout(() => process.kill(), 80_000)
    const [code, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ])
    clearTimeout(timeout)
    await fs.writeFile(path.join(root, "process.log"), stdout + "\n" + stderr)
    expect({ code, diagnostic: code ? stdout + stderr : null }).toEqual({ code: 0, diagnostic: null })
    const finalDrift = (
      await Promise.all(
        snapshot.map(async (value) => ({
          path: value.path,
          before: value.sha256,
          after: Hash.sha256(await fs.readFile(path.join(repository, value.path))),
        })),
      )
    ).filter((value) => value.before !== value.after)
    await fs.writeFile(
      path.join(root, "source-successor.json"),
      JSON.stringify({ checked: snapshot.length, drift: finalDrift }, null, 2),
    )
  }
  console.log("BROWSER_PROGRAM_CANONICAL_EVIDENCE", root)
  const result = await Bun.file(path.join(root, "child-result.json")).json()
  expect({ stage: result.stage, error: result.error }).toEqual({ stage: "complete", error: undefined })
  const facts = Schema.decodeUnknownSync(
    Schema.Struct({
      actions: Schema.Array(BrowserSchema.Action),
      admissions: Schema.Array(
        Schema.Struct({
          admission_id: Schema.String,
          receipt_id: Schema.String,
          provider_attempt_id: Schema.String,
          owner_token: Schema.String,
          session_id: Schema.String,
          tool_call_id: Schema.String,
          tool_name: Schema.String,
        }),
      ),
      effects: Schema.Array(
        Schema.Struct({
          receipt_id: Schema.String,
          tool_call_id: Schema.String,
          state: Schema.String,
          effect_kind: Schema.String,
        }),
      ),
      providers: Schema.Array(
        Schema.Struct({
          attempt_id: Schema.String,
          session_id: Schema.String,
          selection_id: Schema.String,
          state: Schema.String,
          execution_claim_token: Schema.Int,
          owner_token: Schema.String,
        }),
      ),
      receipts: Schema.Array(
        Schema.Struct({
          receipt_id: Schema.String,
          session_id: Schema.String,
          provider_attempt_id: Schema.String,
          owner_token: Schema.String,
          state: Schema.String,
        }),
      ),
      selections: Schema.Array(
        Schema.Struct({
          selection_id: Schema.String,
          session_id: Schema.String,
          security_namespace_id: Schema.String,
          location_key: Schema.String,
          project_scope_key: Schema.String,
        }),
      ),
      owners: Schema.Array(Schema.Struct({ owner_token: Schema.String, released_at: Schema.NullOr(Schema.Number) })),
      inputs: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          session_id: Schema.String,
          delivery: Schema.String,
          promoted_seq: Schema.Number,
        }),
      ),
      work: Schema.Array(Schema.Unknown),
      counts: Schema.Array(Schema.Unknown),
      saved: Schema.Array(Schema.Unknown),
    }),
  )(result.facts)
  const permissions = Schema.decodeUnknownSync(Schema.Array(PermissionV2.Request))(result.permissions)
  expect(permissions.map((value) => value.action)).toEqual([
    "browser",
    "browser",
    "browser",
    "browser",
    "browser-program",
  ])
  expect(
    result.beforeProgram.map((value: { action: string; programActions: number }) => [
      value.action,
      value.programActions,
    ]),
  ).toEqual([
    ["browser", 0],
    ["browser-program", 0],
  ])
  expect(facts.saved).toEqual([])
  expect(facts.inputs).toHaveLength(1)
  expect(facts.inputs[0]!.id).toBe("msg_program_canonical_input")
  expect(facts.work).toEqual([])
  expect(facts.counts).toEqual([])
  expect(facts.admissions).toHaveLength(7)
  expect(facts.admissions.filter((value) => value.tool_name === "browser")).toHaveLength(6)
  expect(facts.admissions.filter((value) => value.tool_name === "plan")).toHaveLength(1)
  expect(facts.effects).toHaveLength(7)
  expect(facts.actions).toHaveLength(4)
  const programs = facts.actions.filter((value) => value.command.type === "program")
  expect(programs).toHaveLength(1)
  const action = programs[0]!
  expect(action.outcome).toBe("completed")
  expect(action.result?.program).toMatchObject({
    version: 1,
    totalSteps: 3,
    completedSteps: 3,
    steps: [
      { ordinal: 0, operation: "fill" },
      { ordinal: 1, operation: "select" },
      { ordinal: 2, operation: "click" },
    ],
  })
  expect(action.result?.program?.planHash).toMatch(/^[a-f0-9]{64}$/)
  const admission = facts.admissions.find((value) => value.admission_id === action.admissionID)!
  expect(admission).toMatchObject({
    receipt_id: action.providerReceiptID,
    provider_attempt_id: action.providerAttemptID,
    session_id: action.sessionID,
    tool_call_id: action.toolCallID,
  })
  const receipt = facts.receipts.find((value) => value.receipt_id === action.providerReceiptID)!
  const provider = facts.providers.find((value) => value.attempt_id === action.providerAttemptID)!
  expect(receipt).toMatchObject({
    state: "settled",
    owner_token: admission.owner_token,
    provider_attempt_id: provider.attempt_id,
  })
  expect(provider).toMatchObject({ state: "settled", owner_token: admission.owner_token, session_id: action.sessionID })
  const selection = facts.selections.find((value) => value.selection_id === provider.selection_id)!
  expect(selection).toMatchObject({
    session_id: action.sessionID,
    security_namespace_id: result.control.scope.securityNamespaceID,
    location_key: result.control.scope.locationKey,
    project_scope_key: result.control.scope.projectScopeKey,
  })
  expect(
    facts.effects.find(
      (value) => value.receipt_id === action.providerReceiptID && value.tool_call_id === action.toolCallID,
    ),
  ).toMatchObject({ state: "settled", effect_kind: "mutating" })
  expect(facts.providers.every((value) => facts.owners.some((owner) => owner.owner_token === value.owner_token))).toBe(
    true,
  )
  expect(result.stopped.stopConfirmed).toBe(true)
  const physical = await Bun.file(path.join(root, "main-result.json")).json()
  expect(physical.providerCalls).toHaveLength(8)
  expect(physical.providerCalls[0]).toEqual({ ordinal: 0, tool: "plan" })
  expect(physical.providerArrivals).toHaveLength(8)
  expect(physical.pending).toEqual([
    { action: "browser", posts: 0 },
    { action: "browser-program", posts: 0 },
  ])
  expect(physical.requests.filter((value: { method: string }) => value.method === "POST")).toEqual([
    { method: "POST", url: "/program-submit", body: "name=canonical+program+value&choice=b" },
  ])
  // All original owners have exited. immutable read avoids creating WAL/SHM files; this
  // is a cold read oracle, not an automatic recovery or a second application Root.
  const filename = path.join(root, "authority.sqlite")
  const beforeBytes = Hash.sha256(await fs.readFile(filename))
  const cold = new Database(`file:${filename}?mode=ro&immutable=1`, { readonly: true, create: false })
  try {
    const before = cold.query("SELECT total_changes() changes").get()
    const records = cold.query("SELECT record FROM browser_action ORDER BY created_at,action_id").all()
    expect(records).toHaveLength(4)
    expect(cold.query("SELECT id FROM session WHERE execution_claim_token IS NOT NULL").all()).toEqual([])
    expect(cold.query("SELECT total_changes() changes").get()).toEqual(before)
  } finally {
    cold.close()
  }
  expect(Hash.sha256(await fs.readFile(filename))).toBe(beforeBytes)
}, 90_000)
