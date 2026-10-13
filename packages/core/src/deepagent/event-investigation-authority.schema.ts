export * as EventInvestigationAuthoritySchema from "./event-investigation-authority.schema"

import { Schema } from "effect"
import { LocalAuthoritySchema } from "../session/local-authority.schema"
import { WorkAuthorityPolicy } from "../session/work-authority-policy"
import { WorkAuthoritySchema } from "../session/work-authority.schema"
import { CanonicalJson } from "../util/canonical-json"

export const MAX_GRANT_BYTES = 32_768
const ID = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512),
  Schema.makeFilter((value: string) => Buffer.byteLength(value) <= 512 && !/[\u0000-\u001f\u007f]/.test(value)))
const Positive = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))

/** Independent operator authority. It is excluded from deterministic validation configHash. */
export const Grant = Schema.Struct({
  version: Schema.Literal(1), grantID: ID, epoch: Positive, ruleID: ID,
  principal: LocalAuthoritySchema.Principal,
  credentialGeneration: Positive, policyRevision: Positive, policyHash: WorkAuthoritySchema.Digest,
  targetID: ID, target: LocalAuthoritySchema.ProjectTarget,
  scopeHash: WorkAuthoritySchema.Digest, createdAt: Positive, expiresAt: Positive,
}).check(Schema.makeFilter((value) =>
  Buffer.byteLength(CanonicalJson.stringify(value)) <= MAX_GRANT_BYTES && value.expiresAt > value.createdAt &&
  value.target.profile.id === WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE.id &&
  WorkAuthorityPolicy.profileFor(value.target.profile)?.id === WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE.id &&
  WorkAuthorityPolicy.checkInvestigationPolicy(value.target).ok &&
  WorkAuthorityPolicy.checkBudgetCeiling(WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE.budget, value.target.budget).ok &&
  value.target.durationMs <= value.target.budget.maxDurationMs &&
  value.target.scope.actorID === value.principal.actorID))
export type Grant = typeof Grant.Type

const Fields = { version: Schema.Literal(1), epoch: Positive, updatedAt: Positive }
export const Authority = Schema.Union([
  Schema.Struct({ ...Fields, state: Schema.Literal("disabled"), grant: Schema.Null }),
  Schema.Struct({ ...Fields, state: Schema.Literal("enabled"), grant: Grant }),
]).check(Schema.makeFilter((value) => value.state === "disabled" || value.grant.epoch === value.epoch))
export type Authority = typeof Authority.Type
