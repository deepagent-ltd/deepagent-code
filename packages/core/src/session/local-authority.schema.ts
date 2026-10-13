export * as LocalAuthoritySchema from "./local-authority.schema"

import { Schema } from "effect"
import { WorkAuthoritySchema } from "./work-authority.schema"

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Revision = Count.check(Schema.isGreaterThan(0))
export const Principal = Schema.Struct({
  instanceID: Text,
  actorID: Text,
  revision: Revision,
  identityHash: WorkAuthoritySchema.Digest,
})
export type Principal = typeof Principal.Type

export const LegacyTarget = Schema.Struct({
  scope: WorkAuthoritySchema.LegacyBinding.fields.scope,
  location: WorkAuthoritySchema.Location,
  agentID: Text,
  profile: WorkAuthoritySchema.LegacyBinding.fields.profile,
  provider: WorkAuthoritySchema.ProviderRoute,
  budget: WorkAuthoritySchema.Budget,
  durationMs: Revision,
})
export const ProjectTarget = Schema.Struct({
  ...LegacyTarget.fields,
  version: Schema.Literal(2),
  profile: WorkAuthoritySchema.ProjectBinding.fields.profile,
  projectScope: WorkAuthoritySchema.ProjectBinding.fields.projectScope,
  contextPolicy: WorkAuthoritySchema.ProjectBinding.fields.contextPolicy,
  toolPolicy: WorkAuthoritySchema.ProjectBinding.fields.toolPolicy,
  childPolicy: WorkAuthoritySchema.ProjectBinding.fields.childPolicy,
})
export const Target = Schema.Union([LegacyTarget, ProjectTarget])
export type Target = typeof Target.Type

export const TargetProof = Schema.Struct({
  revision: Revision,
  recordHash: WorkAuthoritySchema.Digest,
  targetHash: WorkAuthoritySchema.Digest,
})
export type TargetProof = typeof TargetProof.Type
