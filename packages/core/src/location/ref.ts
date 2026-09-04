export * as LocationRef from "./ref"

import { Schema } from "effect"
import { AbsolutePath } from "../schema"
import { WorkspaceV2 } from "../workspace"

// Schema-only Location Ref, free of the Project.Service edge location.ts owns, so
// schema modules (session/schema.ts) don't drag services into browser bundles.
export const Ref = Schema.Struct({
  directory: AbsolutePath,
  workspaceID: Schema.optional(WorkspaceV2.ID),
}).annotate({ identifier: "Location.Ref" })
export type Ref = typeof Ref.Type
