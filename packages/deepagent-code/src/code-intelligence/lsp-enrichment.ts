export * as LiveCodeLSPEnrichment from "./lsp-enrichment"

import { InstanceRef } from "@/effect/instance-ref"
import { LSP } from "@/lsp/lsp"
import { CodeLSPEnrichment } from "@deepagent-code/core/code-intelligence/lsp-enrichment"
import { Effect, Layer, Schema } from "effect"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export function make(input: {
  readonly root: string
  readonly lsp: LSP.Interface
  readonly timeoutMs: number
}): CodeLSPEnrichment.Interface {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) throw new Error("invalid LSP enrichment timeout")
  const enrich: CodeLSPEnrichment.Interface["enrich"] = (request) => {
    if (!Number.isSafeInteger(request.limit) || request.limit < 0 || request.limit > 100) return unavailable("source_error")
    const absolute = request.path ? resolvePath(input.root, request.path) : undefined
    if (request.path && !absolute) return unavailable("source_error")
    if (request.intent !== "search" && request.intent !== "outline" && !validPosition(request)) {
      return unavailable("source_error")
    }
    return Effect.gen(function* () {
      if (absolute) {
        if (!(yield* input.lsp.hasClients(absolute))) return { state: "unavailable" as const, reasonCode: "lsp_unavailable" as const, observations: [] }
        yield* input.lsp.touchFile(absolute)
      } else {
        const status = yield* input.lsp.status()
        if (!status.some((item) => item.status === "connected")) {
          return { state: "unavailable" as const, reasonCode: "lsp_unavailable" as const, observations: [] }
        }
      }
      const values = yield* execute(input.lsp, request, absolute)
      return {
        state: "ready" as const,
        observations: values
          .flatMap((value) => normalize(value, input.root, absolute))
          .slice(0, request.limit)
          .map((value) => Schema.decodeUnknownSync(CodeLSPEnrichment.Observation, { onExcessProperty: "error" })(value)),
      }
    }).pipe(
      Effect.timeout(input.timeoutMs),
      Effect.catch(() => unavailable("source_timeout")),
    )
  }
  return { enrich }
}

export function layer(config: { readonly timeoutMs: number }) {
  return Layer.effect(
    CodeLSPEnrichment.Service,
    Effect.gen(function* () {
      const instance = yield* InstanceRef
      if (!instance) return CodeLSPEnrichment.Service.of({ enrich: () => unavailable("lsp_unavailable") })
      return CodeLSPEnrichment.Service.of(make({ root: instance.directory, lsp: yield* LSP.Service, timeoutMs: config.timeoutMs }))
    }),
  )
}

function execute(lsp: LSP.Interface, request: CodeLSPEnrichment.Request, absolute?: string): Effect.Effect<readonly unknown[]> {
  if (request.intent === "search") return lsp.workspaceSymbol(request.query ?? "", { limit: request.limit })
  if (!absolute) return Effect.succeed([])
  if (request.intent === "outline") return lsp.documentSymbol(pathToFileURL(absolute).href)
  if (request.intent === "diagnostics") {
    return lsp.diagnostics().pipe(Effect.map((diagnostics) => diagnostics[absolute] ?? []))
  }
  const position = { file: absolute, line: request.line! - 1, character: request.character! }
  if (request.intent === "definition") return lsp.definition(position)
  if (request.intent === "references") return lsp.references(position)
  if (request.intent === "implementations") return lsp.implementation(position)
  if (request.intent === "calls_in") return lsp.incomingCalls(position)
  return lsp.outgoingCalls(position)
}

function normalize(value: unknown, root: string, fallbackFile?: string): readonly CodeLSPEnrichment.Observation[] {
  if (!record(value)) return []
  const target = requestTarget(value)
  if (!target) return []
  const absolute = uriPath(target.uri) ?? fallbackFile
  if (!absolute) return []
  const relative = relativePath(root, absolute)
  const range = rangeOf(target.range)
  if (!relative || !range) return []
  return [{
    path: relative,
    startLine: range.start.line + 1,
    startCharacter: range.start.character,
    endLine: range.end.line + 1,
    endCharacter: range.end.character,
    ...(typeof target.symbol === "string" ? { symbol: target.symbol } : {}),
    ...(typeof target.kind === "number" && Number.isSafeInteger(target.kind) && target.kind >= 0 ? { kind: target.kind } : {}),
    ...(typeof target.detail === "string" ? { detail: target.detail.slice(0, 1_000) } : {}),
  }]
}

function requestTarget(value: Record<string, unknown>) {
  const nested = [value.location, value.from, value.to].find(record)
  const target = nested ?? value
  const location = record(target.location) ? target.location : target
  return {
    uri: typeof location.uri === "string" ? location.uri : typeof target.targetUri === "string" ? target.targetUri : undefined,
    range: location.range ?? target.selectionRange ?? target.targetSelectionRange ?? target.targetRange,
    symbol: typeof target.name === "string" ? target.name : typeof value.name === "string" ? value.name : undefined,
    kind: typeof target.kind === "number" ? target.kind : typeof value.kind === "number" ? value.kind : undefined,
    detail: typeof target.detail === "string" ? target.detail : typeof value.detail === "string" ? value.detail : undefined,
  }
}

function rangeOf(value: unknown) {
  if (!record(value) || !position(value.start) || !position(value.end)) return
  return { start: value.start, end: value.end }
}

function position(value: unknown): value is { readonly line: number; readonly character: number } {
  return Boolean(
    record(value) &&
      Number.isSafeInteger(value.line) &&
      Number(value.line) >= 0 &&
      Number.isSafeInteger(value.character) &&
      Number(value.character) >= 0,
  )
}

function uriPath(uri: unknown) {
  if (typeof uri !== "string") return
  if (!uri.startsWith("file:")) return path.resolve(uri)
  return fileURLToPath(uri)
}

function resolvePath(root: string, filePath: string) {
  if (!filePath || filePath.includes("\\")) return
  const absolute = path.resolve(root, filePath)
  return relativePath(root, absolute) ? absolute : undefined
}

function relativePath(root: string, absolute: string) {
  const relative = path.relative(root, absolute).split(path.sep).join("/")
  if (!relative || relative.startsWith("../") || path.posix.isAbsolute(relative)) return
  return relative
}

function validPosition(request: CodeLSPEnrichment.Request) {
  return Boolean(
    request.path &&
      Number.isSafeInteger(request.line) &&
      Number(request.line) > 0 &&
      Number.isSafeInteger(request.character) &&
      Number(request.character) >= 0,
  )
}

function unavailable(reasonCode: "source_timeout" | "source_error" | "lsp_unavailable") {
  return Effect.succeed({
    state: reasonCode === "lsp_unavailable" ? "unavailable" as const : "degraded" as const,
    reasonCode,
    observations: [],
  })
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}
