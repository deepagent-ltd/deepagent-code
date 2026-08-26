import { array, check, object } from "../assertions"
import { http, route } from "../dsl"
import type { Scenario } from "../types"

export const imScenarios: Scenario[] = [
  http.protected.get("/api/v1/im/groups", "im.groups.list").json(200, array),
  http.protected
    .post("/api/v1/im/groups", "im.groups.create")
    .mutating()
    .at((ctx) => ({
      path: "/api/v1/im/groups",
      headers: ctx.headers(),
      body: { name: "HTTP API Group", type: "project" },
    }))
    .json(200, (body) => {
      object(body)
      check(body.name === "HTTP API Group", "created IM group should preserve its name")
      check(body.type === "project", "created IM group should preserve its type")
    }),
  http.protected
    .get("/api/v1/im/groups/{groupId}/messages", "im.messages.list")
    .at((ctx) => ({
      path: route("/api/v1/im/groups/{groupId}/messages", { groupId: "group_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .post("/api/v1/im/groups/{groupId}/messages", "im.messages.create")
    .at((ctx) => ({
      path: route("/api/v1/im/groups/{groupId}/messages", { groupId: "group_httpapi_missing" }),
      headers: ctx.headers(),
      body: { senderType: "user", type: "text", content: "HTTP API message" },
    }))
    .json(404, object, "status"),
  http.protected
    .post("/api/v1/im/groups/{groupId}/read", "im.messages.markRead")
    .at((ctx) => ({
      path: route("/api/v1/im/groups/{groupId}/read", { groupId: "group_httpapi_missing" }),
      headers: ctx.headers(),
      body: {},
    }))
    .json(404, object, "status"),
  http.protected.get("/api/v1/im/agents", "im.agents.list").json(200, array),
  http.protected
    .get("/api/v1/im/messages/{messageId}", "im.messages.get")
    .at((ctx) => ({
      path: route("/api/v1/im/messages/{messageId}", { messageId: "message_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .get("/api/v1/im/groups/{groupId}/messages/{messageId}/thread", "im.messages.thread")
    .at((ctx) => ({
      path: route("/api/v1/im/groups/{groupId}/messages/{messageId}/thread", {
        groupId: "group_httpapi_missing",
        messageId: "message_httpapi_missing",
      }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .get("/api/v1/im/search", "im.messages.search")
    .at((ctx) => ({ path: "/api/v1/im/search?q=httpapi", headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      array(body.messages)
      check(typeof body.hasMore === "boolean", "IM search should return pagination metadata")
    }),
  http.protected
    .post("/api/v1/im/attachments", "im.attachments.upload")
    .probe({ path: "/api/v1/im/attachments", body: {} })
    .at((ctx) => ({ path: "/api/v1/im/attachments", headers: ctx.headers(), body: {} }))
    .status(415),
  http.protected.get("/api/v1/im/attachments", "im.attachments.list").json(404, object, "status"),
  http.protected
    .get("/ws/im/group/{groupId}", "im.websocket.connect")
    .at((ctx) => ({
      path: route("/ws/im/group/{groupId}", { groupId: "group_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .status(404, undefined, "status"),
  http.protected
    .post("/api/v1/webhook/git", "webhook.git")
    .mutating()
    .at((ctx) => ({
      path: "/api/v1/webhook/git",
      headers: ctx.headers(),
      body: { repo: "deepagent-code", commit: "httpapi-git", deliveryId: "httpapi-git" },
    }))
    .json(200, (body) => {
      object(body)
      check(body.accepted === true && body.type === "git.push", "git webhook should publish a git.push event")
    }),
  http.protected
    .post("/api/v1/webhook/ci", "webhook.ci")
    .mutating()
    .at((ctx) => ({
      path: "/api/v1/webhook/ci",
      headers: ctx.headers(),
      body: { repo: "deepagent-code", pipeline: "httpapi", deliveryId: "httpapi-ci" },
    }))
    .json(200, (body) => {
      object(body)
      check(body.accepted === true && body.type === "ci.failure", "CI webhook should publish a ci.failure event")
    }),
  http.protected
    .post("/api/v1/webhook/pr", "webhook.pr")
    .mutating()
    .at((ctx) => ({
      path: "/api/v1/webhook/pr",
      headers: ctx.headers(),
      body: { repo: "deepagent-code", comment: "Please review", deliveryId: "httpapi-pr" },
    }))
    .json(200, (body) => {
      object(body)
      check(body.accepted === true && body.type === "pr.comment", "PR webhook should publish a pr.comment event")
    }),
  http.protected
    .post("/api/v1/webhook/monitor", "webhook.monitor")
    .mutating()
    .at((ctx) => ({
      path: "/api/v1/webhook/monitor",
      headers: ctx.headers(),
      body: { title: "HTTP API alert", severity: "warning", deliveryId: "httpapi-monitor" },
    }))
    .json(200, (body) => {
      object(body)
      check(
        body.accepted === true && body.type === "monitor.alert",
        "monitor webhook should publish a monitor.alert event",
      )
    }),
]
