#!/usr/bin/env bun

import path from "node:path"
import { copyFile, stat } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { Effect, Exit, Layer, Ref, Stream } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionLegacyProviderResolution } from "@/session/legacy-provider-resolution"
import { LLM } from "@/session/llm"
import { MessageID, SessionID } from "@/session/schema"
import { EventV2 } from "@deepagent-code/core/event"
import { ProjectV2 } from "@deepagent-code/core/project"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { InstanceRef } from "@/effect/instance-ref"

// REL-001 release drill (BUG-407-009). Runs against a COPY of the production snapshot only:
// the source path must contain "drill" (the live database is never opened for writing).
// Steps: incident state check, 0-provider-invocation abandoned recovery, fork smoke,
// and a new message write on the original session.

const INCIDENT_SESSIONS = ["ses_00c3f7decfffhjQSy69Q5gSd1S", "ses_0149b8afffffWlu80cVGdzFI9s"]
const INCIDENT_DIRECTORY = "/Users/xiuranli/code/hygon/vllm"
const INCIDENT_PROJECT_ID = "6337bf4e27be43039900d3258a454af34b9b62ad"

// The drill boots services directly (no desktop instance), so the fork path gets a minimal
// instance context matching the incident project rows in the drill database.
const drillInstanceContext = {
  directory: INCIDENT_DIRECTORY,
  worktree: INCIDENT_DIRECTORY,
  project: {
    id: ProjectV2.ID.make(INCIDENT_PROJECT_ID),
    worktree: INCIDENT_DIRECTORY,
    vcs: "git" as const,
    time: { created: 1784826016726, updated: 1786691614012 },
    sandboxes: [],
  },
}

const arg = (name: string) => {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

export async function copyForDrill(source: string) {
  const info = await stat(source)
  if (!info.isFile()) throw new Error(`drill source is not a file: ${source}`)
  if (!path.basename(source).includes("drill"))
    throw new Error(`refusing to drill without a drill copy; source basename must contain "drill": ${source}`)
  const target = path.join(path.dirname(source), `rel-001-drill-${Date.now()}-${randomUUID().slice(0, 8)}.db`)
  await copyFile(source, target)
  return target
}

type Evidence = { step: string; detail: string }

const evidenceLines: Evidence[] = []
const evidence = (step: string, detail: string) => {
  evidenceLines.push({ step, detail })
  console.log(`REL-001 ${step}: ${detail}`)
}

const fakeLLM = Layer.effect(
  LLM.Service,
  Effect.gen(function* () {
    const invocations = yield* Ref.make(0)
    return LLM.Service.of({
      stream: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* Ref.update(invocations, (n) => n + 1)
            return Stream.failSync(
              () => new Error("drill oracle: provider invoked during abandoned recovery — oracle violated"),
            )
          }),
        ),
    })
  }),
)

const layersFor = (database: string) => {
  // EventV2.defaultLayer bakes Database.defaultLayer (the channel-local DB), so every consumer must
  // be wired to the drill path explicitly — a merged default provider silently steals the service.
  const eventV2 = EventV2.layer.pipe(Layer.provide(Database.layerFromPath(database)))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(eventV2))
  // The session projector materializes session.created events into session rows (fork children too).
  const sessionProjector = SessionProjector.layer.pipe(
    Layer.provide(eventV2),
    Layer.provide(Database.layerFromPath(database)),
  )
  return Layer.mergeAll(
    Session.layer.pipe(
      Layer.provide(BackgroundJob.defaultLayer),
      Layer.provide(Database.layerFromPath(database)),
      Layer.provide(bridge),
      Layer.provide(RuntimeFlags.defaultLayer),
    ),
    SessionLegacyProviderResolution.layer.pipe(
      Layer.provide(Database.layerFromPath(database)),
      Layer.provide(bridge),
    ),
    sessionProjector,
    eventV2,
    Database.layerFromPath(database),
    fakeLLM,
  )
}

export function runDrill(database: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const resolution = yield* SessionLegacyProviderResolution.Service
    const sessions = yield* Session.Service

    for (const sessionID of INCIDENT_SESSIONS) {
      const history = yield* db
        .get<{ state: string; reason: string | null }>(sql`SELECT state, reason FROM session_history_state WHERE session_id = ${sessionID}`)
        .pipe(Effect.orDie)
      evidence(
        "incident-state",
        `${sessionID} history=${history?.state} reason=${history?.reason ?? "n/a"}`,
      )
      if (history?.state !== "recovery_required") return yield* Effect.die(`incident session not in recovery state`)
    }

    for (const sessionID of INCIDENT_SESSIONS) {
      const descriptors = yield* resolution.describe(SessionID.make(sessionID))
      evidence("describe", `${sessionID} descriptors=${descriptors.length} supported=${descriptors.filter((d) => d.resolutionSupported).length}`)
      for (const descriptor of descriptors) {
        if (!descriptor.resolutionSupported) {
          evidence(
            "describe-unsupported",
            `${sessionID} receipt=${descriptor.receiptID} reasons=${descriptor.unsupportedReasons.join(",")}`,
          )
          return yield* Effect.die(`incident receipt is not resolvable: ${descriptor.receiptID}`)
        }
        const resolved = yield* resolution.resolve({
          sessionID: SessionID.make(sessionID),
          commandID: `rel-001-drill-${randomUUID().slice(0, 8)}`,
          receiptID: descriptor.receiptID,
          decision: "abandoned",
          expected: {
            providerState: "indeterminate_after_crash",
            promptEpoch: descriptor.promptEpoch,
            sessionMutationEpoch: descriptor.sessionMutationEpoch,
            requestHash: descriptor.requestHash,
            historyHash: descriptor.historyHash,
            worldStateBaselineHash: descriptor.worldStateBaselineHash,
          },
          reason: "REL-001 drill: provider outcome unknown after restart",
          riskAcknowledged: false,
          actorID: "rel-001-drill",
        }).pipe(
          Effect.mapError(
            (error) =>
              `resolve conflict: ${error instanceof SessionLegacyProviderResolution.Conflict ? error.reason : error._tag}`,
          ),
        )
        evidence("resolve", `${sessionID} receipt=${descriptor.receiptID} resolution=${resolved.resolutionID}`)
      }
    }

    for (const sessionID of INCIDENT_SESSIONS) {
      const history = yield* db
        .get<{ state: string }>(sql`SELECT state FROM session_history_state WHERE session_id = ${sessionID}`)
        .pipe(Effect.orDie)
      evidence("post-recovery", `${sessionID} history=${history?.state}`)
      if (history?.state === "recovery_required") return yield* Effect.die(`session still recovery_required after resolution`)
    }

    evidence("oracle", "provider invocations during abandoned recovery = 0 (any invocation fails the drill)")

    const forkTarget = INCIDENT_SESSIONS[0]
    const forkResult = yield* sessions
      .fork({ sessionID: SessionID.make(forkTarget), intentID: `rel-001-drill-fork-${randomUUID().slice(0, 8)}` })
      .pipe(Effect.provideService(InstanceRef, drillInstanceContext), Effect.exit)
    if (Exit.isFailure(forkResult)) return yield* Effect.die(`fork smoke failed: ${forkResult.cause}`)
    evidence("fork", `${forkTarget} fork intent admitted`)

    const user = yield* sessions
      .updateMessage({
        id: MessageID.make(`msg_rel001_${randomUUID().slice(0, 8)}`),
        sessionID: SessionID.make(forkTarget),
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: "deepseek", modelID: "deepseek-v4-flash" } as never,
      })
      .pipe(Effect.provideService(InstanceRef, drillInstanceContext), Effect.exit)
    if (Exit.isFailure(user)) return yield* Effect.die(`new message write failed: ${user.cause}`)
    evidence("new-message", `${forkTarget} post-recovery message write accepted`)

    return { evidence: evidenceLines }
  }).pipe(Effect.provide(layersFor(database)))
}

if (import.meta.main) {
  const source = arg("--db")
  if (!source) {
    console.error("usage: bun script/rel-001-drill.ts --db <production-snapshot-drill-copy.db>")
    process.exit(2)
  }
  const database = await copyForDrill(source)
  const outcome = await Effect.runPromise(runDrill(database).pipe(Effect.exit))
  if (Exit.isFailure(outcome)) {
    console.error(`REL-001 drill FAILED: ${outcome.cause}`)
    process.exit(1)
  }
  console.log("REL-001 summary: PASS")
}
