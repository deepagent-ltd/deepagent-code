/**
 * P1H (S1-v3.7): Profile HTTP API group — PAP profiling routes.
 *
 * Four endpoints that wrap the V3.5 ProfileService without modifying it:
 *   POST /profile/run      — kick off a profile run (returns runId immediately)
 *   GET  /profile/result   — read PROFILE_RESULT.json artifact for a runId
 *   GET  /profile/hotspots — normalized hotspot list (top-N) for a runId
 *   GET  /profile/runs     — recent runId list (max 20)
 *
 * The R0 gate lives inside ProfileService / the adapter's binary probe; routes
 * here are intentionally thin. If the profiler binary is missing the run
 * completes with status:"error" and a clear message.
 */
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { described } from "./metadata"

// ── Route path constants ──────────────────────────────────────────────────────

export const ProfilePaths = {
  run: "/profile/run",
  result: "/profile/result",
  hotspots: "/profile/hotspots",
  runs: "/profile/runs",
} as const

// ── Request / response schemas ────────────────────────────────────────────────

/** POST /profile/run */
export const ProfileRunBody = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  /** Command / executable to profile (e.g. `python train.py`). */
  program: Schema.String,
  /** Profiler adapter id: ncu | nsys | rocprof | vtune | perf. Auto-selected when omitted. */
  profiler: Schema.optional(Schema.String),
  /** Program arguments (appended after the program command). */
  args: Schema.optional(Schema.Array(Schema.String)),
  /** Working directory; defaults to instance directory. */
  cwd: Schema.optional(Schema.String),
}).annotate({ identifier: "ProfileRunBody" })

export const ProfileRunResult = Schema.Struct({
  runId: Schema.String,
  status: Schema.Literals(["running", "done", "error"]),
  /** Populated once status="done". */
  artifactPath: Schema.optional(Schema.String),
  /** Populated once status="error". */
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "ProfileRunResult" })

/** GET /profile/result?runId=xxx */
export const ProfileResultQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  runId: Schema.String,
}).annotate({ identifier: "ProfileResultQuery" })

/** GET /profile/hotspots?runId=xxx&limit=10 */
export const ProfileHotspotsQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  runId: Schema.String,
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
  ),
}).annotate({ identifier: "ProfileHotspotsQuery" })

/** GET /profile/runs */
export const ProfileRunsQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
}).annotate({ identifier: "ProfileRunsQuery" })

// ── Shared hotspot shape (frontend-friendly) ──────────────────────────────────

/** A single rendered hotspot row for the ProfilePanel HotspotTable. */
export const ProfileHotspot = Schema.Struct({
  /** Symbol or kernel name. */
  name: Schema.String,
  /** Relative file path + line (e.g. "src/train.py:42"), or empty string. */
  fileLine: Schema.String,
  /** Self time percentage (0–100). */
  selfPct: Schema.Number,
  /** Cumulative time percentage (self + callees; approximated as selfPct when not available). */
  cumulPct: Schema.Number,
  /** Call count; -1 when unavailable. */
  calls: Schema.Number,
}).annotate({ identifier: "ProfileHotspot" })

// ── HttpApi group ─────────────────────────────────────────────────────────────

export const ProfileApi = HttpApi.make("profile").add(
  HttpApiGroup.make("profile")
    .add(
      HttpApiEndpoint.post("run", ProfilePaths.run, {
        payload: ProfileRunBody,
        success: described(ProfileRunResult, "Run started"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "profile.run",
          summary: "Start a profile run",
          description:
            "Launch a profile run for the given program. Returns a runId immediately; poll /profile/result to check completion. The profiler adapter is auto-selected from env heuristics when 'profiler' is omitted.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("result", ProfilePaths.result, {
        query: ProfileResultQuery,
        success: described(Schema.Unknown, "PROFILE_RESULT.json artifact"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "profile.result",
          summary: "Get full profile result",
          description:
            "Return the full PROFILE_RESULT.json artifact for a completed run. Returns { status:'running' } if the run is still in progress, or { status:'error', error } on failure.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("hotspots", ProfilePaths.hotspots, {
        query: ProfileHotspotsQuery,
        success: described(Schema.Array(ProfileHotspot), "Top hotspots"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "profile.hotspots",
          summary: "Get normalized hotspot list",
          description:
            "Return the top-N normalized hotspots for a completed run, sorted by self-time percentage descending. Limit defaults to 10.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("runs", ProfilePaths.runs, {
        query: ProfileRunsQuery,
        success: described(Schema.Array(ProfileRunResult), "Recent runs"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "profile.runs",
          summary: "List recent profile runs",
          description: "Return the most recent profile runs (up to 20), newest first.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "profile",
        description: "V3.7 PAP profile session routes (human UI + V3.5 ProfileService shared).",
      }),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
