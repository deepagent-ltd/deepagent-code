// Historical restricted IM task records are decoded for read-only inspection.
// This module declares no HTTP endpoints and does not admit or execute work.
import { Schema } from "effect"
import { WorkAuthoritySchema } from "@deepagent-code/core/session/work-authority.schema"
import { IMTaskAuthoritySchema } from "@deepagent-code/core/im/task-authority.schema"
import { KernelDeliverySchema } from "@deepagent-code/core/im/kernel-delivery.schema"
import { IMTaskStatusNoticeSchema } from "@deepagent-code/core/im/task-status-notice.schema"

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Directory = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))
export const TargetReview = Schema.Struct({
  targetID: Schema.NullOr(Text),
  projectID: Schema.NullOr(Text),
  directory: Directory,
  workspaceID: Schema.NullOr(Text),
  agentID: Text,
  profile: Schema.Struct({ id: Text, version: Revision, hash: WorkAuthoritySchema.Digest }),
  budget: WorkAuthoritySchema.Budget,
  durationMs: Revision,
  tools: Schema.Struct({
    capabilities: Schema.Array(Schema.Struct({ toolID: Text, operations: Schema.Array(Schema.String) })),
    fileScope: Schema.NullOr(WorkAuthoritySchema.ProjectBinding.fields.toolPolicy.fields.fileScope),
    commands: Schema.Array(Schema.Struct({ id: Text, revision: Revision, hash: WorkAuthoritySchema.Digest })),
    integrations: Schema.Array(Schema.Struct({
      kind: Schema.Literals(["mcp", "browser", "network"]), resources: Schema.Array(Text),
    })),
    children: WorkAuthoritySchema.ProjectBinding.fields.childPolicy,
  }),
}).annotate({ identifier: "IMTaskTargetReview" })
export const RequestView = Schema.Struct({
  id: Text,
  state: Schema.Literals(["proposed", "accepted"]),
  disposition: Schema.optional(Schema.Literals(["open", "refused"])),
  refusal: Schema.optional(IMTaskStatusNoticeSchema.RefuseReceipt),
  revision: Revision,
  auditedText: Schema.String,
  expiresAt: Schema.Int,
  agentID: Text,
  targetDirectory: Directory,
  review: Schema.Struct({
    instanceID: Text,
    source: Schema.Struct({ messageID: Text, groupID: Text, senderID: Text }),
    target: TargetReview,
  }),
  execution: Schema.Literals([
    "not_admitted",
    "reserved",
    "ready",
    "succeeded",
    "failed",
    "unknown",
    "recovery_required",
  ]),
  hasExecutionClaim: Schema.Boolean,
  admission: Schema.NullOr(Schema.Literals(["reserved", "ready", "rejected"])),
  workID: Schema.NullOr(Text),
  sessionID: Schema.NullOr(Text),
  inputID: Schema.NullOr(Text),
  control: Schema.NullOr(WorkAuthoritySchema.ControlState),
})
export const TaskState = Schema.Struct({
  version: Schema.Literal(1), requestID: Text, requestRevision: Revision, instanceID: Text,
  disposition: Schema.optional(Schema.Literals(["open", "refused"])),
  source: Schema.NullOr(Schema.Struct({
    messageID: Text, senderID: Text, origin: IMTaskAuthoritySchema.SourceProof.fields.origin,
    groupID: Schema.NullOr(Text),
  })),
  targetScope: Schema.Struct({ directory: Directory, workspaceID: Schema.NullOr(Text), agentID: Text }),
  grant: Schema.NullOr(Schema.Struct({
    state: IMTaskAuthoritySchema.GrantState, revision: Revision, expiresAt: Revision,
  })),
  work: Schema.NullOr(Schema.Struct({
    workID: Text, sessionID: Text, inputID: Text,
    admissionState: WorkAuthoritySchema.AdmissionState, controlState: WorkAuthoritySchema.ControlState,
    controlRevision: Revision, outcome: WorkAuthoritySchema.Outcome,
    hasExecutionClaim: Schema.Boolean, processActive: Schema.Boolean,
    sessionRecoveryRequired: Schema.Boolean, countUnknown: Revision,
    countSendingExpired: Revision, dispatchUnknown: Revision, recoveryRequired: Schema.Boolean,
  })),
  delivery: Schema.Struct({
    outboxStatus: Schema.NullOr(Schema.Literals(["pending", "delivering", "delivered", "dead"])),
    attempts: Revision, receiptState: Schema.NullOr(KernelDeliverySchema.State),
  }),
}).annotate({ identifier: "IMTaskState" })
