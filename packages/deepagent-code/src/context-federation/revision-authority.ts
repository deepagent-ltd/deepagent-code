export * as LiveContextLinkRevisionAuthority from "./revision-authority"

import { ContextLinkStore } from "@deepagent-code/core/context-federation/link-store"
import { ContextReference } from "@deepagent-code/core/context-federation/reference"
import { Effect, Layer } from "effect"
import { LocationIndexRuntime } from "../location-index/runtime"

export const layer = Layer.effect(
  ContextLinkStore.RevisionAuthority,
  Effect.gen(function* () {
    const runtime = yield* LocationIndexRuntime.Service

    const isCurrent: ContextLinkStore.RevisionAuthorityInterface["isCurrent"] = (input) =>
      Effect.gen(function* () {
        const handle = yield* runtime.current()
        if (!handle) return false
        const current = input.revision.projectionKind === "code"
          ? (yield* handle.coordinator.codeStatus()).revision
          : (yield* handle.coordinator.searchDocuments({ query: "", limit: 0 })).revision
        return Boolean(current && ContextReference.sameProjectionRevision(current, input.revision))
      }).pipe(Effect.catch(() => Effect.succeed(false)))

    const withCurrent: ContextLinkStore.RevisionAuthorityInterface["withCurrent"] = (input, use) =>
      Effect.gen(function* () {
        if (!(yield* isCurrent(input))) return yield* new ContextLinkStore.RevisionChangedError()
        const result = yield* use
        if (!(yield* isCurrent(input))) return yield* new ContextLinkStore.RevisionChangedError()
        return result
      })

    return ContextLinkStore.RevisionAuthority.of({ isCurrent, withCurrent })
  }),
)
