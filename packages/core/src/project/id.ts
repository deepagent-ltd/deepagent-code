export * as ProjectID from "./id"

import { Schema } from "effect"
import { withStatics } from "../schema"

// Schema-only Project ID, dependency-free (effect + schema util alone). Extracted from
// project.ts (which owns the drizzle/sql edges) so schema modules that need only the ID
// (session/schema.ts) don't drag the database layer into browser-reachable bundles.
export const ID = Schema.String.pipe(
  Schema.brand("Project.ID"),
  withStatics((schema) => ({
    global: schema.make("global"),
  })),
)
export type ID = typeof ID.Type
