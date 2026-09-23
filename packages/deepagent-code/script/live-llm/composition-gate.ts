import { ContractDigest } from "@deepagent-code/core/contract/digest"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { CompositionDigest } from "../../src/effect/composition-digest"
import { V2RunnerFrame } from "../../src/session/v2-runner-frame"
import { liveFrameIdentity } from "./runner-frame"

/**
 * G3 observes the live harness root itself. The documented frame deviations are intentional;
 * tool IDs are supplied by a fixture so omission of a process-scoped bridge fails the run.
 */
export function assertHarnessComposition(
  record: CompositionDigest.Record,
  expectedApplicationToolIDs?: ReadonlyArray<string>,
) {
  equal("digest version", record.version, 2)
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
}

function equal(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`G3 composition mismatch: ${name}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
}
