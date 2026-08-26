export * as ColdCodeBootstrap from "./cold-bootstrap"

import { ContextAdapters } from "@deepagent-code/core/context-federation/adapters"
import { ContextAuthorization, type EgressPolicy, type Principal } from "@deepagent-code/core/context-federation/authorization"
import { ContextFederation } from "@deepagent-code/core/context-federation/federation"
import type { Identity } from "@deepagent-code/core/context-federation/identity"
import type { ContextRef } from "@deepagent-code/core/context-federation/reference"
import { Hash } from "@deepagent-code/core/util/hash"
import { Effect } from "effect"
import { fileEntityId } from "./typescript-workspace-adapter"
import { scan, type File } from "../location-index/manifest"

const Source = "cold_bootstrap"

export type MaterializedHit = {
  readonly candidate: ContextFederation.ContextCandidate
  readonly contentSource: "filesystem"
  readonly contentSha: string
  readonly path: string
}

export type Result = ContextAdapters.Result & {
  readonly materialized: readonly MaterializedHit[]
  readonly scannedFiles: number
  readonly scannedBytes: number
  readonly complete: boolean
}

export type Input = {
  readonly root: string
  readonly identity: Identity
  readonly principal: Principal
  readonly egress: EgressPolicy
  readonly text: string
  readonly limit?: number
  readonly maxFiles?: number
  readonly maxBytes?: number
  readonly timeoutMs?: number
}

export function query(input: Input): Effect.Effect<Result> {
  const gate = ContextAuthorization.authorize({
    ref: ref(input.identity, "bootstrap_gate", "bootstrap:gate"),
    principal: input.principal,
    egress: input.egress,
    sensitivity: "source_code",
  })
  if (!gate.allowed) {
    const reasonCode = gate.reason === "provider_egress_denied" ? "provider_egress_denied" as const : "scope_denied" as const
    return Effect.succeed({
      candidates: [],
      materialized: [],
      scannedFiles: 0,
      scannedBytes: 0,
      complete: false,
      status: ContextFederation.status.blocked({
        graph: "code",
        state: "denied",
        reasonCode,
        revisions: [{ source: Source, state: "denied", reasonCode }],
      }),
    })
  }
  const deadline = Date.now() + Math.min(Math.max(input.timeoutMs ?? 750, 1), 2_000)
  return Effect.tryPromise(() =>
    scan({
      root: input.root,
      maxFiles: Math.min(Math.max(input.maxFiles ?? 256, 1), 256),
      maxBytes: Math.min(Math.max(input.maxBytes ?? 2 * 1024 * 1024, 1), 2 * 1024 * 1024),
      deadline,
    }),
  ).pipe(
    Effect.map((manifest) => {
      const terms = input.text.toLowerCase().match(/[\p{L}\p{N}_$.-]{2,}/gu) ?? []
      const materialized = manifest.files
        .flatMap((file) => {
          const scored = score(file, input.text, terms)
          if (scored.lexical === 0 && scored.exact === 0) return []
          const contentSha = Hash.sha256(file.content)
          const candidate = ContextFederation.candidate({
            ref: ref(input.identity, fileEntityId(file.path), `bootstrap:${contentSha}`, file.path),
            graph: "code",
            title: file.path,
            summary: excerpt(file, terms),
            relations: [],
            provenance: [],
            features: {
              exact: scored.exact,
              lexical: scored.lexical,
              authority: 0.8,
              evidence: 0.7,
              freshness: 1,
            },
            trust: "repository_evidence",
            visibility: "model",
          })
          return [{ candidate, contentSource: "filesystem" as const, contentSha, path: file.path }]
        })
        .toSorted((a, b) =>
          b.candidate.features.exact - a.candidate.features.exact ||
          b.candidate.features.lexical - a.candidate.features.lexical ||
          a.path.localeCompare(b.path),
        )
        .slice(0, Math.min(Math.max(input.limit ?? 12, 0), 12))
      const revision = Hash.sha256(JSON.stringify(manifest.files.map((file) => ({
        path: file.path,
        contentSha: Hash.sha256(file.content),
        mtimeNs: file.mtimeNs,
      }))))
      const reasonCode = Date.now() >= deadline ? "bootstrap_timeout" as const : "bootstrap_budget_exhausted" as const
      return {
        candidates: materialized.map((hit) => hit.candidate),
        materialized,
        scannedFiles: manifest.files.length,
        scannedBytes: manifest.totalBytes,
        complete: manifest.complete,
        status: materialized.length > 0
          ? ContextFederation.status.partial({
              graph: "code",
              state: "cold",
              reasonCode: manifest.complete ? "cold_start" : reasonCode,
              revisions: [{
                source: Source,
                revision,
                state: "cold",
                reasonCode: manifest.complete ? "cold_start" : reasonCode,
              }],
            })
          : manifest.complete
            ? ContextFederation.status.empty(
                "code",
                [{ source: Source, revision, state: "ready" }],
                { bootstrapComplete: true },
              )
            : ContextFederation.status.partial({
                graph: "code",
                state: "cold",
                reasonCode,
                revisions: [{ source: Source, revision, state: "cold", reasonCode }],
              }),
      }
    }),
    Effect.catch(() => Effect.succeed({
      candidates: [],
      materialized: [],
      scannedFiles: 0,
      scannedBytes: 0,
      complete: false,
      status: ContextFederation.status.blocked({
        graph: "code",
        state: "unavailable",
        reasonCode: "source_error",
        revisions: [{ source: Source, state: "unavailable", reasonCode: "source_error" }],
      }),
    })),
  )
}

export function adapter(input: Omit<Input, "text" | "limit">): ContextAdapters.Adapter {
  return {
    graph: "code",
    source: Source,
    query: (request) => query({ ...input, text: request.text, limit: request.limit }),
  }
}

function ref(identity: Identity, entityId: string, revision: string, filePath?: string): ContextRef {
  return {
    graph: "code",
    entityId,
    binding: {
      scope: "location",
      securityNamespaceId: identity.securityNamespaceId,
      locationKey: identity.locationKey,
      projectScopeKey: identity.projectScopeKey,
    },
    ...(filePath ? { locator: { path: filePath } } : {}),
    revision,
  }
}

function score(file: File, text: string, terms: readonly string[]) {
  const query = text.trim().toLowerCase()
  const filePath = file.path.toLowerCase()
  const searchable = `${filePath}\n${file.content.slice(0, 256 * 1024).toLowerCase()}`
  const matched = new Set(terms.filter((term) => searchable.includes(term))).size
  return {
    exact: query && (filePath === query || filePath.endsWith(`/${query}`)) ? 1 : 0,
    lexical: terms.length === 0 ? 0 : Math.min(1, matched / terms.length),
  }
}

function excerpt(file: File, terms: readonly string[]) {
  const lines = file.content.split(/\r?\n/)
  const matches = lines
    .map((line, index) => ({ line, index }))
    .filter((item) => terms.some((term) => item.line.toLowerCase().includes(term)))
    .slice(0, 8)
  return (matches.length > 0 ? matches : lines.slice(0, 8).map((line, index) => ({ line, index })))
    .map((item) => `${item.index + 1}: ${item.line}`)
    .join("\n")
    .slice(0, 800)
}
