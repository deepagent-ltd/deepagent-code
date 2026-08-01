import { describe, expect, test } from "bun:test"
import type { Identity } from "@deepagent-code/core/context-federation/identity"
import {
  IndexSpaceID,
  LocationKey,
  ProjectScopeKey,
  SecurityNamespaceID,
} from "@deepagent-code/core/context-federation/reference"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { query } from "../../src/code-intelligence/cold-bootstrap"
import { tmpdir } from "../fixture/fixture"

const namespace = SecurityNamespaceID.make("sec_cold_bootstrap")
const location = LocationKey.make("loc_cold_bootstrap")
const project = ProjectScopeKey.make("prjctx_cold_bootstrap")

describe("ColdCodeBootstrap", () => {
  test("returns bounded filesystem evidence without exposing sensitive files", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, "src"))
    await Bun.write(path.join(tmp.path, "src", "service.ts"), "export function boundedBootstrapNeedle() { return true }\n")
    await Bun.write(path.join(tmp.path, ".env"), "BOOTSTRAP_SECRET=boundedBootstrapNeedle\n")
    const result = await Effect.runPromise(query({
      ...scope(identity(tmp.path)),
      root: tmp.path,
      text: "boundedBootstrapNeedle",
    }))

    expect(result.status).toMatchObject({ kind: "partial", state: "cold", reasonCode: "cold_start" })
    expect(result.materialized).toHaveLength(1)
    expect(result.materialized[0]).toMatchObject({ path: "src/service.ts", contentSource: "filesystem" })
    expect(result.materialized[0]!.candidate.ref.revision).toStartWith("bootstrap:")
    expect(result.materialized.some((hit) => hit.path === ".env")).toBe(false)
  })

  test("does not claim an empty repository when the scan budget is exhausted", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "a.ts"), "export const first = true\n")
    await Bun.write(path.join(tmp.path, "b.ts"), "export const hiddenBudgetNeedle = true\n")
    const result = await Effect.runPromise(query({
      ...scope(identity(tmp.path)),
      root: tmp.path,
      text: "hiddenBudgetNeedle",
      maxFiles: 1,
    }))

    expect(result.candidates).toEqual([])
    expect(result.complete).toBe(false)
    expect(result.status).toMatchObject({
      kind: "partial",
      state: "cold",
      outcome: "partial",
      reasonCode: "bootstrap_budget_exhausted",
    })
  })

  test("authorizes before touching the filesystem", async () => {
    const value = identity("/path/that/must/not/be-read")
    const result = await Effect.runPromise(query({
      ...scope(value),
      root: value.canonicalRoot,
      text: "anything",
      principal: { ...scope(value).principal, locationKeys: [] },
    }))

    expect(result.scannedFiles).toBe(0)
    expect(result.status).toMatchObject({ kind: "blocked", state: "denied", reasonCode: "scope_denied" })
  })
})

function identity(root: string): Identity {
  return {
    securityNamespaceId: namespace,
    locationKey: location,
    projectScopeKey: project,
    indexSpaceId: IndexSpaceID.make("idx_cold_bootstrap"),
    canonicalRoot: AbsolutePath.make(root),
  }
}

function scope(value: Identity) {
  return {
    identity: value,
    principal: {
      securityNamespaceId: namespace,
      principalId: "principal",
      authorizationEpoch: 1,
      locationKeys: [location],
      projectScopeKeys: [project],
      sessionIds: [],
      subjectIds: [],
      allowBuiltin: false,
    },
    egress: {
      policyId: "test",
      epoch: 1,
      graphs: ["code" as const],
      sensitivities: ["source_code" as const],
    },
  }
}
