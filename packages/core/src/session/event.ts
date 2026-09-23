import { Schema } from "effect"
// Deep import: the llm barrel exports route/client (node transport) — browser bundles
// reachable via app → legacy-wire → event cannot parse it.
import { ProviderMetadata } from "@deepagent-code/llm/schema"
// Deep import: the ../event barrel owns the drizzle/database service layer; the schema
// factory alone lives in event/define (browser bundles reach this module via legacy-wire).
import { EventV2 } from "../event/define"
import { ModelRef } from "../model/ref"
import { NonNegativeInt } from "../schema"
import { ToolOutput } from "../tool-output"
import { V2Schema } from "../v2-schema"
import { FileAttachment, Prompt } from "./prompt"
import { SessionSchema } from "./schema"
import { LocationRef } from "../location/ref"
import { RelativePath } from "../schema"
import { SessionMessageID } from "./message-id"

export { FileAttachment }

export const Source = Schema.Struct({
  start: NonNegativeInt,
  end: NonNegativeInt,
  text: Schema.String,
}).annotate({
  identifier: "session.next.event.source",
})
export type Source = typeof Source.Type

const Base = {
  timestamp: V2Schema.DateTimeUtcFromMillis,
  sessionID: SessionSchema.ID,
}

const options = {
  sync: {
    aggregate: "sessionID",
    version: 1,
  },
} as const
const stepSettlementOptions = {
  sync: {
    aggregate: "sessionID",
    version: 2,
  },
} as const

/**
 * Native V2 creation authority. Version 1 of `session.created` remains decodable as the
 * compatibility/import wire event, while all new V2 Sessions start with this version 2 fact.
 */
export const Created = EventV2.define({
  type: "session.created",
  sync: {
    aggregate: "sessionID",
    version: 2,
  },
  schema: {
    sessionID: SessionSchema.ID,
    info: SessionSchema.Info,
    slug: Schema.String,
    version: Schema.String,
  },
})
export type Created = typeof Created.Type

/**
 * Native V2 update authority for the Session info fields `SessionSchema.Info` models (title,
 * agent, model, cost, tokens, permissions, metadata, share, preview, parent, time.updated,
 * time.archived). Summary and revert have independent V2 event authorities (`session.diff.2` and
 * `session.revert.1`) so this update cannot erase their state. Version 1 of `session.updated`
 * remains decodable as the compatibility/import wire event. `slug`/`version`
 * mirror the created event: they are immutable identity attributes the client egress adapter needs
 * to rebuild the legacy shape.
 */
export const Updated = EventV2.define({
  type: "session.updated",
  sync: {
    aggregate: "sessionID",
    version: 2,
  },
  schema: {
    sessionID: SessionSchema.ID,
    info: SessionSchema.Info,
    slug: Schema.String,
    version: Schema.String,
  },
})
export type Updated = typeof Updated.Type

/**
 * Native V2 diff authority. The summary is metadata-only and the independent `diff` payload keeps
 * file descriptors/artifacts out of SessionSchema.Info. Version 1 remains the legacy ephemeral
 * compatibility shape in DeepAgentCode; both versions share the `session.diff` event family.
 */
export const DiffUpdated = EventV2.define({
  type: "session.diff",
  sync: {
    aggregate: "sessionID",
    version: 2,
  },
  schema: {
    ...Base,
    summary: SessionSchema.Summary,
    diff: Schema.Array(SessionSchema.FileDiff),
  },
})
export type DiffUpdated = typeof DiffUpdated.Type

/** Native V2 revert authority. `null` is an explicit unrevert and mutationEpoch is a CAS fence. */
export const RevertChanged = EventV2.define({
  type: "session.revert",
  sync: {
    aggregate: "sessionID",
    version: 1,
  },
  schema: {
    ...Base,
    info: SessionSchema.Info,
    slug: Schema.String,
    version: Schema.String,
    mutationEpoch: NonNegativeInt,
    revert: Schema.NullOr(SessionSchema.Revert),
    summary: SessionSchema.Summary.pipe(Schema.optional),
  },
})
export type RevertChanged = typeof RevertChanged.Type

/**
 * Native V2 deletion authority. The full V2 info mirror is carried so the compatibility egress
 * can still emit the legacy `session.deleted.1` payload, while the durable event itself remains
 * terminal and installs the aggregate deletion fence.
 */
export const Deleted = EventV2.define({
  type: "session.deleted",
  sync: {
    aggregate: "sessionID",
    version: 2,
  },
  schema: {
    sessionID: SessionSchema.ID,
    info: SessionSchema.Info,
    slug: Schema.String,
    version: Schema.String,
  },
})
export type Deleted = typeof Deleted.Type

export const UnknownError = Schema.Struct({
  type: Schema.Literal("unknown"),
  message: Schema.String,
}).annotate({
  identifier: "Session.Error.Unknown",
})
export type UnknownError = typeof UnknownError.Type

/**
 * Tool-call failure classification. `unknown` is the default for unclassified failures; the
 * `permission_*` types are derived from the settlement's structured failureCode (a rejected or
 * rule-denied permission prompt) so consumers can distinguish user refusals from other errors.
 */
export const ToolCallError = Schema.Struct({
  type: Schema.Literals(["unknown", "permission_rejected", "permission_corrected", "permission_denied"]),
  message: Schema.String,
}).annotate({
  identifier: "Session.Error.ToolCall",
})
export type ToolCallError = typeof ToolCallError.Type

export const AgentSwitched = EventV2.define({
  type: "session.next.agent.switched",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessageID.ID,
    agent: Schema.String,
  },
})
export type AgentSwitched = typeof AgentSwitched.Type

export const ModelSwitched = EventV2.define({
  type: "session.next.model.switched",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessageID.ID,
    model: ModelRef.Ref,
  },
})
export type ModelSwitched = typeof ModelSwitched.Type

export const PermissionsChanged = EventV2.define({
  type: "session.next.permissions.changed",
  ...options,
  schema: {
    ...Base,
    permissions: SessionSchema.Info.fields.permissions,
  },
})
export type PermissionsChanged = typeof PermissionsChanged.Type

export const Moved = EventV2.define({
  type: "session.next.moved",
  ...options,
  schema: {
    ...Base,
    location: LocationRef.Ref,
    subdirectory: RelativePath.pipe(Schema.optional),
  },
})
export type Moved = typeof Moved.Type

export const Prompted = EventV2.define({
  type: "session.next.prompted",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessageID.ID,
    prompt: Prompt,
    // Mirrors SessionInput.Delivery (input.ts). `goal_steer` (§S1.3) never actually travels this dormant
    // V2 event path — it is written directly to the session_steer table — but the literal stays a superset
    // so the union is consistent and a future producer cannot silently narrow it.
    delivery: Schema.Literals(["steer", "queue", "goal_steer"]),
  },
})
export type Prompted = typeof Prompted.Type

export namespace PromptLifecycle {
  export const Admitted = EventV2.define({
    type: "session.next.prompt.admitted",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessageID.ID,
      prompt: Prompt,
      // Superset of SessionInput.Delivery; `goal_steer` (§S1.3) does not flow this dormant V2 path.
      delivery: Schema.Literals(["steer", "queue", "goal_steer"]),
      revertEpoch: NonNegativeInt.pipe(Schema.optional),
    },
  })
  export type Admitted = typeof Admitted.Type

  export const Promoted = EventV2.define({
    type: "session.next.prompt.promoted",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessageID.ID,
      prompt: Prompt,
      timeCreated: V2Schema.DateTimeUtcFromMillis,
    },
  })
  export type Promoted = typeof Promoted.Type
}

export const InterruptRequested = EventV2.define({
  type: "session.next.interrupt.requested",
  ...options,
  schema: Base,
})
export type InterruptRequested = typeof InterruptRequested.Type

export namespace Execution {
  export const Started = EventV2.define({
    type: "session.execution.started",
    ...options,
    schema: Base,
  })
  export type Started = typeof Started.Type

  export const Succeeded = EventV2.define({
    type: "session.execution.succeeded",
    ...options,
    schema: Base,
  })
  export type Succeeded = typeof Succeeded.Type

  export const Failed = EventV2.define({
    type: "session.execution.failed",
    ...options,
    schema: {
      ...Base,
      error: UnknownError,
    },
  })
  export type Failed = typeof Failed.Type

  export const Interrupted = EventV2.define({
    type: "session.execution.interrupted",
    ...options,
    schema: {
      ...Base,
      reason: Schema.Literals(["user", "shutdown", "superseded"]),
    },
  })
  export type Interrupted = typeof Interrupted.Type
}

/** One durable diagnosis for a loop stop or an interrupted tool with unknown side effects. */
export namespace LoopBudget {
  export const Triggered = EventV2.define({
    type: "session.loop.budget.triggered",
    ...options,
    schema: {
      ...Base,
      activityID: Schema.String,
      reason: Schema.Literals(["steps", "repeated_tool", "orphan_effect"]),
      limit: NonNegativeInt.pipe(Schema.optional),
      used: NonNegativeInt.pipe(Schema.optional),
      tool: Schema.String.pipe(Schema.optional),
      inputHash: Schema.String.pipe(Schema.optional),
      effectIDs: Schema.Array(Schema.String).pipe(Schema.optional),
    },
  })
  export type Triggered = typeof Triggered.Type
}

/**
 * G2/G-E — the durable delivery receipt. The finalizer's verdict used to exist only as a stderr
 * line, so "why was this work not delivered, and where is it now?" could not be answered after the
 * fact. Round-7 proved the cost: the model committed to a side branch, the runtime saw a clean
 * worktree, logged `no changes to deliver`, and nothing recorded that deliverable work existed but
 * was not on the graded branch. The receipt makes the delivery decision a replayable fact:
 * the verdict, the branch and HEAD either side of the activity, the attributable paths, and the
 * reference to recover work the runtime did NOT deliver.
 */
export namespace Delivery {
  export const Recorded = EventV2.define({
    type: "session.delivery.recorded",
    ...options,
    schema: {
      ...Base,
      activityID: Schema.String,
      verdict: Schema.Literals([
        "committed",
        "no_changes",
        "no_changes_on_this_branch",
        "withheld_unverified",
        "withheld_validation_failed",
        "skipped",
      ]),
      branch: Schema.String.pipe(Schema.optional),
      headBefore: Schema.String.pipe(Schema.optional),
      headAfter: Schema.String.pipe(Schema.optional),
      touchedPaths: Schema.Number,
      /** Files whose changes could not be attributed to this activity (e.g. bash side effects). */
      unattributable: Schema.Number,
      commit: Schema.String.pipe(Schema.optional),
      /** Branch/commit a caller can use to recover work this receipt did not deliver. */
      recoveryRef: Schema.String.pipe(Schema.optional),
      reason: Schema.String.pipe(Schema.optional),
    },
  })
  export type Recorded = typeof Recorded.Type
}

/**
 * Capability mode — how much runtime machinery this session is worth. Recorded as a durable fact
 * because it is a DECISION, and an undecidable decision cannot be tuned: today the only consumer of
 * the complexity engine is the fan-out gate, so "how much machinery" is implicit and invisible.
 *
 * `source` separates the two authorities the design keeps apart: the explicit tier the user or
 * deployment configured (`explicit`), and the experimental estimate/promotion (`estimated`,
 * `promoted`). Every resolution is recorded even while auto-detection is off, so the estimate's
 * accuracy can be measured from real sessions before anything acts on it.
 */
export namespace CapabilityMode {
  export const Recorded = EventV2.define({
    type: "session.capability.mode.recorded",
    ...options,
    schema: {
      ...Base,
      mode: Schema.Literals(["quick", "standard", "deep"]),
      source: Schema.Literals(["explicit", "estimated", "promoted"]),
      /** The configured tier's mode, recorded even when it did not win. */
      explicitMode: Schema.Literals(["quick", "standard", "deep"]),
      /** What the runtime's own estimate would have chosen. */
      estimatedMode: Schema.Literals(["quick", "standard", "deep"]),
      /** 0..3, straight from the orchestration complexity engine. */
      complexity: Schema.Number,
      /** Promotion signal names (`files_mutated>=4`, …); empty when nothing promoted. */
      reasons: Schema.Array(Schema.String),
      /** Whether the experimental auto-detection switch was on for this resolution. */
      autoDetect: Schema.Boolean,
    },
  })
  export type Recorded = typeof Recorded.Type
}

export const ContextUpdated = EventV2.define({
  type: "session.next.context.updated",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessageID.ID,
    text: Schema.String,
  },
})
export type ContextUpdated = typeof ContextUpdated.Type

export const Synthetic = EventV2.define({
  type: "session.next.synthetic",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessageID.ID,
    text: Schema.String,
  },
})
export type Synthetic = typeof Synthetic.Type

// RI-126: the runner captured the turn's structured-output value (synthetic StructuredOutput
// tool call input, or the schema-constrained final text parsed on a wire-format route). The
// value lands on the projected assistant message (`structured`) and the V1 wire info.
export const StructuredCaptured = EventV2.define({
  type: "session.next.structured.captured",
  ...options,
  schema: {
    ...Base,
    assistantMessageID: SessionMessageID.ID,
    value: Schema.Unknown,
  },
})
export type StructuredCaptured = typeof StructuredCaptured.Type

export namespace Shell {
  export const Started = EventV2.define({
    type: "session.next.shell.started",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessageID.ID,
      callID: Schema.String,
      command: Schema.String,
    },
  })
  export type Started = typeof Started.Type

  export const Ended = EventV2.define({
    type: "session.next.shell.ended",
    ...options,
    schema: {
      ...Base,
      callID: Schema.String,
      output: Schema.String,
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Step {
  export const Started = EventV2.define({
    type: "session.next.step.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      agent: Schema.String,
      model: ModelRef.Ref,
      snapshot: Schema.String.pipe(Schema.optional),
    },
  })
  export type Started = typeof Started.Type

  export const Ended = EventV2.define({
    type: "session.next.step.ended",
    ...stepSettlementOptions,
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      finish: Schema.String,
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
      snapshot: Schema.String.pipe(Schema.optional),
    },
  })
  export type Ended = typeof Ended.Type

  export const Failed = EventV2.define({
    type: "session.next.step.failed",
    ...stepSettlementOptions,
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      error: UnknownError,
    },
  })
  export type Failed = typeof Failed.Type
}

export namespace Text {
  export const Started = EventV2.define({
    type: "session.next.text.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      textID: Schema.String,
    },
  })
  export type Started = typeof Started.Type

  // Stream fragments are live-only; Text.Ended is the replayable full-value boundary.
  export const Delta = EventV2.define({
    type: "session.next.text.delta",
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      textID: Schema.String,
      delta: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = EventV2.define({
    type: "session.next.text.ended",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      textID: Schema.String,
      text: Schema.String,
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Reasoning {
  export const Started = EventV2.define({
    type: "session.next.reasoning.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      reasoningID: Schema.String,
      providerMetadata: ProviderMetadata.pipe(Schema.optional),
    },
  })
  export type Started = typeof Started.Type

  // Stream fragments are live-only; Reasoning.Ended is the replayable full-value boundary.
  export const Delta = EventV2.define({
    type: "session.next.reasoning.delta",
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      reasoningID: Schema.String,
      delta: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = EventV2.define({
    type: "session.next.reasoning.ended",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      reasoningID: Schema.String,
      text: Schema.String,
      providerMetadata: ProviderMetadata.pipe(Schema.optional),
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Tool {
  const ToolBase = {
    ...Base,
    assistantMessageID: SessionMessageID.ID,
    callID: Schema.String,
  }

  export namespace Input {
    export const Started = EventV2.define({
      type: "session.next.tool.input.started",
      ...options,
      schema: {
        ...ToolBase,
        name: Schema.String,
      },
    })
    export type Started = typeof Started.Type

    // Stream fragments are live-only; Input.Ended is the replayable raw-input boundary.
    export const Delta = EventV2.define({
      type: "session.next.tool.input.delta",
      schema: {
        ...ToolBase,
        delta: Schema.String,
      },
    })
    export type Delta = typeof Delta.Type

    export const Ended = EventV2.define({
      type: "session.next.tool.input.ended",
      ...options,
      schema: {
        ...ToolBase,
        text: Schema.String,
      },
    })
    export type Ended = typeof Ended.Type
  }

  export const Called = EventV2.define({
    type: "session.next.tool.called",
    ...options,
    schema: {
      ...ToolBase,
      tool: Schema.String,
      input: Schema.Record(Schema.String, Schema.Unknown),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(Schema.optional),
      }),
    },
  })
  export type Called = typeof Called.Type

  /**
   * Replayable bounded running-tool state. Tools should checkpoint semantic
   * transitions or at a bounded cadence, not persist every stdout/stderr chunk.
   */
  export const Progress = EventV2.define({
    type: "session.next.tool.progress",
    ...options,
    schema: {
      ...ToolBase,
      structured: ToolOutput.Structured,
      content: Schema.Array(ToolOutput.Content),
    },
  })
  export type Progress = typeof Progress.Type

  export const Success = EventV2.define({
    type: "session.next.tool.success",
    ...options,
    schema: {
      ...ToolBase,
      structured: ToolOutput.Structured,
      content: Schema.Array(ToolOutput.Content),
      outputPaths: Schema.Array(Schema.String).pipe(Schema.optional),
      result: Schema.Unknown.pipe(Schema.optional),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(Schema.optional),
      }),
    },
  })
  export type Success = typeof Success.Type

  export const Failed = EventV2.define({
    type: "session.next.tool.failed",
    ...options,
    schema: {
      ...ToolBase,
      error: ToolCallError,
      result: Schema.Unknown.pipe(Schema.optional),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(Schema.optional),
      }),
    },
  })
  export type Failed = typeof Failed.Type
}

export const RetryError = Schema.Struct({
  message: Schema.String,
  statusCode: Schema.Finite.pipe(Schema.optional),
  isRetryable: Schema.Boolean,
  responseHeaders: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  responseBody: Schema.String.pipe(Schema.optional),
  metadata: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
}).annotate({
  identifier: "session.next.retry_error",
})
export type RetryError = typeof RetryError.Type

export const Retried = EventV2.define({
  type: "session.next.retried",
  ...options,
  schema: {
    ...Base,
    attempt: Schema.Finite,
    error: RetryError,
  },
})
export type Retried = typeof Retried.Type

export namespace Compaction {
  export const Started = EventV2.define({
    type: "session.next.compaction.started",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessageID.ID,
      reason: Schema.Union([
        Schema.Literal("auto"),
        Schema.Literal("manual"),
        Schema.Literal("hard_gate"),
        Schema.Literal("provider_overflow"),
      ]),
    },
  })
  export type Started = typeof Started.Type

  export const Delta = EventV2.define({
    type: "session.next.compaction.delta",
    schema: {
      ...Base,
      messageID: SessionMessageID.ID,
      text: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  // Retain the unpublished v1 decoder so stored beta events remain replayable.
  export const EndedV1 = EventV2.define({
    type: "session.next.compaction.ended",
    ...options,
    schema: {
      ...Base,
      text: Schema.String,
      include: Schema.String.pipe(Schema.optional),
    },
  })

  export const Ended = EventV2.define({
    type: "session.next.compaction.ended",
    sync: { aggregate: "sessionID", version: 2 },
    schema: {
      ...Base,
      messageID: SessionMessageID.ID,
      reason: Started.data.fields.reason,
      text: Schema.String,
      recent: Schema.String,
      checkpointID: Schema.String.pipe(Schema.optional),
      checkpointHash: Schema.String.pipe(Schema.optional),
    },
  })
  export type Ended = typeof Ended.Type
}

const DurableDefinitions = [
  Created,
  Updated,
  DiffUpdated,
  RevertChanged,
  Deleted,
  AgentSwitched,
  ModelSwitched,
  PermissionsChanged,
  Moved,
  Prompted,
  PromptLifecycle.Admitted,
  PromptLifecycle.Promoted,
  InterruptRequested,
  Execution.Started,
  Execution.Succeeded,
  Execution.Failed,
  Execution.Interrupted,
  LoopBudget.Triggered,
  ContextUpdated,
  Synthetic,
  StructuredCaptured,
  Shell.Started,
  Shell.Ended,
  Step.Started,
  Step.Ended,
  Step.Failed,
  Text.Started,
  Text.Ended,
  Tool.Input.Started,
  Tool.Input.Ended,
  Tool.Called,
  Tool.Progress,
  Tool.Success,
  Tool.Failed,
  Reasoning.Started,
  Reasoning.Ended,
  Retried,
  Compaction.Started,
  Compaction.Ended,
] as const
const EphemeralDefinitions = [Text.Delta, Tool.Input.Delta, Reasoning.Delta, Compaction.Delta] as const

export const Durable = Schema.Union(DurableDefinitions, { mode: "oneOf" }).pipe(Schema.toTaggedUnion("type"))
export type DurableEvent = typeof Durable.Type

export const All = Schema.Union([...DurableDefinitions, ...EphemeralDefinitions], { mode: "oneOf" }).pipe(
  Schema.toTaggedUnion("type"),
)
export type Event = typeof All.Type
export type Type = Event["type"]

export * as SessionEvent from "./event"
