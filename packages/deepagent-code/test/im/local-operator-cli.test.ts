import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"

test("source CLI rejects retired enrollment and rotates/revokes Core-prepared credentials with exact retries", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-operator-cli-")))
  await Promise.all(
    ["home", "tmp", "config", "data", "cache", "state", "project"].map((name) => fs.mkdir(path.join(root, name))),
  )
  const directory = path.join(root, "project")
  const filename = path.join(root, "authority.sqlite")
  const policyPath = path.join(root, "policy.json")
  await Bun.write(
    path.join(directory, "deepagent-code.json"),
    JSON.stringify({
      providers: {
        fixture: {
          api: {
            type: "native",
            url: "https://example.invalid/v1/responses",
            settings: {},
            protocol: "openai.responses",
          },
          models: { probe: { api: { id: "probe" } } },
        },
      },
    }),
  )
  await Bun.write(
    policyPath,
    JSON.stringify({
      version: 1,
      targets: [
        {
          id: "review",
          directory,
          agentID: "auto",
          providerID: "fixture",
          modelID: "probe",
          budget: { ...WorkAuthorityPolicy.TEXT_ONLY_PROFILE.budget, maxTotalTokens: 8_000 },
        },
      ],
    }),
  )
  const previous = path.join(root, "previous.txt")
  await fs.writeFile(previous, "first-private-fixture-password", { mode: 0o600 })
  async function run(args: string[], password = "first-private-fixture-password", prepare = false) {
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        path.resolve(import.meta.dir, "../fixture/cli-secret-store.ts"),
        ...(prepare
          ? [path.resolve(import.meta.dir, "fixture/operator-credential-process.ts")]
          : [path.resolve(import.meta.dir, "../../src/index.ts"), "operator"]),
        ...args,
      ],
      {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: path.join(root, "home"),
          TMPDIR: path.join(root, "tmp"),
          TMP: path.join(root, "tmp"),
          TEMP: path.join(root, "tmp"),
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          XDG_STATE_HOME: path.join(root, "state"),
          DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"),
          DEEPAGENT_CODE_HOME: path.join(root, "data"),
          DEEPAGENT_CODE_DB: filename,
          DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
          DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
          DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
          DEEPAGENT_CODE_SERVER_USERNAME: "test-operator",
          DEEPAGENT_CODE_SERVER_PASSWORD: password,
          NO_COLOR: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000)
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(timer))
    await Bun.write(path.join(root, `command-${crypto.randomUUID()}.log`), stdout + stderr)
    expect(stdout + stderr).not.toContain("first-private-fixture-password")
    expect(stdout + stderr).not.toContain("second-private-fixture-password")
    return { status, stdout, stderr }
  }
  const enroll = ["enroll", "--request-id", "one", "--policy", policyPath]
  expect((await run(enroll, "")).status).toBe(1)
  const refused = await run(enroll)
  expect(refused.status).toBe(1)
  expect(refused.stderr).toContain("LOCAL_TASK_EXECUTION_UNAVAILABLE")
  const rejected = new Database(filename, { readonly: true })
  try {
    expect(rejected.query("SELECT count(*) count FROM local_operator_authority").get()).toEqual({ count: 0 })
  } finally {
    rejected.close()
  }
  // Credential lifecycle uses the real Core admission transaction with a registered
  // v2 target carrying no tools or execution evidence. Source CLI enrollment stays refused.
  const first = await run(["one"], "first-private-fixture-password", true)
  expect({ status: first.status, error: first.status === 0 ? "" : first.stderr }).toEqual({ status: 0, error: "" })
  expect((await run(["one"], "first-private-fixture-password", true)).stdout).toBe(first.stdout)
  const read = () => {
    const db = new Database(filename, { readonly: true })
    try {
      return db
        .query("SELECT operator_id,revision,credential_generation,state FROM local_operator_authority")
        .get() as { operator_id: string; revision: number; credential_generation: number; state: string }
    } finally {
      db.close()
    }
  }
  const original = read()
  // The real offline CLI has no installed provider-contract/capture factory. Source/config
  // strings must not turn into approval; failed commands leave policy and Basic identity intact.
  const inspect = () => {
    const db = new Database(filename, { readonly: true })
    try {
      return {
        operator: db.query("SELECT * FROM local_operator_authority").get(),
        approvals: db.query("SELECT count(*) count FROM work_route_approval").get(),
        counts: db.query("SELECT count(*) count FROM work_count_acquisition").get(),
      }
    } finally {
      db.close()
    }
  }
  const beforeApproval = inspect()
  const unavailable = await run([
    "approve-route",
    "--request-id",
    "unavailable-approval",
    "--target",
    "review",
    "--snapshot",
    "probe",
    "--expires-at",
    String(Date.now() + 60_000),
    "--expected-revision",
    "1",
    "--expected-route-revision",
    "0",
  ])
  expect(unavailable.status).toBe(1)
  expect(inspect()).toEqual(beforeApproval)
  const absent = await run([
    "revoke-route",
    "--request-id",
    "absent-approval",
    "--target",
    "review",
    "--expected-revision",
    "1",
    "--expected-route-revision",
    "0",
  ])
  expect(absent.status).toBe(1)
  expect(inspect()).toEqual(beforeApproval)
  const wrong = path.join(root, "wrong.txt")
  await fs.writeFile(wrong, "incorrect", { mode: 0o600 })
  const rotate = ["rotate", "--request-id", "rotate-one", "--expected-revision", "1"]
  expect((await run([...rotate, "--previous-credential-file", wrong], "second-private-fixture-password")).status).toBe(
    1,
  )
  expect(read()).toEqual(original)
  const rotated = await run([...rotate, "--previous-credential-file", previous], "second-private-fixture-password")
  expect({ status: rotated.status, error: rotated.status === 0 ? "" : rotated.stderr }).toEqual({
    status: 0,
    error: "",
  })
  expect((await run(rotate, "second-private-fixture-password")).stdout).toBe(rotated.stdout)
  expect(read()).toEqual({ operator_id: original.operator_id, revision: 2, credential_generation: 2, state: "active" })
  const revoke = ["revoke", "--request-id", "revoke-one", "--expected-revision", "2"]
  const revoked = await run(revoke, "second-private-fixture-password")
  expect(revoked.status).toBe(0)
  expect((await run(revoke, "second-private-fixture-password")).stdout).toBe(revoked.stdout)
  expect(read()).toEqual({ operator_id: original.operator_id, revision: 3, credential_generation: 3, state: "revoked" })
  const reenrolled = await run(["two"], "second-private-fixture-password", true)
  expect(reenrolled.status).toBe(0)
  expect(read().operator_id).not.toBe(original.operator_id)
  expect(read().revision).toBe(4)
  const installation = path.join(root, "data/local-operator/installation.json")
  await fs.chmod(installation, 0o644)
  expect(
    (
      await run(
        ["revoke", "--request-id", "unsafe-file", "--expected-revision", "4"],
        "second-private-fixture-password",
      )
    ).status,
  ).toBe(1)
  expect(read().state).toBe("active")
  const db = new Database(filename, { readonly: true })
  try {
    expect(
      db
        .query(
          "SELECT (SELECT count(*) FROM session) sessions,(SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM work_execution) work,(SELECT count(*) FROM session_provider_attempt) providers,(SELECT count(*) FROM im_task_grant) grants",
        )
        .get(),
    ).toEqual({ sessions: 0, inputs: 0, work: 0, providers: 0, grants: 0 })
  } finally {
    db.close()
  }
  console.info("LOCAL_OPERATOR_CLI_EVIDENCE", root)
}, 100_000)
