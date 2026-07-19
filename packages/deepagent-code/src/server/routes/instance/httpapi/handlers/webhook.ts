import { Cause, Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { createHash } from "node:crypto"
import { InstanceHttpApi } from "../api"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"

// §A1 event `type` strings — the EXACT literals the consumers key on: EventRouter (agent
// `triggers[].event`), TaskPartitioner.DEFAULT_RULES, and PanelConvenePolicy.DEFAULT_RULES. These mirror
// the `GIT_PUSH / CI_FAILURE / PR_COMMENT / MONITOR_ALERT` constants added in
// core/src/deepagent/lmn-events.ts; kept as local literals here because the value is the wire contract
// (a consumer matches on the string, never the symbol) — the two must stay identical.
const GIT_PUSH = "git.push"
const CI_FAILURE = "ci.failure"
const PR_COMMENT = "pr.comment"
const MONITOR_ALERT = "monitor.alert"

// V4.0 §A1 — external webhook ingress handlers. Each endpoint AUTHENTICATES (via the group's shared
// Authorization + WorkspaceRouting middleware — this is NOT an anonymous endpoint), validates its input
// schema, normalizes the delivery into a DeepAgentEvent, and PUBLISHES it onto the bus via `tryPublish`
// (the §E2 rate-gated path). The persisted event is visible in the §F2 trace regardless of the security
// gate; downstream agent DISPATCH is separately §E1-gated (git/ci/pr/monitor are NOT in
// DEFAULT_TRUSTED_SOURCES, so an operator must opt them into the workspace's trustedSources before they
// drive agents). See groups/webhook.ts for the full security note.

// The workspace key for scoping: the explicit routed workspaceID when present, else the routed directory
// (same identity IM/oversight derive — never cross-tenant). Publishing scopes the event + the §E2
// per-workspace rate bucket to this key.
const workspaceKey = Effect.gen(function* () {
  const route = yield* WorkspaceRouteContext
  return route.workspaceID ?? route.directory
})

// §A3 幂等 — a DETERMINISTIC idempotency key from the webhook delivery, so a provider RE-DELIVERY (retry)
// of the SAME event dedupes to one persisted event (the bus UNIQUE(idempotency_key) makes the re-publish
// a no-op returning the existing row). Anchored on the provider's delivery id when present; otherwise a
// sha256 of the source + identifying fields, so identical-content retries still collapse while genuinely
// distinct deliveries don't collide. Prefixed with the source for readability + cross-source safety.
//
// The identifying fields are serialized with JSON.stringify (an ARRAY), NOT a delimiter-join: the array
// form gives every element an unambiguous boundary + preserves type/absence (a missing optional is JSON
// `null`, distinct from ""). This closes two collision surfaces a naive join has: (a) a field value that
// contains the delimiter shifting a boundary so two distinct payloads hash equal (a real event wrongly
// dropped as a duplicate), and (b) two deliveries sharing only the required field, all optionals absent,
// colliding on the fallback. Element ORDER is fixed by the caller (no timestamp/random) so the same
// delivery always yields the same key — dedupe (§A3) is unaffected.
export const deriveIdempotencyKey = (source: string, parts: ReadonlyArray<string | number | undefined>): string => {
  const material = JSON.stringify(parts.map((p) => (p == null ? null : p)))
  const digest = createHash("sha256").update(material).digest("hex").slice(0, 32)
  return `${source}:${digest}`
}

// The §E2 outcome → wire ack. A shed (rate-limited) delivery is a 202 with dropped:true (NOT a 500 and
// NOT a 429 error body — the caller learns it was shed and MAY retry later). A published (or
// idempotent-replayed) delivery carries the event id + key so the caller can correlate.
export const ackOf = (
  type: string,
  outcome: DeepAgentEventBus.TryPublishResult | { readonly busError: Cause.Cause<never> },
) => {
  if ("busError" in outcome) {
    // A bus EXCEPTION (not a shed) — surface as accepted:false/dropped:false so the caller can retry,
    // never a 500. Logged distinctly by the caller.
    return { accepted: false, dropped: false, type }
  }
  if ("dropped" in outcome) return { accepted: false, dropped: true, type }
  return {
    accepted: true,
    dropped: false,
    type,
    eventID: outcome.published.id,
    idempotencyKey: outcome.published.idempotencyKey,
  }
}

export const webhookHandlers = HttpApiBuilder.group(InstanceHttpApi, "webhook", (handlers) =>
  Effect.gen(function* () {
    const eventBus = yield* DeepAgentEventBus.Service

    // Publish one external event through the §E2 rate gate. Best-effort: a bus EXCEPTION is caught into a
    // distinct sentinel (logged as an error) and never fails the request — the caller retries. A `dropped`
    // outcome (rate-limited) is the expected §A4 event_dropped signal, logged as a warning.
    const publish = (input: DeepAgentEvent.PublishInput) =>
      Effect.gen(function* () {
        const outcome = yield* eventBus
          .tryPublish(input)
          .pipe(Effect.catchCause((cause) => Effect.succeed({ busError: cause } as const)))
        if ("busError" in outcome) {
          yield* Effect.logError("webhook ingress publish failed").pipe(
            Effect.annotateLogs({
              reason: "publish_error",
              source: input.source,
              type: input.type,
              workspaceID: input.workspaceID,
              idempotencyKey: input.idempotencyKey,
              cause: Cause.pretty(outcome.busError),
            }),
          )
        } else if ("dropped" in outcome) {
          yield* Effect.logWarning("webhook ingress event dropped by publish rate gate").pipe(
            Effect.annotateLogs({
              reason: "event_dropped",
              cause: "rate_limited",
              source: input.source,
              type: input.type,
              workspaceID: input.workspaceID,
            }),
          )
        }
        return ackOf(input.type, outcome)
      })

    const webhookGit = Effect.fn("WebhookHttpApi.git")(function* (ctx) {
      const workspaceID = yield* workspaceKey
      const p = ctx.payload
      // §A1 git.push → CodeReviewAgent. `normal` priority: external + potentially high-volume, so it goes
      // through the §E2 ceiling (a push flood is shed rather than bypassing the limit).
      return yield* publish({
        type: GIT_PUSH,
        source: "git",
        workspaceID,
        ...(p.actor ? { actorID: p.actor } : {}),
        idempotencyKey: deriveIdempotencyKey("git", ["git.push", p.repo, p.commit, p.deliveryId]),
        priority: "normal",
        payload: {
          repo: p.repo,
          ref: p.ref,
          branch: p.branch,
          commit: p.commit,
          actor: p.actor,
          destructive: p.destructive,
          message: p.message,
        },
      })
    })

    const webhookCi = Effect.fn("WebhookHttpApi.ci")(function* (ctx) {
      const workspaceID = yield* workspaceKey
      const p = ctx.payload
      // §A1 ci.failure → CodeFixAgent. `normal` priority: external + retriable, kept under the §E2 ceiling
      // so a flapping pipeline can't flood the bus past the limit. `consecutiveFailures` still drives the
      // §M repeated-failure panel rule downstream.
      return yield* publish({
        type: CI_FAILURE,
        source: "ci",
        workspaceID,
        ...(p.actor ? { actorID: p.actor } : {}),
        idempotencyKey: deriveIdempotencyKey("ci", [
          "ci.failure",
          p.repo,
          p.commit ?? p.pipeline,
          p.deliveryId ?? p.jobUrl,
        ]),
        priority: "normal",
        payload: {
          repo: p.repo,
          ref: p.ref,
          branch: p.branch,
          commit: p.commit,
          actor: p.actor,
          pipeline: p.pipeline,
          jobUrl: p.jobUrl,
          consecutiveFailures: p.consecutiveFailures,
          logExcerpt: p.logExcerpt,
        },
      })
    })

    const webhookPr = Effect.fn("WebhookHttpApi.pr")(function* (ctx) {
      const workspaceID = yield* workspaceKey
      const p = ctx.payload
      // §A1 pr.comment → Review/Performance agent. `normal` priority (under the §E2 ceiling). The
      // destructive/migration/architectureChange flags feed the §M auto-convene risk rules downstream.
      return yield* publish({
        type: PR_COMMENT,
        source: "pr",
        workspaceID,
        ...(p.actor ? { actorID: p.actor } : {}),
        idempotencyKey: deriveIdempotencyKey("pr", [
          "pr.comment",
          p.repo,
          p.prNumber,
          p.deliveryId ?? p.comment,
        ]),
        priority: "normal",
        payload: {
          repo: p.repo,
          prNumber: p.prNumber,
          commit: p.commit,
          actor: p.actor,
          comment: p.comment,
          destructive: p.destructive,
          migration: p.migration,
          architectureChange: p.architectureChange,
        },
      })
    })

    const webhookMonitor = Effect.fn("WebhookHttpApi.monitor")(function* (ctx) {
      const workspaceID = yield* workspaceKey
      const p = ctx.payload
      // §A1 monitor.alert → DiagnosisAgent. A CRITICAL alert publishes at `high` priority so it bypasses
      // the §E2 shed + §A4 backpressure (an outage signal must not be silently dropped under load); other
      // severities stay `normal` and remain subject to the ceiling.
      const priority: DeepAgentEvent.EventPriority = p.severity === "critical" ? "high" : "normal"
      return yield* publish({
        type: MONITOR_ALERT,
        source: "monitor",
        workspaceID,
        idempotencyKey: deriveIdempotencyKey("monitor", [
          "monitor.alert",
          p.repo,
          p.alertId,
          p.deliveryId ?? p.title,
        ]),
        priority,
        payload: {
          repo: p.repo,
          alertId: p.alertId,
          title: p.title,
          severity: p.severity,
          category: p.category,
          detail: p.detail,
        },
      })
    })

    return handlers
      .handle("webhookGit", webhookGit)
      .handle("webhookCi", webhookCi)
      .handle("webhookPr", webhookPr)
      .handle("webhookMonitor", webhookMonitor)
  }),
)
