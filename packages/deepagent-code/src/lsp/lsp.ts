import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@deepagent-code/core/event"
import * as Log from "@deepagent-code/core/util/log"
import * as LSPClient from "./client"
import path from "path"
import { pathToFileURL, fileURLToPath } from "url"
import * as LSPServer from "./server"
import { Config } from "@/config/config"
import { Process } from "@/util/process"
import { spawn as lspspawn } from "./launch"
import { Effect, Layer, Context, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { containsPath } from "@/project/instance-context"
import { NonNegativeInt } from "@deepagent-code/core/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"

const log = Log.create({ service: "lsp" })

export const Event = {
  Updated: EventV2.define({ type: "lsp.updated", schema: {} }),
}

const Position = Schema.Struct({
  line: NonNegativeInt,
  character: NonNegativeInt,
})

export const Range = Schema.Struct({
  start: Position,
  end: Position,
}).annotate({ identifier: "Range" })
export type Range = typeof Range.Type

export const Symbol = Schema.Struct({
  name: Schema.String,
  kind: NonNegativeInt,
  location: Schema.Struct({
    uri: Schema.String,
    range: Range,
  }),
}).annotate({ identifier: "Symbol" })
export type Symbol = typeof Symbol.Type

export const DocumentSymbol = Schema.Struct({
  name: Schema.String,
  detail: Schema.optional(Schema.String),
  kind: NonNegativeInt,
  range: Range,
  selectionRange: Range,
}).annotate({ identifier: "DocumentSymbol" })
export type DocumentSymbol = typeof DocumentSymbol.Type

export const Status = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  root: Schema.String,
  status: Schema.Literals(["connected", "error"]),
}).annotate({ identifier: "LSPStatus" })
export type Status = typeof Status.Type

enum SymbolKind {
  File = 1,
  Module = 2,
  Namespace = 3,
  Package = 4,
  Class = 5,
  Method = 6,
  Property = 7,
  Field = 8,
  Constructor = 9,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
  String = 15,
  Number = 16,
  Boolean = 17,
  Array = 18,
  Object = 19,
  Key = 20,
  Null = 21,
  EnumMember = 22,
  Struct = 23,
  Event = 24,
  Operator = 25,
  TypeParameter = 26,
}

const kinds = [
  SymbolKind.Class,
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Interface,
  SymbolKind.Variable,
  SymbolKind.Constant,
  SymbolKind.Struct,
  SymbolKind.Enum,
]

const filterExperimentalServers = (servers: Record<string, LSPServer.Info>, flags: RuntimeFlags.Info) => {
  if (flags.experimentalLspTy) {
    if (servers["pyright"]) {
      log.info("LSP server pyright is disabled because DEEPAGENT_CODE_EXPERIMENTAL_LSP_TY is enabled")
      delete servers["pyright"]
    }
  } else {
    if (servers["ty"]) {
      delete servers["ty"]
    }
  }
}

type LocInput = { file: string; line: number; character: number }
type RangeInput = { file: string; start: { line: number; character: number }; end: { line: number; character: number } }

interface State {
  clients: LSPClient.Info[]
  servers: Record<string, LSPServer.Info>
  broken: Set<string>
  spawning: Map<string, Promise<LSPClient.Info | undefined>>
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly status: () => Effect.Effect<Status[]>
  readonly hasClients: (file: string) => Effect.Effect<boolean>
  readonly touchFile: (input: string, diagnostics?: "document" | "full") => Effect.Effect<void>
  readonly diagnostics: () => Effect.Effect<Record<string, LSPClient.Diagnostic[]>>
  readonly hover: (input: LocInput) => Effect.Effect<any>
  readonly definition: (input: LocInput) => Effect.Effect<any[]>
  readonly references: (input: LocInput) => Effect.Effect<any[]>
  readonly implementation: (input: LocInput) => Effect.Effect<any[]>
  readonly documentSymbol: (uri: string) => Effect.Effect<(DocumentSymbol | Symbol)[]>
  readonly workspaceSymbol: (query: string, options?: { limit?: number; kinds?: number[] }) => Effect.Effect<Symbol[]>
  readonly prepareCallHierarchy: (input: LocInput) => Effect.Effect<any[]>
  readonly incomingCalls: (input: LocInput) => Effect.Effect<any[]>
  readonly outgoingCalls: (input: LocInput) => Effect.Effect<any[]>
  // L1 (S1-v3.4) high-value additions — thin wrappers over `client.connection.sendRequest`.
  readonly typeDefinition: (input: LocInput) => Effect.Effect<any[]>
  readonly declaration: (input: LocInput) => Effect.Effect<any[]>
  readonly prepareTypeHierarchy: (input: LocInput) => Effect.Effect<any[]>
  readonly supertypes: (input: LocInput) => Effect.Effect<any[]>
  readonly subtypes: (input: LocInput) => Effect.Effect<any[]>
  readonly inlayHint: (input: RangeInput) => Effect.Effect<any[]>
  readonly codeAction: (input: RangeInput & { diagnostics?: any[] }) => Effect.Effect<any[]>
  /** Execute an LSP command. If the result/applyEdit produces a WorkspaceEdit, callers must treat it as a preview (no write). */
  readonly executeCommand: (command: string, args?: any[]) => Effect.Effect<any>
  readonly prepareRename: (input: LocInput) => Effect.Effect<any>
  /** Read-only: returns the WorkspaceEdit preview only; never writes files. */
  readonly rename: (input: LocInput & { newName: string }) => Effect.Effect<any>
  readonly documentHighlight: (input: LocInput) => Effect.Effect<any[]>
  readonly foldingRange: (uri: string) => Effect.Effect<any[]>
  readonly selectionRange: (input: LocInput) => Effect.Effect<any[]>
  // L1 low agent-value — kept on the Service but NOT surfaced in the code_intel intent set.
  readonly completion: (input: LocInput) => Effect.Effect<any>
  readonly signatureHelp: (input: LocInput) => Effect.Effect<any>
  /** Capability probe: returns the server capabilities for the first client serving `file`, or undefined. */
  readonly serverCapabilities: (file: string) => Effect.Effect<Record<string, unknown> | undefined>
  // L4 (S1-v3.4): project-level diagnostic pull. Uses workspace/diagnostic where supported,
  // else falls back to aggregating already-known per-file diagnostics.
  readonly workspaceDiagnostics: () => Effect.Effect<Record<string, LSPClient.Diagnostic[]>>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/LSP") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service
    const events = yield* EventV2Bridge.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("LSP.state")(function* (ctx) {
        const cfg = yield* config.get()

        const servers: Record<string, LSPServer.Info> = {}

        if (!cfg.lsp) {
          log.info("all LSPs are disabled")
        } else {
          for (const server of Object.values(LSPServer)) {
            servers[server.id] = server
          }

          filterExperimentalServers(servers, flags)

          if (cfg.lsp !== true) {
            for (const [name, item] of Object.entries(cfg.lsp)) {
              const existing = servers[name]
              if (item.disabled) {
                log.info(`LSP server ${name} is disabled`)
                delete servers[name]
                continue
              }
              servers[name] = {
                ...existing,
                id: name,
                root: existing?.root ?? (async (_file, ctx) => ctx.directory),
                extensions: item.extensions ?? existing?.extensions ?? [],
                spawn: async (root) => ({
                  process: lspspawn(item.command[0], item.command.slice(1), {
                    cwd: root,
                    env: { ...process.env, ...item.env },
                  }),
                  initialization: item.initialization,
                }),
              }
            }
          }

          log.info("enabled LSP servers", {
            serverIds: Object.values(servers)
              .map((server) => server.id)
              .join(", "),
          })
        }

        const s: State = {
          clients: [],
          servers,
          broken: new Set(),
          spawning: new Map(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await Promise.all(s.clients.map((client) => client.shutdown()))
          }),
        )

        return s
      }),
    )

    const getClients = Effect.fnUntraced(function* (file: string) {
      const ctx = yield* InstanceState.context
      if (!containsPath(file, ctx)) return [] as LSPClient.Info[]
      const s = yield* InstanceState.get(state)
      const clients = yield* Effect.promise(async () => {
        const extension = path.parse(file).ext || file
        const result: LSPClient.Info[] = []
        let updated = 0

        async function schedule(server: LSPServer.Info, root: string, key: string) {
          const handle = await server
            .spawn(root, ctx, flags)
            .then((value) => {
              if (!value) s.broken.add(key)
              return value
            })
            .catch((err) => {
              s.broken.add(key)
              log.error(`Failed to spawn LSP server ${server.id}`, { error: err })
              return undefined
            })

          if (!handle) return undefined
          log.info("spawned lsp server", { serverID: server.id, root })

          const client = await LSPClient.create({
            serverID: server.id,
            server: handle,
            root,
            directory: ctx.directory,
            instance: ctx,
          }).catch(async (err) => {
            s.broken.add(key)
            await Process.stop(handle.process)
            log.error(`Failed to initialize LSP client ${server.id}`, { error: err })
            return undefined
          })

          if (!client) return undefined

          const existing = s.clients.find((x) => x.root === root && x.serverID === server.id)
          if (existing) {
            await Process.stop(handle.process)
            return existing
          }

          s.clients.push(client)
          return client
        }

        for (const server of Object.values(s.servers)) {
          if (server.extensions.length && !server.extensions.includes(extension)) continue

          const root = await server.root(file, ctx)
          if (!root) continue
          if (s.broken.has(root + server.id)) continue

          const match = s.clients.find((x) => x.root === root && x.serverID === server.id)
          if (match) {
            result.push(match)
            continue
          }

          const inflight = s.spawning.get(root + server.id)
          if (inflight) {
            const client = await inflight
            if (!client) continue
            result.push(client)
            continue
          }

          const task = schedule(server, root, root + server.id)
          s.spawning.set(root + server.id, task)

          task.finally(() => {
            if (s.spawning.get(root + server.id) === task) {
              s.spawning.delete(root + server.id)
            }
          })

          const client = await task
          if (!client) continue

          result.push(client)
          updated++
        }

        return { result, updated }
      })
      yield* Effect.forEach(Array.from({ length: clients.updated }), () => events.publish(Event.Updated, {}), {
        discard: true,
      })
      return clients.result
    })

    const run = Effect.fnUntraced(function* <T>(file: string, fn: (client: LSPClient.Info) => Promise<T>) {
      const clients = yield* getClients(file)
      return yield* Effect.promise(() => Promise.all(clients.map((x) => fn(x))))
    })

    const runAll = Effect.fnUntraced(function* <T>(fn: (client: LSPClient.Info) => Promise<T>) {
      const s = yield* InstanceState.get(state)
      return yield* Effect.promise(() => Promise.all(s.clients.map((x) => fn(x))))
    })

    const init = Effect.fn("LSP.init")(function* () {
      yield* InstanceState.get(state)
    })

    const status = Effect.fn("LSP.status")(function* () {
      const ctx = yield* InstanceState.context
      const s = yield* InstanceState.get(state)
      const result: Status[] = []
      for (const client of s.clients) {
        result.push({
          id: client.serverID,
          name: s.servers[client.serverID].id,
          root: path.relative(ctx.directory, client.root),
          status: "connected",
        })
      }
      return result
    })

    const hasClients = Effect.fn("LSP.hasClients")(function* (file: string) {
      const ctx = yield* InstanceState.context
      const s = yield* InstanceState.get(state)
      return yield* Effect.promise(async () => {
        const extension = path.parse(file).ext || file
        for (const server of Object.values(s.servers)) {
          if (server.extensions.length && !server.extensions.includes(extension)) continue
          const root = await server.root(file, ctx)
          if (!root) continue
          if (s.broken.has(root + server.id)) continue
          return true
        }
        return false
      })
    })

    const touchFile = Effect.fn("LSP.touchFile")(function* (input: string, diagnostics?: "document" | "full") {
      log.info("touching file", { file: input })
      const clients = yield* getClients(input)
      yield* Effect.promise(() =>
        Promise.all(
          clients.map(async (client) => {
            const after = Date.now()
            const version = await client.notify.open({ path: input })
            if (!diagnostics) return
            return client.waitForDiagnostics({
              path: input,
              version,
              mode: diagnostics,
              after,
            })
          }),
        ).catch((err) => {
          log.error("failed to touch file", { err, file: input })
        }),
      )
    })

    const diagnostics = Effect.fn("LSP.diagnostics")(function* () {
      const results: Record<string, LSPClient.Diagnostic[]> = {}
      const all = yield* runAll(async (client) => client.diagnostics)
      for (const result of all) {
        for (const [p, diags] of result.entries()) {
          const arr = results[p] || []
          arr.push(...diags)
          results[p] = arr
        }
      }
      return results
    })

    const hover = Effect.fn("LSP.hover")(function* (input: LocInput) {
      return yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/hover", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
    })

    const definition = Effect.fn("LSP.definition")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/definition", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
      return results.flat().filter(Boolean)
    })

    const references = Effect.fn("LSP.references")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/references", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
            context: { includeDeclaration: true },
          })
          .catch(() => []),
      )
      return results.flat().filter(Boolean)
    })

    const implementation = Effect.fn("LSP.implementation")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/implementation", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
      return results.flat().filter(Boolean)
    })

    const documentSymbol = Effect.fn("LSP.documentSymbol")(function* (uri: string) {
      const file = fileURLToPath(uri)
      const results = yield* run(file, (client) =>
        client.connection.sendRequest("textDocument/documentSymbol", { textDocument: { uri } }).catch(() => []),
      )
      return (results.flat() as (DocumentSymbol | Symbol)[]).filter(Boolean)
    })

    const workspaceSymbol = Effect.fn("LSP.workspaceSymbol")(function* (
      query: string,
      options?: { limit?: number; kinds?: number[] },
    ) {
      // L1 (S1-v3.4): limit and kinds are now parameters (defaults unchanged) so L2/L3
      // can widen the search per intent. Defaults preserve the original behavior.
      const limit = options?.limit ?? 10
      const kindFilter = options?.kinds ?? kinds
      const results = yield* runAll((client) =>
        client.connection
          .sendRequest<Symbol[]>("workspace/symbol", { query })
          .then((result) => result.filter((x) => kindFilter.includes(x.kind)).slice(0, limit))
          .catch(() => [] as Symbol[]),
      )
      return results.flat()
    })

    const prepareCallHierarchy = Effect.fn("LSP.prepareCallHierarchy")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/prepareCallHierarchy", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => []),
      )
      return results.flat().filter(Boolean)
    })

    const callHierarchyRequest = Effect.fnUntraced(function* (
      input: LocInput,
      direction: "callHierarchy/incomingCalls" | "callHierarchy/outgoingCalls",
    ) {
      const results = yield* run(input.file, async (client) => {
        const items = await client.connection
          .sendRequest<unknown[] | null>("textDocument/prepareCallHierarchy", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => [] as unknown[])
        if (!items?.length) return []
        return client.connection.sendRequest(direction, { item: items[0] }).catch(() => [])
      })
      return results.flat().filter(Boolean)
    })

    const incomingCalls = Effect.fn("LSP.incomingCalls")(function* (input: LocInput) {
      return yield* callHierarchyRequest(input, "callHierarchy/incomingCalls")
    })

    const outgoingCalls = Effect.fn("LSP.outgoingCalls")(function* (input: LocInput) {
      return yield* callHierarchyRequest(input, "callHierarchy/outgoingCalls")
    })

    // --- L1 (S1-v3.4) high-value wrappers (thin, same shape as definition/hover) ---

    const textDocumentPositionRequest = (method: string) =>
      Effect.fnUntraced(function* (input: LocInput) {
        const results = yield* run(input.file, (client) =>
          client.connection
            .sendRequest(method, {
              textDocument: { uri: pathToFileURL(input.file).href },
              position: { line: input.line, character: input.character },
            })
            .catch(() => null),
        )
        return results.flat().filter(Boolean)
      })

    const typeDefinition = Effect.fn("LSP.typeDefinition")(textDocumentPositionRequest("textDocument/typeDefinition"))
    const declaration = Effect.fn("LSP.declaration")(textDocumentPositionRequest("textDocument/declaration"))
    const documentHighlight = Effect.fn("LSP.documentHighlight")(
      textDocumentPositionRequest("textDocument/documentHighlight"),
    )
    const selectionRange = Effect.fn("LSP.selectionRange")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/selectionRange", {
            textDocument: { uri: pathToFileURL(input.file).href },
            positions: [{ line: input.line, character: input.character }],
          })
          .catch(() => []),
      )
      return results.flat().filter(Boolean)
    })

    // Type hierarchy: prepare-then-direction, mirroring callHierarchyRequest.
    const typeHierarchyRequest = (direction: "typeHierarchy/supertypes" | "typeHierarchy/subtypes") =>
      Effect.fnUntraced(function* (input: LocInput) {
        const results = yield* run(input.file, async (client) => {
          const items = await client.connection
            .sendRequest<unknown[] | null>("textDocument/prepareTypeHierarchy", {
              textDocument: { uri: pathToFileURL(input.file).href },
              position: { line: input.line, character: input.character },
            })
            .catch(() => [] as unknown[])
          if (!items?.length) return []
          return client.connection.sendRequest(direction, { item: items[0] }).catch(() => [])
        })
        return results.flat().filter(Boolean)
      })

    const prepareTypeHierarchy = Effect.fn("LSP.prepareTypeHierarchy")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/prepareTypeHierarchy", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => []),
      )
      return results.flat().filter(Boolean)
    })
    const supertypes = Effect.fn("LSP.supertypes")(typeHierarchyRequest("typeHierarchy/supertypes"))
    const subtypes = Effect.fn("LSP.subtypes")(typeHierarchyRequest("typeHierarchy/subtypes"))

    const inlayHint = Effect.fn("LSP.inlayHint")(function* (input: RangeInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/inlayHint", {
            textDocument: { uri: pathToFileURL(input.file).href },
            range: { start: input.start, end: input.end },
          })
          .catch(() => []),
      )
      return results.flat().filter(Boolean)
    })

    const codeAction = Effect.fn("LSP.codeAction")(function* (input: RangeInput & { diagnostics?: any[] }) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/codeAction", {
            textDocument: { uri: pathToFileURL(input.file).href },
            range: { start: input.start, end: input.end },
            context: { diagnostics: input.diagnostics ?? [] },
          })
          .catch(() => []),
      )
      return results.flat().filter(Boolean)
    })

    const executeCommand = Effect.fn("LSP.executeCommand")(function* (command: string, args?: any[]) {
      // L1 §5 write boundary: executing a command may compute a WorkspaceEdit. The Service
      // returns whatever the command yields; callers (code_intel) only surface query/preview
      // commands and must treat any returned/applied edit as a preview (no write).
      const results = yield* runAll((client) =>
        client.connection.sendRequest("workspace/executeCommand", { command, arguments: args ?? [] }).catch(() => null),
      )
      return results.find((r) => r != null) ?? null
    })

    const prepareRename = Effect.fn("LSP.prepareRename")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/prepareRename", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
      return results.find((r) => r != null) ?? null
    })

    const rename = Effect.fn("LSP.rename")(function* (input: LocInput & { newName: string }) {
      // L1 §4 safety: rename ONLY returns the WorkspaceEdit preview. It never writes files;
      // applying the edit must go through edit/apply_patch (permission gate + diagnostic loop).
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/rename", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
            newName: input.newName,
          })
          .catch(() => null),
      )
      return results.find((r) => r != null) ?? null
    })

    const foldingRange = Effect.fn("LSP.foldingRange")(function* (uri: string) {
      const file = fileURLToPath(uri)
      const results = yield* run(file, (client) =>
        client.connection.sendRequest("textDocument/foldingRange", { textDocument: { uri } }).catch(() => []),
      )
      return results.flat().filter(Boolean)
    })

    // L1 low agent-value: kept on the Service, intentionally NOT in the code_intel intent set.
    const completion = Effect.fn("LSP.completion")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/completion", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
      return results.find((r) => r != null) ?? null
    })
    const signatureHelp = Effect.fn("LSP.signatureHelp")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/signatureHelp", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
      return results.find((r) => r != null) ?? null
    })

    const serverCapabilities = Effect.fn("LSP.serverCapabilities")(function* (file: string) {
      const clients = yield* getClients(file)
      for (const client of clients) {
        const caps = client.getServerCapabilities()
        if (caps) return caps as Record<string, unknown>
      }
      return undefined
    })

    // L4 (S1-v3.4): "what compiles broken across the whole repo" — workspace/diagnostic pull
    // where the server advertises it, otherwise fall back to aggregating the per-file
    // diagnostics we already hold (push + prior pulls). Graceful: unsupported → fallback,
    // never throws.
    const workspaceDiagnostics = Effect.fn("LSP.workspaceDiagnostics")(function* () {
      const s = yield* InstanceState.get(state)
      const results: Record<string, LSPClient.Diagnostic[]> = {}
      const all = yield* Effect.promise(() =>
        Promise.all(
          s.clients.map(async (client) => {
            const caps = client.getServerCapabilities()
            if (!caps?.diagnosticProvider) return null
            return client.connection
              .sendRequest<{
                items?: { uri?: string; items?: LSPClient.Diagnostic[] }[]
              } | null>("workspace/diagnostic", { previousResultIds: [] })
              .catch(() => null)
          }),
        ),
      )
      let any = false
      for (const report of all) {
        if (!report?.items) continue
        any = true
        for (const item of report.items) {
          if (!item.uri || !Array.isArray(item.items)) continue
          const p = item.uri.startsWith("file://") ? fileURLToPath(item.uri) : item.uri
          const arr = results[p] ?? []
          arr.push(...item.items)
          results[p] = arr
        }
      }
      // Fallback: no server answered workspace/diagnostic → aggregate known per-file diagnostics.
      if (!any) {
        const known = yield* diagnostics()
        return known
      }
      return results
    })

    return Service.of({
      init,
      status,
      hasClients,
      touchFile,
      diagnostics,
      hover,
      definition,
      references,
      implementation,
      documentSymbol,
      workspaceSymbol,
      prepareCallHierarchy,
      incomingCalls,
      outgoingCalls,
      typeDefinition,
      declaration,
      prepareTypeHierarchy,
      supertypes,
      subtypes,
      inlayHint,
      codeAction,
      executeCommand,
      prepareRename,
      rename,
      documentHighlight,
      foldingRange,
      selectionRange,
      completion,
      signatureHelp,
      serverCapabilities,
      workspaceDiagnostics,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
)

export * as Diagnostic from "./diagnostic"

export * as LSP from "./lsp"
