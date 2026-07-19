import { Effect } from "effect"
import { createOpencodeClient } from "@deepagent-code/sdk/v2/client"
import { Daemon } from "./daemon"

// Migration seam for session-execution calls.
//
// Every CLI command that creates/prompts/aborts/steers a session must go
// through `SessionClient` instead of calling `client.session.*` directly.
// Internally this targets the legacy top-level endpoints (client.session.*),
// the only surface with a complete session lifecycle — matching the GUI and
// the old `deepagent run`. See `tmp/deepagentcore-cli-parity-impl-plan.md`
// Wave 0 task 5.
//
// When the durable SessionV2 engine swap (deepagentcoredurable) completes and
// the execution surface moves from legacy to the V2 durable path, only this
// module needs to change — not every command.

type Client = ReturnType<typeof createOpencodeClient>

const client = Effect.fn("cli.SessionClient.client")(function* () {
  return yield* (yield* Daemon.Service).client()
})

const call = <A>(f: (c: Client) => Promise<A>) =>
  Effect.gen(function* () {
    const c = yield* client()
    return yield* Effect.tryPromise(() => f(c))
  })

export const create = (opts: Parameters<Client["session"]["create"]>[0]) =>
  call((c) => c.session.create(opts))

export const promptAsync = (opts: Parameters<Client["session"]["promptAsync"]>[0]) =>
  call((c) => c.session.promptAsync(opts))

export const abort = (opts: Parameters<Client["session"]["abort"]>[0]) => call((c) => c.session.abort(opts))

export const status = () => call((c) => c.session.status())

export const get = (opts: Parameters<Client["session"]["get"]>[0]) => call((c) => c.session.get(opts))

export const list = (opts: Parameters<Client["session"]["list"]>[0]) => call((c) => c.session.list(opts))

export const fork = (opts: Parameters<Client["session"]["fork"]>[0]) => call((c) => c.session.fork(opts))

export const messages = (opts: Parameters<Client["session"]["messages"]>[0]) => call((c) => c.session.messages(opts))

export const deleteSession = (opts: Parameters<Client["session"]["delete"]>[0]) => call((c) => c.session.delete(opts))

export * as SessionClient from "./session-client"
