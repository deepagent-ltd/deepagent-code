import { Effect } from "effect"
import { array, check, isRecord, object } from "../assertions"
import { http, route } from "../dsl"
import type { Scenario } from "../types"

export const platformScenarios: Scenario[] = [
  http.protected
    .get("/global/capabilities", "global.capabilities")
    .global()
    .json(200, (body) => {
      object(body)
      check(typeof body.protocolVersion === "string", "capabilities should include the protocol version")
      check(typeof body.version === "string", "capabilities should include the build version")
      object(body.features)
    }),
  http.protected.get("/global/projects", "global.projects").global().json(200, array),
  http.protected
    .delete("/global/projects/{projectID}", "global.projectDelete")
    .global()
    .mutating()
    .at(() => ({ path: route("/global/projects/{projectID}", { projectID: "project_httpapi_missing" }) }))
    .status(204, undefined, "status"),
  http.protected
    .post("/global/import", "global.import")
    .global()
    .probe({ path: "/global/import", body: { source: "invalid" } })
    .at(() => ({ path: "/global/import", body: { source: "invalid" } }))
    .status(400),
  http.protected
    .post("/experimental/worktree/changes", "worktree.changes")
    .seeded((ctx) =>
      Effect.acquireRelease(ctx.worktree({ name: "api-changes" }), (item) => ctx.worktreeRemove(item.directory)),
    )
    .at((ctx) => ({
      path: "/experimental/worktree/changes",
      headers: ctx.headers(),
      body: { directory: ctx.state.directory },
    }))
    .json(200, (body) => {
      object(body)
      check(typeof body.clean === "boolean", "worktree change count should include the clean decision")
      check(
        body.uncommitted === null || typeof body.uncommitted === "number",
        "uncommitted count should be known or null",
      )
      check(body.ahead === null || typeof body.ahead === "number", "ahead count should be known or null")
    }),
  http.protected
    .post("/experimental/worktree/diff", "worktree.diff")
    .seeded((ctx) =>
      Effect.acquireRelease(ctx.worktree({ name: "api-diff" }), (item) => ctx.worktreeRemove(item.directory)),
    )
    .at((ctx) => ({
      path: "/experimental/worktree/diff",
      headers: ctx.headers(),
      body: { directory: ctx.state.directory },
    }))
    .json(200, (body) => {
      object(body)
      array(body.entries)
      check(typeof body.patch === "string", "worktree diff should include a patch")
      check(typeof body.truncated === "boolean", "worktree diff should report truncation")
    }),
  http.protected
    .post("/experimental/worktree/summary", "worktree.summary")
    .seeded((ctx) =>
      Effect.acquireRelease(ctx.worktree({ name: "api-summary" }), (item) => ctx.worktreeRemove(item.directory)),
    )
    .at((ctx) => ({
      path: "/experimental/worktree/summary",
      headers: ctx.headers(),
      body: { directory: ctx.state.directory },
    }))
    .json(200, (body) => {
      object(body)
      check(typeof body.base === "string", "worktree summary should include its base branch")
      check(typeof body.files === "number", "worktree summary should include the changed file count")
    }),
  http.protected
    .post("/experimental/worktree/merge", "worktree.merge")
    .at((ctx) => ({
      path: "/experimental/worktree/merge",
      headers: ctx.headers(),
      body: { directory: `${ctx.directory}/missing-worktree` },
    }))
    .status(400),
  http.protected
    .delete("/experimental/worktree/safe-remove", "worktree.safeRemove")
    .mutating()
    .seeded((ctx) =>
      Effect.acquireRelease(ctx.worktree({ name: "api-safe-remove" }), (item) => ctx.worktreeRemove(item.directory)),
    )
    .at((ctx) => ({
      path: "/experimental/worktree/safe-remove",
      headers: ctx.headers(),
      body: { directory: ctx.state.directory, force: true },
    }))
    .json(200, (body) => check(body === true, "safe-remove should confirm removal")),
  http.protected
    .post("/session/{sessionID}/prompt_prepare", "session.prompt_prepare")
    .seeded((ctx) => ctx.session({ title: "Prompt prepare validation" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/prompt_prepare", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { mode: "intelligence", parts: [{ type: "text", text: "" }] },
    }))
    .status(400),
  http.protected
    .post("/session/{sessionID}/prompt_prepare_stream", "session.prompt_prepare_stream")
    .stream()
    .seeded((ctx) => ctx.session({ title: "Prompt prepare stream validation" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/prompt_prepare_stream", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { mode: "intelligence", parts: [{ type: "text", text: "" }] },
    }))
    .status(200, (_ctx, result) =>
      Effect.sync(() => {
        check(result.contentType.includes("text/event-stream"), "prompt prepare stream should use SSE")
        check(result.text.includes("error"), "invalid prompt preparation should emit a terminal error event")
      }),
    ),
  http.protected
    .get("/session/{sessionID}/prompt_suggestion", "session.prompt_suggestion")
    .seeded((ctx) => ctx.session({ title: "Prompt suggestion" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/prompt_suggestion", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      object(body)
      check(body.status === null, "new sessions should not have a prompt suggestion status")
      check(body.body === null, "new sessions should not have a prompt suggestion body")
    }),
  http.protected
    .get("/workspace/{workspaceID}/config/trusted-sources", "workspaceConfig.trustedSources.get")
    .at((ctx) => ({
      path: route("/workspace/{workspaceID}/config/trusted-sources", { workspaceID: "workspace-httpapi" }),
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      object(body)
      array(body.trustedSources)
      check(body.trustedSources.includes("im"), "default trusted sources should include IM")
    }),
  http.protected
    .put("/workspace/{workspaceID}/config/trusted-sources", "workspaceConfig.trustedSources.put")
    .mutating()
    .at((ctx) => ({
      path: route("/workspace/{workspaceID}/config/trusted-sources", { workspaceID: "workspace-httpapi" }),
      headers: ctx.headers(),
      body: { trustedSources: ["git", "ci"] },
    }))
    .json(200, (body) => {
      object(body)
      check(
        Array.isArray(body.trustedSources) && body.trustedSources.join(",") === "git,ci",
        "trusted source replacement should round-trip",
      )
    }),
]
