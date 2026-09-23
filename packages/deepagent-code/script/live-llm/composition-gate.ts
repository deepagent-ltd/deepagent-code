import { ContractDigest } from "@deepagent-code/core/contract/digest"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { CompositionDigest } from "../../src/effect/composition-digest"
import { V2RunnerFrame } from "../../src/session/v2-runner-frame"
import { liveFrameIdentity } from "./runner-frame"

/**
 * G3 observes the live harness root itself. The documented frame deviations are intentional;
 * tool IDs are supplied by a fixture so omission of a process-scoped bridge fails the run.
 */
export async function assertHarnessComposition(
  record: CompositionDigest.Record,
  production: CompositionDigest.Record,
  expectedApplicationToolIDs?: ReadonlyArray<string>,
) {
  const declared = await Bun.file(new URL("./COMPOSITION-DEVIATIONS.json", import.meta.url)).json() as unknown
  if (!declared || typeof declared !== "object" || !("schema" in declared) ||
      declared.schema !== "deepagent-live-composition-deviations.v1" ||
      !("deviations" in declared) || !Array.isArray(declared.deviations) ||
      !declared.deviations.every((item) => item && typeof item === "object" &&
        "path" in item && typeof item.path === "string" &&
        "reason" in item && typeof item.reason === "string" && item.reason.length > 0))
    throw new Error("G3 composition deviation manifest is invalid")
  const allowedPaths = [
    "database.path",
    "locationHost.host",
    "locationHost.seams",
    "v2Registry.applicationTools",
    "v2Registry.materialized",
    "v2Registry.legacyEgress",
  ]
  equal("reviewed deviation paths", declared.deviations.map((item) => item.path), allowedPaths)
  const allowed = new Set(allowedPaths)
  const compare = (path: string, actual: unknown, expected: unknown): void => {
    if (allowed.has(path) || JSON.stringify(actual) === JSON.stringify(expected)) return
    if (actual && expected && typeof actual === "object" && typeof expected === "object" &&
        !Array.isArray(actual) && !Array.isArray(expected)) {
      const left = actual as Record<string, unknown>
      const right = expected as Record<string, unknown>
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)]))
        compare(`${path}.${key}`, left[key], right[key])
      return
    }
    throw new Error(`G3 production composition drift at ${path}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
  }

  equal("digest version", record.version, 2)
  equal("production digest version", production.version, 2)
  equal(
    "production digest content",
    production.digest,
    CompositionDigest.compute({
      sessionOwner: production.sessionOwner,
      v2Registry: production.v2Registry,
      authoritySurface: production.authoritySurface,
      database: production.database,
      locationHost: production.locationHost,
    }),
  )
  equal(
    "digest content",
    record.digest,
    CompositionDigest.compute({
      sessionOwner: record.sessionOwner,
      v2Registry: record.v2Registry,
      authoritySurface: record.authoritySurface,
      database: record.database,
      locationHost: record.locationHost,
    }),
  )
  equal("session execution", record.sessionOwner.execution, V2RunnerFrame.frameIdentity.sessionOwner.execution)
  equal("session placement", record.sessionOwner.placement, V2RunnerFrame.frameIdentity.sessionOwner.placement)
  equal("session coordination", record.sessionOwner.coordination, V2RunnerFrame.frameIdentity.sessionOwner.coordination)
  equal("authority surface", record.authoritySurface, CompositionDigest.authoritySurface)
  equal("harness Location host", record.locationHost.host, liveFrameIdentity.locationHost.host)
  equal("harness Location seams", record.locationHost.seams, liveFrameIdentity.locationHost.seams)
  equal("Location map", record.locationHost.map, LocationServiceMap.key)
  equal("Location TTL", record.locationHost.idleTimeToLive, V2RunnerFrame.frameIdentity.locationHost.idleTimeToLive)
  equal("application tool count", record.v2Registry.applicationTools.count, record.v2Registry.applicationTools.ids.length)
  equal(
    "application tool digest",
    record.v2Registry.applicationTools.digest,
    ContractDigest.contentDigest({
      kind: "application-tools",
      ids: record.v2Registry.applicationTools.ids,
      rejected: record.v2Registry.applicationTools.rejected,
    }),
  )
  equal("materialized tool count", record.v2Registry.materialized.count, record.v2Registry.materialized.ids.length)
  equal(
    "materialized effect-kind count",
    record.v2Registry.materialized.effectKinds.readOnly + record.v2Registry.materialized.effectKinds.mutating,
    record.v2Registry.materialized.count,
  )
  if (expectedApplicationToolIDs) {
    equal("fixture application tools", record.v2Registry.applicationTools.ids, [...expectedApplicationToolIDs].toSorted())
    equal("fixture rejected tools", record.v2Registry.applicationTools.rejected, 0)
    expectedApplicationToolIDs.forEach((id) => {
      if (!record.v2Registry.materialized.ids.includes(id))
        throw new Error(`G3 composition mismatch: fixture tool ${id} missing from V2 materialization`)
    })
  }
  for (const facet of ["sessionOwner", "v2Registry", "authoritySurface", "database", "locationHost"] as const)
    compare(facet, record[facet], production[facet])
}

function equal(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`G3 composition mismatch: ${name}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
}
