import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

// V4.0 §A1 — the EXTERNAL WEBHOOK INGRESS. The §A1 event-source table names six sources; before this
// group only IM had a producer. This surface is the missing 5-of-6: it authenticates an external caller
// (git hook / CI / PR / monitoring) and normalizes each delivery into a DeepAgentEvent published onto the
// V4 Event Bus (DeepAgentEventBus). All four endpoints are workspace-scoped + authenticated via the SAME
// middleware stack the rest of the instance API uses (Authorization + InstanceContext + WorkspaceRouting),
// so the ingress is NOT an anonymous endpoint — the shared server credential gates it.
//
// SECURITY (§E1, fail-closed): as of P0.1, DEFAULT_TRUSTED_SOURCES is first-party only
// (["im","system","schedule"]) — so git/ci/pr/monitor events are NOT L1-trusted by default and the
// four-layer security gate BLOCKS them at dispatch time until an operator adds the source to the
// workspace's `trustedSources`. This ingress still PUBLISHES them (they persist + show in the §F2 trace);
// only downstream agent EXECUTION is gated. This is intended: external ingress is opt-in per workspace.
//
// RATE LIMIT (§E2): every endpoint publishes via `tryPublish` (the §E2-gated path, like the §B1 IM
// double-write) so an external webhook flood is shed by the 1000/min per-workspace ceiling rather than
// overwhelming the bus. A shed event returns HTTP 202 with `{ dropped: true }` (never a 500).

const root = "/api/v1/webhook"

// ── shared response ───────────────────────────────────────────────────────────────────────────────
// The ingress ack. `dropped` = the §E2 rate gate shed this delivery (not persisted, not dispatched) — a
// 202 with dropped:true, NOT an error. `eventID`/`idempotencyKey` are present on an accepted (or
// idempotent-replayed) delivery so the caller can correlate + safely retry.
export const WebhookAccepted = Schema.Struct({
  accepted: Schema.Boolean,
  dropped: Schema.Boolean,
  eventID: Schema.optional(Schema.String),
  idempotencyKey: Schema.optional(Schema.String),
  type: Schema.String,
})
export type WebhookAccepted = Schema.Schema.Type<typeof WebhookAccepted>

// ── §A1 git.push ────────────────────────────────────────────────────────────────────────────────
// A git push webhook (GitHub push event, a post-receive hook, etc). `deliveryId` is the provider's
// unique delivery id (GitHub's X-GitHub-Delivery) — it makes the idempotencyKey deterministic so a
// provider RE-DELIVERY of the same push dedupes to one event (§A3 幂等).
export const GitPushInput = Schema.Struct({
  repo: Schema.String,
  ref: Schema.optional(Schema.String), // e.g. "refs/heads/main"
  branch: Schema.optional(Schema.String),
  commit: Schema.String, // head sha
  actor: Schema.optional(Schema.String), // pusher (→ actorID)
  deliveryId: Schema.optional(Schema.String), // provider delivery id (dedupe anchor)
  destructive: Schema.optional(Schema.Boolean), // force-push / history rewrite (§M risk signal)
  message: Schema.optional(Schema.String),
})
export type GitPushInput = Schema.Schema.Type<typeof GitPushInput>

// ── §A1 ci.failure ──────────────────────────────────────────────────────────────────────────────
// A CI webhook for a failed build/run — the CodeFixAgent trigger (§C2 partition rule). `consecutiveFailures`
// feeds the §M repeated-failure panel rule when ≥3.
export const CiFailureInput = Schema.Struct({
  repo: Schema.String,
  ref: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  commit: Schema.optional(Schema.String),
  actor: Schema.optional(Schema.String),
  deliveryId: Schema.optional(Schema.String),
  pipeline: Schema.optional(Schema.String), // pipeline/workflow name
  jobUrl: Schema.optional(Schema.String),
  consecutiveFailures: Schema.optional(Schema.Number),
  logExcerpt: Schema.optional(Schema.String),
})
export type CiFailureInput = Schema.Schema.Type<typeof CiFailureInput>

// ── §A1 pr.comment ──────────────────────────────────────────────────────────────────────────────
// A PR-comment webhook (a reviewer asks for a change) — the Review/Performance agent trigger. The
// destructive/migration/architectureChange flags feed the §M auto-convene risk rules.
export const PrCommentInput = Schema.Struct({
  repo: Schema.String,
  prNumber: Schema.optional(Schema.Number),
  commit: Schema.optional(Schema.String),
  actor: Schema.optional(Schema.String), // commenter (→ actorID)
  deliveryId: Schema.optional(Schema.String),
  comment: Schema.String,
  destructive: Schema.optional(Schema.Boolean),
  migration: Schema.optional(Schema.Boolean),
  architectureChange: Schema.optional(Schema.Boolean),
})
export type PrCommentInput = Schema.Schema.Type<typeof PrCommentInput>

// ── §A1 monitor.alert ───────────────────────────────────────────────────────────────────────────
// An observability/monitoring alert — the DiagnosisAgent trigger. `severity`/`category` feed the §M
// security-panel rule and the ingress priority (a critical/security alert publishes at high priority so
// it bypasses the §E2 shed + §A4 backpressure).
export const MonitorAlertInput = Schema.Struct({
  repo: Schema.optional(Schema.String), // the affected service/repo, when known
  alertId: Schema.optional(Schema.String),
  deliveryId: Schema.optional(Schema.String),
  title: Schema.String,
  severity: Schema.optional(Schema.Literals(["info", "warning", "critical"])),
  category: Schema.optional(Schema.String), // e.g. "security", "latency"
  detail: Schema.optional(Schema.String),
})
export type MonitorAlertInput = Schema.Schema.Type<typeof MonitorAlertInput>

// query params extend the workspace routing query (spread the shared fields, matching oversight/debug).
const IngressQuery = Schema.Struct({ ...WorkspaceRoutingQueryFields })

export const WebhookApi = HttpApi.make("webhook").add(
  HttpApiGroup.make("webhook")
    .add(
      HttpApiEndpoint.post("webhookGit", `${root}/git`, {
        query: IngressQuery,
        payload: GitPushInput,
        success: described(WebhookAccepted, "§A1 git.push published onto the bus (or shed by the §E2 rate gate)"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "webhook.git",
          summary: "Git push webhook",
          description:
            "V4.0 §A1: authenticate + publish a `git.push` DeepAgentEvent (CodeReviewAgent trigger). Opt-in trustedSources gates dispatch.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("webhookCi", `${root}/ci`, {
        query: IngressQuery,
        payload: CiFailureInput,
        success: described(WebhookAccepted, "§A1 ci.failure published onto the bus (or shed by the §E2 rate gate)"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "webhook.ci",
          summary: "CI failure webhook",
          description:
            "V4.0 §A1: authenticate + publish a `ci.failure` DeepAgentEvent (CodeFixAgent trigger). Opt-in trustedSources gates dispatch.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("webhookPr", `${root}/pr`, {
        query: IngressQuery,
        payload: PrCommentInput,
        success: described(WebhookAccepted, "§A1 pr.comment published onto the bus (or shed by the §E2 rate gate)"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "webhook.pr",
          summary: "PR comment webhook",
          description:
            "V4.0 §A1: authenticate + publish a `pr.comment` DeepAgentEvent (Review/Performance agent trigger). Opt-in trustedSources gates dispatch.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("webhookMonitor", `${root}/monitor`, {
        query: IngressQuery,
        payload: MonitorAlertInput,
        success: described(WebhookAccepted, "§A1 monitor.alert published onto the bus (or shed by the §E2 rate gate)"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "webhook.monitor",
          summary: "Monitoring alert webhook",
          description:
            "V4.0 §A1: authenticate + publish a `monitor.alert` DeepAgentEvent (DiagnosisAgent trigger). Opt-in trustedSources gates dispatch.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "webhook",
        description: "V4.0 §A1 external ingress: authenticated git/ci/pr/monitor webhooks → DeepAgent Event Bus.",
      }),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
