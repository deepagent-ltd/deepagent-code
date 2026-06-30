import { Effect } from "effect"
import path from "path"
import { pathToFileURL, fileURLToPath } from "url"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { LSP } from "@/lsp/lsp"

// L4 (S1-v3.4) §1: after an edit/write, surface diagnostics in the *referencing* files —
// the "I changed a signature, did I break a caller" case. This walks the changed file's
// top-level symbols → references → the bounded set of OTHER files that reference them,
// touches them, and reports their error diagnostics.
//
// Gated to high+ modes ONLY (same philosophy as the plan-stale latch): in lightweight
// (general/direct) modes this is a NO-OP — no extra LSP round-trips, no behavior change,
// so the default agent does not regress (acceptance (e)). The manual
// `code_intel intent:"diagnostics" scope:"symbol"` path stays available in every mode.

const MAX_CALLER_FILES = 5

export const crossFileCallerDiagnostics = (
  lsp: LSP.Interface,
  changedFile: string,
  worktree: string,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const agentMode = AgentGateway.snapshot().agentMode ?? "high"
    if (AgentGateway.DeepAgentPlanController.isLightweightMode(agentMode)) return ""

    // Top-level symbols of the changed file → coordinates to query references from.
    const symbols = yield* lsp
      .documentSymbol(pathToFileURL(changedFile).href)
      .pipe(Effect.catch(() => Effect.succeed([] as any[])))

    const callerFiles = new Set<string>()
    for (const sym of symbols) {
      if (callerFiles.size >= MAX_CALLER_FILES) break
      const range = "selectionRange" in sym ? sym.selectionRange : (sym as any).location?.range
      if (!range?.start) continue
      const refs = yield* lsp
        .references({ file: changedFile, line: range.start.line, character: range.start.character })
        .pipe(Effect.catch(() => Effect.succeed([] as any[])))
      for (const ref of refs) {
        const uri: string | undefined = ref?.uri ?? ref?.location?.uri
        if (!uri) continue
        const f = uri.startsWith("file://") ? fileURLToPath(uri) : uri
        if (FSUtil.normalizePath(f) === FSUtil.normalizePath(changedFile)) continue
        callerFiles.add(f)
        if (callerFiles.size >= MAX_CALLER_FILES) break
      }
    }
    if (!callerFiles.size) return ""

    for (const f of callerFiles) {
      yield* lsp.touchFile(f, "document").pipe(Effect.catch(() => Effect.void))
    }
    const diagnostics = yield* lsp.diagnostics()

    let out = ""
    for (const f of callerFiles) {
      const issues = diagnostics[f] ?? diagnostics[FSUtil.normalizePath(f)] ?? []
      const block = LSP.Diagnostic.report(path.relative(worktree, f), issues)
      if (block) out += `\n\nLSP errors in a referencing file (your change may have broken it):\n${block}`
    }
    return out
  })
