export * as EventInvestigationRead from "./event-investigation-read"

import { Effect } from "effect"
import { EventInvestigation } from "@deepagent-code/core/deepagent/event-investigation"
import { EventInvestigationSchema } from "@deepagent-code/core/deepagent/event-investigation.schema"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { WorkAuthoritySchema } from "@deepagent-code/core/session/work-authority.schema"
import { WorkFileCapability } from "@deepagent-code/core/session/work-file-capability"
import { EventInvestigationEvidence } from "./event-investigation-evidence"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"

/** Wrap the existing native owner; opaque Root/Observation identity stays with that owner.
 * The callbacks are captured production source checks, never caller-supplied JSON proof. */
export function wrap(
  native: WorkFileCapability.Interface,
  source: {
    readonly manifest: (
      binding: WorkAuthoritySchema.ProjectBinding,
      controlRevision: number,
    ) => Effect.Effect<EventInvestigationSchema.Receipt, WorkFileCapability.Error>
    readonly changed: (binding: WorkAuthoritySchema.ProjectBinding) => Effect.Effect<void, WorkFileCapability.Error>
  },
): WorkFileCapability.Interface {
  const roots = new WeakMap<
    WorkFileCapability.Root,
    {
      binding: WorkAuthoritySchema.ProjectBinding
      controlRevision: number
    }
  >()
  return {
    ...native,
    open: Effect.fn("EventInvestigationRead.open")(function* (input) {
      if (input.binding.profile.id !== WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE.id)
        return yield* native.open(input)
      yield* source.manifest(input.binding, input.controlRevision)
      const root = yield* native.open(input)
      roots.set(root, input)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          roots.delete(root)
        }),
      )
      return root
    }),
    current: (root) =>
      Effect.gen(function* () {
        const input = roots.get(root)
        yield* native.current(root)
        if (input) yield* source.manifest(input.binding, input.controlRevision)
      }),
    read: (root, input) =>
      Effect.gen(function* () {
        const captured = roots.get(root)
        if (!captured) return yield* native.read(root, input)
        return yield* Effect.gen(function* () {
          const receipt = yield* source.manifest(captured.binding, captured.controlRevision)
          const expected = EventInvestigation.expectedFile(receipt, input.relative)
          if (!expected)
            return yield* new WorkFileCapability.Error({
              code: "WORK_FILE_CHANGED",
              message: "Read is absent from the original investigation manifest",
            })
          const result = yield* native.read(root, input)
          const actual = native.describe(root, result.observation)
          if (
            !actual ||
            actual.workID !== captured.binding.workID ||
            actual.bindingHash !== WorkAuthorityPolicy.fingerprint(captured.binding) ||
            actual.controlRevision !== captured.controlRevision ||
            actual.helperHash !== captured.binding.projectScope.helperHash ||
            CanonicalJson.stringify(actual.rootIdentity) !==
              CanonicalJson.stringify(captured.binding.projectScope.rootIdentity)
          )
            return yield* new WorkFileCapability.Error({
              code: "WORK_FILE_CHANGED",
              message: "The native owner cannot authenticate this read observation",
            })
          yield* Effect.try({
            try: () => EventInvestigationEvidence.requireManifestRead(expected, actual),
            catch: () =>
              new WorkFileCapability.Error({
                code: "WORK_FILE_CHANGED",
                message: "Native read differs from the failed version",
              }),
          })
          // Revalidate source/control after the physical observation, before releasing any text.
          yield* source.manifest(captured.binding, captured.controlRevision)
          return result
        }).pipe(
          Effect.catch((error) =>
            error.code === "WORK_FILE_CHANGED"
              ? source.changed(captured.binding).pipe(Effect.andThen(() => Effect.fail(error)))
              : Effect.fail(error),
          ),
        )
      }),
  }
}
