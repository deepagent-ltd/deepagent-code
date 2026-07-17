#!/usr/bin/env bun

import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import { Commands } from "./commands/commands"
import { Runtime } from "./framework/runtime"
import { Daemon } from "./services/daemon"

const Handlers = Runtime.handlers(Commands, {
  $: () => import("./commands/handlers/default"),
  debug: {
    agents: () => import("./commands/handlers/debug/agents"),
  },
  migrate: () => import("./commands/handlers/migrate"),
  models: () => import("./commands/handlers/models"),
  run: () => import("./commands/handlers/run"),
  export: () => import("./commands/handlers/export"),
  stats: () => import("./commands/handlers/stats"),
  import: () => import("./commands/handlers/import"),
  auth: {
    login: () => import("./commands/handlers/auth/login"),
    list: () => import("./commands/handlers/auth/list"),
    logout: () => import("./commands/handlers/auth/logout"),
  },
  agent: {
    list: () => import("./commands/handlers/agent/list"),
  },
  mcp: {
    list: () => import("./commands/handlers/mcp/list"),
    add: () => import("./commands/handlers/mcp/add"),
  },
  session: {
    list: () => import("./commands/handlers/session/list"),
    delete: () => import("./commands/handlers/session/delete"),
  },
  packs: () => import("./commands/handlers/deepagent/packs"),
  wiki: () => import("./commands/handlers/deepagent/wiki"),
  oversight: () => import("./commands/handlers/deepagent/oversight"),
  review: () => import("./commands/handlers/deepagent/review"),
  "env-facts": () => import("./commands/handlers/deepagent/env-facts"),
  goal: () => import("./commands/handlers/deepagent/goal"),
  panel: () => import("./commands/handlers/deepagent/panel"),
  attach: () => import("./commands/handlers/attach"),
  db: {
    $: () => import("./commands/handlers/db"),
    path: () => import("./commands/handlers/db/path"),
  },
  web: () => import("./commands/handlers/web"),
  upgrade: () => import("./commands/handlers/upgrade"),
  uninstall: () => import("./commands/handlers/uninstall"),
  pr: () => import("./commands/handlers/pr"),
  acp: () => import("./commands/handlers/acp"),
  github: () => import("./commands/handlers/github"),
  service: {
    start: () => import("./commands/handlers/service/start"),
    restart: () => import("./commands/handlers/service/restart"),
    status: () => import("./commands/handlers/service/status"),
    stop: () => import("./commands/handlers/service/stop"),
    password: () => import("./commands/handlers/service/password"),
  },
  serve: () => import("./commands/handlers/serve"),
})

Runtime.run(Commands, Handlers, { version: "local" }).pipe(
  Effect.provide(Daemon.defaultLayer),
  Effect.provide(NodeServices.layer),
  Effect.scoped,
  NodeRuntime.runMain,
)
