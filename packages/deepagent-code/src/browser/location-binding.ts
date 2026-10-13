import { Effect } from "effect"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { projectIdForWorkspace } from "@deepagent-code/core/deepagent/durable-knowledge-store"

export const scopeDenied = (stage: "native_transport" | "native_origin" | "session_placement" |
  "project_observation" | "project_resolution" | "project_current" | "location_resolution" |
  "location_current" | "namespace_current" | "control_scope") =>
  new BrowserSchema.Error({ code: "BROWSER_SCOPE_DENIED", message: `BROWSER_CREATE_SCOPE_DENIED:${stage}` })

/** Reconcile the two original registered-root observers without rewriting either identity.
 * The full current lookup still verifies canonical root, namespace binding and retirement.
 * BrowserControl.create rechecks the complete Session/namespace/project chain in its own TX. */
export const resolveBrowserLocation = Effect.fn("Browser.resolveCurrentLocation")(function* (input: {
  identity: LocationIdentity.Interface
  directory: AbsolutePath
  projectID: string
  git: boolean
}) {
  if (!input.git && input.projectID !== "global") return yield* scopeDenied("project_current")
  const canonicalProjectID = input.git ? input.projectID : projectIdForWorkspace(input.directory)
  const binding = { boundary: { kind: "implicit_local" as const }, directory: input.directory,
    project: input.git ? { kind: "git" as const, observedProjectId: canonicalProjectID }
      : { kind: "registered_root" as const, observedProjectId: canonicalProjectID } }
  const resolved = yield* input.identity.resolve(binding).pipe(Effect.mapError(() => scopeDenied("location_resolution")))
  const observedProjectID = resolved.observedProjectId
  if (typeof observedProjectID !== "string" || resolved.canonicalRoot !== input.directory ||
    (input.git ? observedProjectID !== input.projectID
      : observedProjectID !== canonicalProjectID && observedProjectID !== input.projectID))
    return yield* scopeDenied("location_current")
  const current = yield* input.identity.lookup({ ...binding,
    project: { ...binding.project, observedProjectId: observedProjectID } }).pipe(
      Effect.mapError(() => scopeDenied("location_current")))
  if (current.securityNamespaceId !== resolved.securityNamespaceId || current.locationKey !== resolved.locationKey ||
    current.projectScopeKey !== resolved.projectScopeKey || current.canonicalRoot !== resolved.canonicalRoot ||
    current.observedProjectId !== resolved.observedProjectId)
    return yield* scopeDenied("location_current")
  return current
})
