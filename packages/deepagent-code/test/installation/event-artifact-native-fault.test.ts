import { afterAll, beforeAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { EventWorkPlacement } from "@deepagent-code/core/deepagent/event-work-placement"
import { EventWorkDagSchema } from "@deepagent-code/core/deepagent/event-work-dag.schema"
import { EventDagNativeFixture } from "./fixture/event-dag-native-fixture"
import { EventInvestigationInstallation } from "./fixture/event-investigation-installation"

const actual =
  process.platform === "darwin" && process.arch === "arm64" && process.env.DAC_EVENT_ARTIFACT_NATIVE_ACTUAL === "1"
const check = actual ? test : test.skip
const prepared: {
  root?: string
  installation?: EventInvestigationInstallation.SignedInstallation
  provider?: ReturnType<typeof EventDagNativeFixture.provider>
} = {}

beforeAll(async () => {
  if (!actual) return
  const assets = process.env.DAC_EVENT_ARTIFACT_NATIVE_ASSETS
  if (!assets) throw new Error("Explicit current Native assets are required; no asset is downloaded")
  prepared.root = await fs.realpath(await fs.mkdtemp("/tmp/dac-event-artifact-native-fault-"))
  const certificate = await EventInvestigationInstallation.certificate(prepared.root)
  prepared.provider = EventDagNativeFixture.provider(certificate)
  prepared.installation = await EventInvestigationInstallation.build({
    directory: prepared.root,
    assets,
    storageCleanupAsset: path.join(assets, "deepagent-work-storage-cleanup"),
    ca: certificate.ca,
    origin: prepared.provider.server.url.origin,
    debugFixturePath: path.join(import.meta.dir, "fixture/event-artifact-native-fault.ts"),
  })
}, 120000)
afterAll(() => prepared.provider?.server.stop(true))

const Census = Schema.Struct({
  providers: Schema.Int,
  ledger: Schema.Record(Schema.String, Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
  capacity: Schema.Struct({ workspaces: Schema.Int, reservedBytes: Schema.Int }),
  authority: EventWorkDagSchema.Authority,
  controller: EventWorkDagSchema.Controller,
  workspace: Schema.Struct({ state: Schema.String, error: Schema.NullOr(Schema.String) }),
})
const Result = Schema.Struct({
  success: Schema.Boolean,
  collected: Schema.NullOr(Schema.Boolean),
  before: Census,
  after: Census,
  failure: Schema.Unknown,
})

type Fixture = Awaited<ReturnType<typeof EventDagNativeFixture.prepare>>

for (const tool of ["write", "managed_command"] as const) {
  check(
    `current ${tool} artifact foreign bytes are preserved and cannot refund custody`,
    async () => {
      const fixture = await terminal(`${tool}-foreign`, tool)
      const authority = original(fixture)
      const directory = authority.placement!.workspace.directory
      const known = await physical(directory)
      const parent = await physical(fixture.candidate.project)
      const foreign = path.join(directory, "foreign-preserve.txt")
      await fs.writeFile(foreign, "User-owned foreign bytes must survive.\n", { flag: "wx", mode: 0o600 })
      const result = await collect(fixture, "foreign", authority.childWorkID)
      expect(result.success).toBe(false)
      expect(result.after.authority.artifactCustody?.cleanup?.state).toBe("unknown")
      expect(result.after.capacity).toEqual(result.before.capacity)
      expect(result.after.workspace.state).toBe("retained")
      expect(result.after.ledger).toEqual(result.before.ledger)
      expect(await fs.readFile(foreign, "utf8")).toBe("User-owned foreign bytes must survive.\n")
      expect(await physical(directory)).toEqual({
        ...known,
        "foreign-preserve.txt": hash("User-owned foreign bytes must survive.\n"),
      })
      expect(await physical(fixture.candidate.project)).toEqual(parent)
      await refusedCold(fixture, authority.childWorkID, result.after, "foreign-cold")
    },
    180000,
  )

  for (const preparing of [false, true])
    check(
      `current ${tool} final cleanup COMMIT fault retains ${preparing ? "preparing" : "unknown"} charge without replay`,
      async () => {
        const fixture = await terminal(`${tool}-commit-${preparing}`, tool)
        const authority = original(fixture)
        const parent = await physical(fixture.candidate.project)
        fault(fixture.candidate.dbPath, authority.childWorkID, preparing)
        const result = await collect(fixture, "commit-fault", authority.childWorkID)
        expect(result.success).toBe(false)
        expect(result.after.authority.artifactCustody?.cleanup?.state).toBe(preparing ? "preparing" : "unknown")
        expect(result.after.authority.artifactCustody?.worktreeAllocatedBytes).toBe(
          result.before.authority.artifactCustody?.worktreeAllocatedBytes,
        )
        expect(result.after.capacity).toEqual(result.before.capacity)
        expect(result.after.workspace).toEqual(result.before.workspace)
        expect(result.after.ledger).toEqual(result.before.ledger)
        expect(await physical(authority.placement!.workspace.directory)).toEqual({})
        expect(await physical(fixture.candidate.project)).toEqual(parent)
        await refusedCold(fixture, authority.childWorkID, result.after, "commit-fault-cold")
      },
      180000,
    )

  check(
    `current ${tool} Native collection accounts physical custody exactly once`,
    async () => {
      const fixture = await terminal(`${tool}-collected`, tool)
      const authority = original(fixture)
      const parent = await physical(fixture.candidate.project)
      const result = await collect(fixture, "collect", authority.childWorkID)
      expect(result.success).toBe(true)
      expect(result.collected).toBe(true)
      expect(result.after.authority.artifactCustody?.cleanup?.state).toBe("collected")
      expect(result.after.capacity.workspaces).toBe(result.before.capacity.workspaces - 1)
      expect(result.after.capacity.reservedBytes).toBeLessThan(result.before.capacity.reservedBytes)
      const artifact = result.after.authority.artifactCustody!
      const baseline = result.after.controller.baseline!
      expect(baseline.state).toBe("sealed")
      if (baseline.state !== "sealed") throw new Error("Collected artifact lacks its original sealed baseline")
      expect(baseline.allocatedBytes).toBeDefined()
      expect(baseline.settledRetentionAt).toBeDefined()
      expect(result.before.capacity.reservedBytes).toBe(
        EventWorkPlacement.WORKSPACE_CUSTODY_RESERVATION_BYTES + EventWorkPlacement.BASELINE_CUSTODY_RESERVATION_BYTES,
      )
      expect(result.after.capacity.reservedBytes).toBe(
        artifact.worktreeAllocatedBytes +
          artifact.gitAllocatedBytes +
          artifact.indexAllocatedBytes +
          baseline.allocatedBytes!,
      )
      expect(result.after.workspace.state).toBe("reclaimed")
      expect(result.after.ledger).toEqual(result.before.ledger)
      expect(await physical(authority.placement!.workspace.directory)).toEqual({})
      expect(await physical(fixture.candidate.project)).toEqual(parent)
      const repeated = await collect(fixture, "collect-again", authority.childWorkID)
      expect(repeated.success).toBe(true)
      expect(repeated.collected).toBe(false)
      expect(repeated.after).toEqual(result.after)
      await refusedCold(fixture, authority.childWorkID, result.after, "collected-cold")
    },
    180000,
  )
}

check(
  "real collector SIGKILL after committed preparation never refunds uncertain physical cleanup",
  async () => {
    const fixture = await terminal("collector-killed", "write")
    const authority = original(fixture)
    const parent = await physical(fixture.candidate.project)
    const before = fixture.snapshot()
    const observed = await descriptor(fixture, "killed", authority.childWorkID)
    const child = fixture.candidate.spawn(["debug"], observed.env)
    const owner = processIdentity(child.pid)
    if (!owner || owner.parent !== process.pid) {
      await child.exited
      throw new Error("Self-created collector identity is unavailable")
    }
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    const deadline = Date.now() + 30000
    const held: NonNullable<ReturnType<typeof processIdentity>>[] = []
    try {
      while (Date.now() < deadline && child.exitCode === null) {
        using db = new Database(fixture.candidate.dbPath, { readonly: true })
        const row = db
          .query<
            { cleanup: string | null },
            [string]
          >("SELECT json_extract(record,'$.artifactCustody.cleanup.state') cleanup FROM event_work_node_authority WHERE work_id=?")
          .get(authority.childWorkID)
        if (row?.cleanup === "preparing") {
          if (!signalOwned(owner, "SIGSTOP")) throw new Error("Original collector exited before observation")
          const children = Bun.spawnSync(["ps", "-axo", "pid=,ppid="], { stdout: "pipe", stderr: "pipe" })
          if (children.exitCode !== 0) throw new Error("Owned collector child census failed")
          const links = children.stdout
            .toString()
            .trim()
            .split("\n")
            .map((line) => line.trim().split(/\s+/).map(Number))
          const owners = new Set([child.pid])
          for (let pass = 0; pass < 8; pass++)
            for (const [pid, parent] of links) if (owners.has(parent!) && !owners.has(pid!)) owners.add(pid!)
          for (const pid of [...owners].filter((pid) => pid !== child.pid)) {
            const identity = processIdentity(pid)
            if (!identity || !owners.has(identity.parent)) continue
            if (signalOwned(identity, "SIGSTOP")) held.push(identity)
          }
          break
        }
        await Bun.sleep(1)
      }
      expect(child.exitCode).toBeNull()
      using db = new Database(fixture.candidate.dbPath, { readonly: true })
      expect(
        db
          .query<
            { state: string },
            [string]
          >("SELECT json_extract(record,'$.artifactCustody.cleanup.state') state FROM event_work_node_authority WHERE work_id=?")
          .get(authority.childWorkID)?.state,
      ).toBe("preparing")
    } finally {
      for (const identity of held) signalOwned(identity, "SIGKILL")
      signalOwned(owner, "SIGKILL")
      await child.exited
      await fs.writeFile(
        path.join(fixture.candidate.directory, "collector-killed.log"),
        JSON.stringify({ stdout: await stdout, stderr: await stderr, ownedChildIdentities: held }),
        { mode: 0o600 },
      )
    }
    const cold = await collect(fixture, "killed-cold", authority.childWorkID)
    expect(cold.success).toBe(true)
    expect(cold.collected).toBe(false)
    expect(cold.before.authority.artifactCustody?.cleanup?.state).toBe("preparing")
    expect(cold.after).toEqual(cold.before)
    expect(cold.after.workspace.state).toBe("retained")
    expect(cold.after.capacity.reservedBytes).toBe(
      EventWorkPlacement.WORKSPACE_CUSTODY_RESERVATION_BYTES + EventWorkPlacement.BASELINE_CUSTODY_RESERVATION_BYTES,
    )
    const after = fixture.snapshot()
    for (const key of [
      "providers",
      "attempts",
      "effects",
      "admissions",
      "counts",
      "reservations",
      "inputs",
      "work",
      "commands",
      "writes",
      "recoveries",
      "resumes",
      "taskRecoveries",
      "taskResumes",
    ] as const)
      expect(after[key], `Killed collection changed ${key}`).toEqual(before[key])
    expect(await physical(fixture.candidate.project)).toEqual(parent)
    await refusedCold(fixture, authority.childWorkID, cold.after, "killed-instance-cold")
    await evidence(fixture, "killed", cold)
  },
  180000,
)

async function terminal(name: string, tool: "write" | "managed_command") {
  if (!prepared.installation || !prepared.root || !prepared.provider)
    throw new Error("Explicit installed Native fixture is missing")
  prepared.provider.select(tool)
  const fixture = await EventDagNativeFixture.prepare({
    installation: prepared.installation,
    directory: path.join(prepared.root, name),
    tool,
  })
  const run = await fixture.run("terminal", fixture.runInput)
  if (run.code !== 0)
    throw new Error(`Legal current DAG terminal failed: ${JSON.stringify(run.output)} ${run.stderr.slice(-2000)}`)
  original(fixture)
  return fixture
}
function original(fixture: Fixture) {
  using db = new Database(fixture.candidate.dbPath, { readonly: true })
  const rows = db
    .query<{ record: string }, []>("SELECT record FROM event_work_node_authority WHERE state='terminal'")
    .all()
  expect(rows).toHaveLength(1)
  const value = Schema.decodeUnknownSync(Schema.fromJsonString(EventWorkDagSchema.Authority))(rows[0]!.record)
  expect(value.terminal).toBeDefined()
  expect(value.artifactCustody).toBeDefined()
  expect(value.artifactCustody?.files).toBeGreaterThan(0)
  expect(value.artifactCustody?.cleanup).toBeUndefined()
  return value
}
async function descriptor(fixture: Fixture, name: string, workID: string) {
  const input = path.join(fixture.candidate.directory, `${name}.collect.input.json`)
  const output = path.join(fixture.candidate.directory, `${name}.collect.result.json`)
  using db = new Database(fixture.candidate.dbPath, { readonly: true })
  const count = db.query<{ n: number }, []>("SELECT count(*) n FROM session_provider_attempt").get()!.n
  await fs.writeFile(input, JSON.stringify({ mode: "collect", workID, expectedProviderCount: count }), { mode: 0o600 })
  return {
    output,
    env: {
      ...fixture.env,
      DAC_EVENT_DAG_FAULT_INPUT: input,
      DAC_EVENT_DAG_FAULT_RESULT: output,
    },
  }
}
async function collect(fixture: Fixture, name: string, workID: string) {
  const requests = prepared.provider!.requests.length
  const input = await descriptor(fixture, name, workID)
  const execution = await fixture.candidate.run(name, ["debug"], input.env)
  if (execution.code !== 0)
    throw new Error(
      `Original collector entry failed: ${execution.stderr.slice(-2000)} ${await Bun.file(input.output).text()}`,
    )
  const result = Schema.decodeUnknownSync(Result)(await Bun.file(input.output).json())
  expect(prepared.provider!.requests.length).toBe(requests)
  expect(result.after.providers).toBe(result.before.providers)
  await evidence(fixture, name, result)
  return result
}
async function refusedCold(fixture: Fixture, workID: string, before: typeof Census.Type, name: string) {
  const requests = prepared.provider!.requests.length
  const cold = await fixture.run(`${name}-startup`, {
    mode: "cold",
    ruleID: fixture.ruleID,
    expectedProviderCount: fixture.snapshot().providerCount,
  })
  expect(cold.code, cold.stderr).toBe(0)
  expect(prepared.provider!.requests.length).toBe(requests)
  const repeated = await collect(fixture, `${name}-collect`, workID)
  expect(repeated.success).toBe(true)
  expect(repeated.collected).toBe(false)
  expect(repeated.after).toEqual(before)
}
function fault(filename: string, workID: string, preparing: boolean) {
  using db = new Database(filename)
  const literal = db.query<{ text: string }, [string]>("SELECT quote(?) text").get(workID)!.text
  // An actual deferred FK failure occurs at COMMIT, after the original collector
  // completed its physical operation and all original accounting statements.
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE test_artifact_parent(id INTEGER PRIMARY KEY); CREATE TABLE test_artifact_commit_failure(id INTEGER REFERENCES test_artifact_parent(id) DEFERRABLE INITIALLY DEFERRED)",
  )
  db.exec(`CREATE TRIGGER test_artifact_commit_failure AFTER UPDATE OF record ON event_work_node_authority
    WHEN NEW.work_id=${literal} AND json_extract(NEW.record,'$.artifactCustody.cleanup.state')='collected'
    BEGIN INSERT INTO test_artifact_commit_failure(id) VALUES(1); END`)
  if (preparing)
    db.exec(`CREATE TRIGGER test_artifact_unknown_failure BEFORE UPDATE OF record ON event_work_node_authority
    WHEN NEW.work_id=${literal} AND json_extract(NEW.record,'$.artifactCustody.cleanup.state')='unknown'
    BEGIN SELECT RAISE(ABORT,'isolated unknown update fault'); END`)
}
async function physical(directory: string, relative = ""): Promise<Record<string, string>> {
  return Object.fromEntries(
    (
      await Promise.all(
        (await fs.readdir(path.join(directory, relative), { withFileTypes: true }))
          .filter((entry) => entry.name !== ".git")
          .map(async (entry): Promise<[string, string][]> => {
            const name = path.join(relative, entry.name)
            if (entry.isSymbolicLink()) throw new Error("Unexpected fixture link")
            if (entry.isDirectory()) return Object.entries(await physical(directory, name))
            return [[name, hash(await fs.readFile(path.join(directory, name)))]]
          }),
      )
    ).flat(),
  )
}
function hash(bytes: string | Buffer) {
  return createHash("sha256").update(bytes).digest("hex")
}
async function evidence(fixture: Fixture, name: string, result: unknown) {
  const directory = process.env.DAC_EVENT_ARTIFACT_NATIVE_EVIDENCE
  if (!directory) return
  const run = path.join(directory, path.basename(path.dirname(fixture.candidate.directory)))
  await fs.mkdir(run, { recursive: true, mode: 0o700 })
  await fs.writeFile(
    path.join(run, `${path.basename(fixture.candidate.directory)}-${name}.json`),
    JSON.stringify({ candidate: fixture.candidate.directory, result }, null, 2),
    { mode: 0o600 },
  )
}

// Darwin lacks pidfd: keep the self-created CLI stopped before enumerating its
// descendants, and compare PID, parent, start time and executable before every
// signal. ESRCH is an observed exit, never a reason to signal a reused PID.
function processIdentity(pid: number) {
  const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "pid=,ppid=,lstart=,comm="], {
    env: { ...process.env, LC_ALL: "C" },
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) return undefined
  const match = /^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)\s*$/.exec(
    result.stdout.toString(),
  )
  return match ? { pid: Number(match[1]), parent: Number(match[2]), started: match[3], command: match[4] } : undefined
}
function signalOwned(identity: NonNullable<ReturnType<typeof processIdentity>>, signal: "SIGSTOP" | "SIGKILL") {
  const current = processIdentity(identity.pid)
  if (
    !current ||
    current.parent !== identity.parent ||
    current.started !== identity.started ||
    current.command !== identity.command
  )
    return false
  try {
    process.kill(identity.pid, signal)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false
    throw error
  }
}
