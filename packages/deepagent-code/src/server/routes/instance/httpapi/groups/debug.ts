/**
 * D1H (S1-v3.7): Debug HTTP API group — DAP debug session routes.
 *
 * All endpoints delegate directly to DebugService; the R0 privilege gate lives
 * inside DebugService.start() so routes do not need to re-gate.
 *
 * SSE event stream: GET /debug/events?sessionId=xxx
 * Delivers: debug.stopped / debug.output / debug.terminated / debug.updated
 */
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { described } from "./metadata"
import { SessionState } from "@/debug/types"

// ── Re-export paths so the handler and SDK can reference them ─────────────────

export const DebugPaths = {
  start: "/debug/start",
  breakpoints: "/debug/breakpoints",
  continue: "/debug/continue",
  step: "/debug/step",
  stack: "/debug/stack",
  scopes: "/debug/scopes",
  variables: "/debug/variables",
  evaluate: "/debug/evaluate",
  terminate: "/debug/terminate",
  sessions: "/debug/sessions",
  events: "/debug/events",
} as const

// ── Request / response schemas ────────────────────────────────────────────────

/** POST /debug/start */
export const DebugStartBody = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  /** Adapter id from the registry (e.g. "debugpy", "delve"). */
  adapter: Schema.String,
  /** Absolute path to the program to debug. */
  program: Schema.String,
  /** Optional program arguments. */
  args: Schema.optional(Schema.Array(Schema.String)),
  /** Working directory for the adapter. Defaults to instance directory. */
  cwd: Schema.optional(Schema.String),
  /** Caller-chosen session id; a nanoid is generated when omitted. */
  sessionId: Schema.optional(Schema.String),
}).annotate({ identifier: "DebugStartBody" })

/** POST /debug/breakpoints */
export const DebugBreakpointsBody = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  sessionId: Schema.String,
  /** Relative or absolute path to the source file. */
  file: Schema.String,
  breakpoints: Schema.Array(
    Schema.Struct({
      /** 1-based line number (matches editor convention). */
      line: Schema.Number,
      condition: Schema.optional(Schema.String),
    }),
  ),
}).annotate({ identifier: "DebugBreakpointsBody" })

/** POST /debug/continue */
export const DebugContinueBody = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  sessionId: Schema.String,
}).annotate({ identifier: "DebugContinueBody" })

/** POST /debug/step */
export const DebugStepBody = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  sessionId: Schema.String,
  kind: Schema.Literals(["next", "stepIn", "stepOut"]),
}).annotate({ identifier: "DebugStepBody" })

/** GET /debug/stack — query params */
export const DebugStackQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  sessionId: Schema.String,
}).annotate({ identifier: "DebugStackQuery" })

/** GET /debug/scopes — query params */
export const DebugScopesQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  sessionId: Schema.String,
  frameId: Schema.NumberFromString,
}).annotate({ identifier: "DebugScopesQuery" })

/** GET /debug/variables — query params */
export const DebugVariablesQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  sessionId: Schema.String,
  variablesReference: Schema.NumberFromString,
}).annotate({ identifier: "DebugVariablesQuery" })

/** POST /debug/evaluate */
export const DebugEvaluateBody = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  sessionId: Schema.String,
  expression: Schema.String,
  frameId: Schema.optional(Schema.Number),
}).annotate({ identifier: "DebugEvaluateBody" })

/** POST /debug/terminate */
export const DebugTerminateBody = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  sessionId: Schema.String,
}).annotate({ identifier: "DebugTerminateBody" })

/** GET /debug/events — SSE query params */
export const DebugEventsQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  sessionId: Schema.optional(Schema.String),
}).annotate({ identifier: "DebugEventsQuery" })

/** Shared session-state response envelope */
export const DebugStateResult = Schema.Struct({
  sessionId: Schema.String,
  state: SessionState,
}).annotate({ identifier: "DebugStateResult" })

/**
 * Start result: either a started session, or an adapter_unavailable error when
 * the requested adapter id is not in the registry (V3.7 review P0-1). All fields
 * optional so both shapes validate.
 */
export const DebugStartResult = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  state: Schema.optional(SessionState),
  error: Schema.optional(Schema.Literals(["adapter_unavailable"])),
  message: Schema.optional(Schema.String),
}).annotate({ identifier: "DebugStartResult" })

/** Sessions list result */
export const DebugSessionsResult = Schema.Struct({
  sessions: Schema.Array(SessionState),
}).annotate({ identifier: "DebugSessionsResult" })

// ── HttpApi group ─────────────────────────────────────────────────────────────

export const DebugApi = HttpApi.make("debug").add(
  HttpApiGroup.make("debug")
    .add(
      HttpApiEndpoint.post("start", DebugPaths.start, {
        payload: DebugStartBody,
        success: described(DebugStartResult, "Session started"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "debug.start",
          summary: "Start debug session",
          description:
            "Start a debug session for the given adapter and program. Passes through the R0 privilege gate inside DebugService. Returns the initial session state.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("breakpoints", DebugPaths.breakpoints, {
        payload: DebugBreakpointsBody,
        success: described(DebugStateResult, "Breakpoints updated"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "debug.breakpoints",
          summary: "Set breakpoints",
          description: "Set (replace) breakpoints for a source file in an existing session.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("continue", DebugPaths.continue, {
        payload: DebugContinueBody,
        success: described(DebugStateResult, "Resumed"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "debug.continue",
          summary: "Continue execution",
          description: "Resume execution of a stopped session.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("step", DebugPaths.step, {
        payload: DebugStepBody,
        success: described(DebugStateResult, "Stepped"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "debug.step",
          summary: "Step",
          description: "Single-step the current thread (next / stepIn / stepOut).",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("stack", DebugPaths.stack, {
        query: DebugStackQuery,
        success: described(Schema.Struct({ frames: Schema.Array(Schema.Unknown) }), "Stack frames"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "debug.stack",
          summary: "Stack trace",
          description: "Return the current call-stack frames for the stopped session.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("scopes", DebugPaths.scopes, {
        query: DebugScopesQuery,
        success: described(Schema.Struct({ scopes: Schema.Array(Schema.Unknown) }), "Scopes"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "debug.scopes",
          summary: "Frame scopes",
          description: "Return variable scopes for a stack frame.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("variables", DebugPaths.variables, {
        query: DebugVariablesQuery,
        success: described(Schema.Struct({ variables: Schema.Array(Schema.Unknown) }), "Variables"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "debug.variables",
          summary: "Variables",
          description: "Return variables for a scope or structured variable reference.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("evaluate", DebugPaths.evaluate, {
        payload: DebugEvaluateBody,
        success: described(Schema.Struct({ result: Schema.Unknown }), "Evaluation result"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "debug.evaluate",
          summary: "Evaluate expression",
          description: "Evaluate an expression in the context of the current frame (REPL / watch).",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("terminate", DebugPaths.terminate, {
        payload: DebugTerminateBody,
        success: described(DebugStateResult, "Session terminated"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "debug.terminate",
          summary: "Terminate session",
          description: "Terminate the debug session and tear down the adapter process.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("sessions", DebugPaths.sessions, {
        query: Schema.Struct({ ...WorkspaceRoutingQueryFields }),
        success: described(DebugSessionsResult, "Active sessions"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "debug.sessions",
          summary: "List sessions",
          description: "Return a snapshot of all live debug sessions.",
        }),
      ),
    )
    .add(
      // SSE stream: EventSource / fetch with streaming body.
      // Effect HttpApi streams via HttpServerResponse.stream; we handle it in the handler.
      HttpApiEndpoint.get("events", DebugPaths.events, {
        query: DebugEventsQuery,
        success: described(Schema.Unknown, "SSE event stream"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "debug.events",
          summary: "Debug event stream (SSE)",
          description:
            "Server-sent events for debug.stopped / debug.output / debug.terminated / debug.updated. Optionally filter to a single sessionId.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "debug",
        description: "V3.7 DAP debug session routes (human UI + agent shared).",
      }),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
