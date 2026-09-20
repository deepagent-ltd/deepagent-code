import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"
import {
  applyRuntimeDefaults,
  CORE_V2_EXECUTION_OWNER_ENV,
  CONTEXT_FEDERATION_PRODUCTION_ENV,
  DEFAULT_MODELS_URL,
  EVENT_V2_ADMISSION_ENV,
  IM_SINGLE_WRITE_ENV,
  MODELS_URL_ENV,
  RUNTIME_DEFAULTS_SNAPSHOT_ENV,
  runtimeDefaultsFromEnv,
  V2_BUILD_IDENTITY_ENV,
  V2_OWNER_CAMPAIGN_ENV,
} from "../src/runtime-defaults"

// W0.1 — the V2 production runtime defaults are single-sourced in src/runtime-defaults.ts and the
// CLI entry (src/index.ts) + desktop sidecar (src/node.ts) both apply them at the earliest process
// point. These tests cover the semantics (default-ON, explicit `=false`/`=0` off) and the
// entry-level parity (both subprocesses print the same canonical defaults vector).

const DEFAULT_ON_VECTOR = {
  eventV2Admission: true,
  imSingleWrite: true,
  coreV2ExecutionOwner: true,
  federationActivate: true,
  ownerCampaign: undefined,
  buildIdentity: undefined,
}

describe("runtimeDefaultsFromEnv", () => {
  test("case 1: empty env ships every default-ON boolean ON and the optional strings undefined", () => {
    expect(runtimeDefaultsFromEnv({})).toEqual(DEFAULT_ON_VECTOR)
  })

  test("case 2: explicit =false/=0 (case- and whitespace-insensitive) turns each boolean OFF", () => {
    // shared table (core/deepagent/flip-flag): "" / "false" / "0" → OFF; any other defined value → ON
    for (const off of ["false", "FALSE", " False ", "0", "0 ", ""]) {
      expect(runtimeDefaultsFromEnv({ [EVENT_V2_ADMISSION_ENV]: off }).eventV2Admission).toBe(false)
      expect(runtimeDefaultsFromEnv({ [IM_SINGLE_WRITE_ENV]: off }).imSingleWrite).toBe(false)
      expect(runtimeDefaultsFromEnv({ [CORE_V2_EXECUTION_OWNER_ENV]: off }).coreV2ExecutionOwner).toBe(false)
      expect(runtimeDefaultsFromEnv({ [CONTEXT_FEDERATION_PRODUCTION_ENV]: off }).federationActivate).toBe(false)
    }
    for (const on of ["true", "TRUE", " true ", "1", "1 ", "yes", "2"]) {
      expect(runtimeDefaultsFromEnv({ [EVENT_V2_ADMISSION_ENV]: on }).eventV2Admission).toBe(true)
      expect(runtimeDefaultsFromEnv({ [IM_SINGLE_WRITE_ENV]: on }).imSingleWrite).toBe(true)
      expect(runtimeDefaultsFromEnv({ [CORE_V2_EXECUTION_OWNER_ENV]: on }).coreV2ExecutionOwner).toBe(true)
      expect(runtimeDefaultsFromEnv({ [CONTEXT_FEDERATION_PRODUCTION_ENV]: on }).federationActivate).toBe(true)
    }
  })

  test("case 2b: ownerCampaign/buildIdentity are fallback strings — set values pass through, empty stays undefined", () => {
    expect(
      runtimeDefaultsFromEnv({
        [V2_OWNER_CAMPAIGN_ENV]: "campaign-alpha",
        [V2_BUILD_IDENTITY_ENV]: '{"buildID":"b1"}',
      }),
    ).toEqual({
      ...DEFAULT_ON_VECTOR,
      ownerCampaign: "campaign-alpha",
      buildIdentity: '{"buildID":"b1"}',
    })
    expect(
      runtimeDefaultsFromEnv({ [V2_OWNER_CAMPAIGN_ENV]: "  ", [V2_BUILD_IDENTITY_ENV]: "" }),
    ).toEqual(DEFAULT_ON_VECTOR)
  })

  test("case 3: applyRuntimeDefaults fills only unset keys — explicit =false/=0 kill-switches survive", () => {
    const env: NodeJS.ProcessEnv = {
      [EVENT_V2_ADMISSION_ENV]: "false",
      [IM_SINGLE_WRITE_ENV]: "0",
    }
    applyRuntimeDefaults(env)
    expect(env[EVENT_V2_ADMISSION_ENV]).toBe("false")
    expect(env[IM_SINGLE_WRITE_ENV]).toBe("0")
    expect(env[CORE_V2_EXECUTION_OWNER_ENV]).toBe("true")
    expect(env[CONTEXT_FEDERATION_PRODUCTION_ENV]).toBe("true")
    // Optional strings carry no canonical default: nothing is written.
    expect(env[V2_OWNER_CAMPAIGN_ENV]).toBeUndefined()
    expect(env[V2_BUILD_IDENTITY_ENV]).toBeUndefined()
    expect(runtimeDefaultsFromEnv(env)).toEqual({
      eventV2Admission: false,
      imSingleWrite: false,
      coreV2ExecutionOwner: true,
      federationActivate: true,
      ownerCampaign: undefined,
      buildIdentity: undefined,
    })
  })

  test("case 3b: the models catalog URL defaults to the self-hosted catalog; an explicit value survives", () => {
    const env: NodeJS.ProcessEnv = {}
    applyRuntimeDefaults(env)
    expect(env[MODELS_URL_ENV]).toBe(DEFAULT_MODELS_URL)
    const pinned: NodeJS.ProcessEnv = { [MODELS_URL_ENV]: "https://models.dev" }
    applyRuntimeDefaults(pinned)
    expect(pinned[MODELS_URL_ENV]).toBe("https://models.dev")
  })
})

const packageRoot = path.resolve(import.meta.dir, "..")

function entrySnapshot(entry: "index" | "node", extraEnv: Record<string, string> = {}): Record<string, string> {
  const result = spawnSync("bun", ["run", "--conditions=browser", `src/${entry}.ts`], {
    cwd: packageRoot,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      [RUNTIME_DEFAULTS_SNAPSHOT_ENV]: "1",
      ...extraEnv,
    },
    encoding: "utf8",
    timeout: 120_000,
  })
  expect(result.status, `stderr: ${result.stderr}`).toBe(0)
  expect(result.stderr).toBe("")
  return JSON.parse(result.stdout) as Record<string, string>
}

// Runs the REAL entry files in isolated bun subprocesses — importing the CLI entry in-process
// would execute its yargs main, so each entry is spawned and asked (via the snapshot env switch)
// to print its canonical defaults vector and exit without starting.
describe("W0.1 entry parity: CLI and desktop sidecar apply identical runtime defaults", () => {
  test("case 4: both entries print the same vector with defaults applied", () => {
    const cli = entrySnapshot("index")
    const sidecar = entrySnapshot("node")

    expect(sidecar).toEqual(cli)
    expect(cli).toEqual({
      [EVENT_V2_ADMISSION_ENV]: "true",
      [IM_SINGLE_WRITE_ENV]: "true",
      [CORE_V2_EXECUTION_OWNER_ENV]: "true",
      [CONTEXT_FEDERATION_PRODUCTION_ENV]: "true",
      [MODELS_URL_ENV]: DEFAULT_MODELS_URL,
    })
    // The optional strings have no canonical default — absent from the printed vector.
    expect(V2_OWNER_CAMPAIGN_ENV in cli).toBe(false)
    expect(V2_BUILD_IDENTITY_ENV in cli).toBe(false)
  })

  test("case 4b: an explicit =false kill-switch survives in both entries", () => {
    const killEnv = {
      [EVENT_V2_ADMISSION_ENV]: "false",
      [CORE_V2_EXECUTION_OWNER_ENV]: "0",
      [MODELS_URL_ENV]: "https://models.dev",
    }
    const cli = entrySnapshot("index", killEnv)
    const sidecar = entrySnapshot("node", killEnv)
    expect(sidecar).toEqual(cli)
    expect(cli[EVENT_V2_ADMISSION_ENV]).toBe("false")
    expect(cli[CORE_V2_EXECUTION_OWNER_ENV]).toBe("0")
    expect(cli[IM_SINGLE_WRITE_ENV]).toBe("true")
    expect(cli[CONTEXT_FEDERATION_PRODUCTION_ENV]).toBe("true")
    expect(cli[MODELS_URL_ENV]).toBe("https://models.dev")
  })
})
