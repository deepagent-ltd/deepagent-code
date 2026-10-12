import { expect, test } from "bun:test"
import { Effect } from "effect"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { LocalOperatorPolicy } from "../../src/im/local-operator-policy"

// Parser fixtures select configured identities; none establish Native or provider approval.
const base = {
  id: "review",
  directory: "/private/absent-policy-fixture",
  agentID: "auto",
  providerID: "fixture",
  modelID: "probe",
  budget: { ...WorkAuthorityPolicy.TEXT_ONLY_PROFILE.budget },
}
const fileScope = {
  read: [{ kind: "file", path: "guard.test.ts" }],
  write: [],
  deny: [],
  maxReadBytes: WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE.maxReadBytes,
  maxPageBytes: 51_200,
  maxHashBytes: 16_777_216,
  maxWriteBytes: 0,
  symlinks: "deny",
}
const read = { ...base, project: { tools: ["read"], fileScope } }
const write = {
  ...base,
  project: {
    tools: ["read", "write"],
    fileScope: { ...fileScope, write: [{ kind: "file", path: "output.ts" }], maxWriteBytes: 51_200 },
  },
}
const command = {
  ...base,
  id: "validation",
  budget: { ...WorkAuthorityPolicy.PROJECT_PROFILE.budget },
  project: {
    tools: ["read", "managed_command"],
    fileScope,
    commandRecipes: [
      {
        schemaVersion: "work-command-recipe.v1",
        logicalID: "project-tests",
        revision: 1,
        executable: "installed-bun-v1",
        argv: [
          { kind: "literal", value: "test" },
          { kind: "literal", value: "guard.test.ts" },
        ],
        parameters: [],
        cwd: null,
        inputs: ["guard.test.ts"],
        outputs: [],
        environment: [],
        workspace: "private_explicit_files.v1",
        sandbox: {
          id: "darwin-single-process-workspace-v1",
          revision: 1,
          network: "deny",
          processes: 1,
          openFiles: 64,
          maxInputFiles: 256,
          maxInputFileBytes: 16_777_216,
          maxInputBytes: 67_108_864,
          maxDepth: 16,
          maxOutputFiles: 32,
          maxOutputFileBytes: 1_048_576,
          maxOutputBytes: 33_554_432,
        },
        timeoutMs: 15_000,
        stdoutBytes: 65_536,
        stderrBytes: 65_536,
      },
    ],
  },
}
const investigation = {
  ...read,
  id: "investigation",
  profile: "event_investigate_v1",
  budget: { ...WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE.budget },
}
const decode = (input: unknown) => Effect.runPromise(LocalOperatorPolicy.parse(input))

test("version 5 strict parser keeps original target grammars alongside explicit investigation", async () => {
  const policy = { version: 5, targets: [base, read, write, command, investigation] }
  expect(CanonicalJson.stringify(await decode(policy))).toBe(CanonicalJson.stringify(policy))
  expect(await decode({ version: 5, targets: [command, investigation] })).toEqual({
    version: 5,
    targets: [command, investigation],
  })
})

test("version 1–4 strict grammars and decoded policy data remain unchanged", async () => {
  for (const [index, entry] of [base, read, write, command].entries()) {
    const policy = { version: index + 1, targets: [entry] }
    expect(CanonicalJson.stringify(await decode(policy))).toBe(CanonicalJson.stringify(policy))
    await expect(decode({ version: index + 1, targets: [investigation] })).rejects.toMatchObject({
      code: "LOCAL_OPERATOR_INVALID",
    })
    await expect(
      decode({ version: index + 1, targets: [{ ...entry, profile: "event_investigate_v1" }] }),
    ).rejects.toMatchObject({ code: "LOCAL_OPERATOR_INVALID" })
  }
  // v2 parsing itself has always allowed this data; its resolver denies write authority.
  expect(
    await decode({
      version: 2,
      targets: [{ ...read, project: { ...read.project, fileScope: write.project.fileScope } }],
    }),
  ).toBeDefined()
})

test("investigation pure parser rejects mutation, command, integration, child, tree and caller profile proofs", async () => {
  const denied = [
    { ...investigation, profile: "project_work_v1" },
    {
      ...investigation,
      profile: { id: "event_investigate_v1", version: 1, hash: WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE_HASH },
    },
    { ...investigation, profileHash: WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE_HASH },
    { ...investigation, childPolicy: "deny_all" },
    { ...investigation, project: { ...investigation.project, tools: ["read", "write"] } },
    { ...investigation, project: { ...investigation.project, tools: ["managed_command"] } },
    { ...investigation, project: { ...investigation.project, commandRecipes: [] } },
    { ...investigation, project: { ...investigation.project, integrations: [] } },
    {
      ...investigation,
      project: { ...investigation.project, fileScope: { ...fileScope, write: [{ kind: "file", path: "output.ts" }] } },
    },
    { ...investigation, project: { ...investigation.project, fileScope: { ...fileScope, maxWriteBytes: 1 } } },
    {
      ...investigation,
      project: { ...investigation.project, fileScope: { ...fileScope, read: [{ kind: "tree", path: "src" }] } },
    },
    {
      ...investigation,
      project: { ...investigation.project, fileScope: { ...fileScope, maxReadBytes: fileScope.maxReadBytes + 1 } },
    },
    {
      ...investigation,
      project: { ...investigation.project, fileScope: { ...fileScope, maxPageBytes: fileScope.maxPageBytes + 1 } },
    },
    {
      ...investigation,
      project: { ...investigation.project, fileScope: { ...fileScope, maxHashBytes: fileScope.maxHashBytes + 1 } },
    },
  ]
  for (const entry of denied)
    await expect(decode({ version: 5, targets: [command, entry] })).rejects.toMatchObject({
      code: "LOCAL_OPERATOR_INVALID",
    })
})

test("every fixed investigation budget ceiling is rejected by the pure parser without resolver services or directory I/O", async () => {
  for (const [key, maximum] of Object.entries(WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE.budget)) {
    const policy = {
      version: 5,
      targets: [base, { ...investigation, budget: { ...investigation.budget, [key]: maximum + 1 } }],
    }
    const error = await Effect.runPromise(LocalOperatorPolicy.parse(policy).pipe(Effect.flip))
    expect(error.code).toBe("LOCAL_OPERATOR_INVALID")
  }
  await expect(
    decode({ version: 5, targets: [{ ...investigation, budget: { ...investigation.budget, hourWindowMinutes: 30 } }] }),
  ).rejects.toMatchObject({ code: "LOCAL_OPERATOR_INVALID" })
  expect(
    await decode({
      version: 5,
      targets: [
        { ...investigation, budget: { ...investigation.budget, maxTotalTokens: 8_000, maxProviderDispatches: 2 } },
      ],
    }),
  ).toBeDefined()
})

test("version 5 ordinary read shape cannot gain write rights from the enclosing file version", async () => {
  const hiddenWrite = { ...read, project: { ...read.project, fileScope: write.project.fileScope } }
  await expect(decode({ version: 5, targets: [hiddenWrite] })).rejects.toMatchObject({ code: "LOCAL_OPERATOR_INVALID" })
  expect(await decode({ version: 5, targets: [write, command] })).toEqual({ version: 5, targets: [write, command] })
})
