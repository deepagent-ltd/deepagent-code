export * as SessionSchema from "./schema"

import { Schema } from "effect"
import { LocationRef } from "../location/ref"
import { ModelRef } from "../model/ref"
// Deep import: project.ts owns the drizzle edges; the ID schema alone is dependency-free.
import { ProjectID } from "../project/id"
import { RelativePath, optionalOmitUndefined, withStatics } from "../schema"
import { externalID, type ExternalID } from "../schema/external-id"
import { Identifier } from "../util/identifier"
import { V2Schema } from "../v2-schema"
import { AgentID } from "../agent/id"
import { PermissionSchema } from "../permission/schema"

export const ID = Schema.String.check(Schema.isStartsWith("ses")).pipe(
  Schema.brand("SessionID"),
  withStatics((schema) => {
    const create = () => schema.make("ses_" + Identifier.descending())
    return {
      create,
      descending: (id?: string) => (id === undefined ? create() : schema.make(id)),
      fromExternal: (input: ExternalID) => schema.make(externalID("ses", input)),
    }
  }),
)
export type ID = typeof ID.Type

export class Info extends Schema.Class<Info>("SessionV2.Info")({
  id: ID,
  parentID: ID.pipe(optionalOmitUndefined),
  projectID: ProjectID.ID,
  agent: AgentID.ID.pipe(Schema.optional),
  permissions: PermissionSchema.Ruleset,
  model: ModelRef.Ref.pipe(Schema.optional),
  cost: Schema.Finite,
  tokens: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({
      read: Schema.Finite,
      write: Schema.Finite,
    }),
  }),
  time: Schema.Struct({
    created: V2Schema.DateTimeUtcFromMillis,
    updated: V2Schema.DateTimeUtcFromMillis,
    archived: V2Schema.DateTimeUtcFromMillis.pipe(Schema.optional),
  }),
  title: Schema.String,
  location: LocationRef.Ref,
  subpath: RelativePath.pipe(Schema.optional),
}) {}
