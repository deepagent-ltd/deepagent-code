import { Effect } from "effect"
import { LLM, Message, type Model, type LLMClientService } from "@deepagent-code/llm"
import type { DocumentStore } from "../document-store"
import type { ContextConfig } from "./config"
import { estimate } from "./token-meter"

// V3.8 Appendix-A C1.5 — chunked ingest. When an input (a big file / a batch / a whole book) itself
// exceeds the 50% Working Set ceiling, we NEVER widen the working set. Instead we run a separate
// map-reduce ingest that digests the big input, OUTSIDE the context, into a RETRIEVABLE memory doc:
//   1. chunk by natural structure (chapters / files / modules / time windows), each far below the
//      ceiling (config.ingestChunkTokens),
//   2. map: summarize each chunk -> one memory entry with a POSITION REFERENCE (offset/line/heading),
//   3. reduce: fold the chunk summaries into a top-level memory,
//   4. land it as a retrievable artifact (a `memory`/`artifact` doc) so later questions re-query the
//      relevant chunk by reference instead of re-reading the whole input.
//
// This module is the PURE pipeline (chunking + orchestration). The actual per-chunk summarization is
// an INJECTED function (`summarize`) — same shape as the A4 map-reduce segment-summarize mechanism —
// so this stays testable without an LLM: a test injects a deterministic summarizer. The 50% ceiling
// is respected structurally: chunks are sized to ingestChunkTokens and only ONE chunk is "in hand" at
// a time (the pipeline never accumulates the whole input in memory-as-context).

export type Chunk = {
  readonly index: number
  readonly heading: string
  readonly text: string
  // Position reference back into the source for on-demand re-read (C1.5 §2 "原文位置引用").
  readonly startOffset: number
  readonly endOffset: number
}

// Split text into chunks by natural structure. Prefers markdown-style headings (# / ## ...); falls
// back to blank-line paragraphs; then packs consecutive units so each chunk is <= targetTokens.
// Never splits mid-line. Offsets are byte-in-string offsets into the original.
export const chunkByStructure = (text: string, targetTokens: number): Chunk[] => {
  if (!text) return []
  const lines = text.split("\n")
  // Build units: a unit starts at each heading line, otherwise groups run until the next heading.
  type Unit = { heading: string; start: number; end: number }
  const units: Unit[] = []
  let offset = 0
  let cur: Unit | null = null
  const isHeading = (l: string) => /^#{1,6}\s+/.test(l)
  for (const line of lines) {
    const lineLen = line.length + 1 // +\n
    if (isHeading(line) || cur === null) {
      if (cur) units.push(cur)
      cur = { heading: isHeading(line) ? line.replace(/^#+\s+/, "").trim() : "section", start: offset, end: offset + lineLen }
    } else {
      cur.end = offset + lineLen
    }
    offset += lineLen
  }
  if (cur) units.push(cur)

  // Pack units into chunks under the token budget.
  const chunks: Chunk[] = []
  let buf: { heading: string; start: number; end: number; text: string } | null = null
  const flush = () => {
    if (!buf) return
    chunks.push({ index: chunks.length, heading: buf.heading, text: buf.text, startOffset: buf.start, endOffset: buf.end })
    buf = null
  }
  for (const u of units) {
    const utext = text.slice(u.start, u.end)
    if (!buf) {
      buf = { heading: u.heading, start: u.start, end: u.end, text: utext }
    } else if (estimate(buf.text + utext) <= targetTokens) {
      buf.text += utext
      buf.end = u.end
    } else {
      flush()
      buf = { heading: u.heading, start: u.start, end: u.end, text: utext }
    }
    // A single oversized unit still becomes its own chunk (can't split a line-run further here).
    if (buf && estimate(buf.text) > targetTokens) flush()
  }
  flush()
  return chunks
}

export type ChunkSummary = {
  readonly index: number
  readonly heading: string
  readonly summary: string
  readonly startOffset: number
  readonly endOffset: number
}

// The injected summarizer: chunk text -> a short summary. Effectful shape left to the caller (sync
// here for the pure pipeline; the session-side caller can adapt an LLM call via a sync-over-async
// bridge or precompute).
export type Summarize = (chunk: Chunk) => string

export type IngestResult = {
  readonly chunkSummaries: readonly ChunkSummary[]
  readonly topLevel: string
  // The persisted memory doc id (when a store is provided).
  readonly memoryDocId?: string
}

// Run the ingest pipeline over a big input. `sourceName` labels the memory doc (file path / title).
// map: summarize each chunk; reduce: fold summaries into a top-level memory. When `store` is given,
// persist a position-referenced `memory` doc (retrievable artifact) and return its id.
export const ingest = (input: {
  sourceName: string
  text: string
  config: ContextConfig
  summarize: Summarize
  reduce?: (summaries: readonly ChunkSummary[]) => string
  store?: DocumentStore
  scope?: string
}): IngestResult => {
  const chunks = chunkByStructure(input.text, input.config.ingestChunkTokens)
  const chunkSummaries: ChunkSummary[] = chunks.map((c) => ({
    index: c.index,
    heading: c.heading,
    summary: input.summarize(c),
    startOffset: c.startOffset,
    endOffset: c.endOffset,
  }))
  const topLevel = input.reduce
    ? input.reduce(chunkSummaries)
    : defaultReduce(input.sourceName, chunkSummaries)

  let memoryDocId: string | undefined
  if (input.store) {
    // The memory doc body keeps BOTH the top-level memory and each chunk's summary + position ref, so
    // a later question can locate the relevant chunk and re-read only that slice of the source.
    const body = JSON.stringify(
      {
        source: input.sourceName,
        topLevel,
        chunks: chunkSummaries,
      },
      null,
      2,
    )
    const doc = input.store.upsert({
      type: "memory",
      scope: input.scope ?? "durable",
      idSlug: `ingest-${input.sourceName}`,
      description: `file memory: ${input.sourceName}`,
      body,
      tags: ["ingest", "file-memory"],
      provenance: { source: "runner" },
      // memory is a KNOWLEDGE_TYPE -> requires confidence. This is derived-from-source, medium
      // evidence with support = chunk count.
      confidence: { evidence_strength: "medium", support_count: chunkSummaries.length },
    })
    memoryDocId = doc.id
  }

  return { chunkSummaries, topLevel, ...(memoryDocId ? { memoryDocId } : {}) }
}

const defaultReduce = (source: string, summaries: readonly ChunkSummary[]): string =>
  [`# Memory: ${source}`, "", ...summaries.map((s) => `- [${s.heading}] ${s.summary}`)].join("\n")

// Re-read a specific chunk's original text from the source using a stored position reference (C1.5
// "按引用回查那一块的原文"). Pure slice — the caller supplies the original source text.
export const rereadChunk = (sourceText: string, ref: { startOffset: number; endOffset: number }): string =>
  sourceText.slice(ref.startOffset, ref.endOffset)

// --- production LLM summarizer adapter (C1.5 map step, real LLM) -----------------------------------
//
// The pure `ingest` above takes a SYNC `Summarize` (chunk -> string) so it stays testable without an
// LLM. A real deployment must summarize each chunk with the model. That is inherently ASYNC, and the
// sync boundary of `ingest` cannot call the LLM inline. We honestly bridge the gap the same way the A4
// map-reduce mechanism does: PRE-COMPUTE every chunk summary via the LLM (async, concurrent, bounded),
// then run the pure `ingest` with a sync lookup into the precomputed map. No sync-over-async blocking.
//
// This reuses the EXISTING LLM capability (@deepagent-code/llm LLMClient.generate — the same client the
// session-side compaction summarizer streams through), not a parallel model path. The prompt mirrors
// compaction's terse-summary style. Caps are LENIENT/configurable (maxSummaryTokens defaults high).

export type LlmSummarizerOptions = {
  readonly model: Model
  // Lenient default; a chunk summary is short by design but we do not bake a tight cap.
  readonly maxSummaryTokens?: number
  // Bounded concurrency for the pre-summarize map (lenient default 4).
  readonly concurrency?: number
  // Optional instruction override; defaults to a terse map-step summary prompt.
  readonly instruction?: string
}

const DEFAULT_SUMMARY_TOKENS = 512
const DEFAULT_INGEST_CONCURRENCY = 4
const DEFAULT_SUMMARY_INSTRUCTION =
  "Summarize the following section in 1-3 terse bullet points. Preserve exact identifiers, file paths, " +
  "commands, and error strings. Output only the bullets, no preamble."

// Summarize ONE chunk via the LLM. Effect over LLMClient.Service (provided by the caller's runtime —
// the gateway already wires LLMClient.layer). Returns the assembled assistant text.
export const summarizeChunkEffect = (
  chunk: Chunk,
  opts: LlmSummarizerOptions,
): Effect.Effect<string, never, LLMClientService> =>
  Effect.gen(function* () {
    const instruction = opts.instruction ?? DEFAULT_SUMMARY_INSTRUCTION
    const prompt = `${instruction}\n\n<section heading="${chunk.heading}">\n${chunk.text}\n</section>`
    const response = yield* LLM.generate(
      LLM.request({
        model: opts.model,
        messages: [Message.user(prompt)],
        tools: [],
        generation: { maxTokens: opts.maxSummaryTokens ?? DEFAULT_SUMMARY_TOKENS },
      }),
    )
    return response.text.trim()
  }).pipe(
    // DEFAULT-SAFE: a per-chunk LLM failure (typed error or defect) degrades to a position-referenced
    // placeholder rather than failing the whole ingest — the chunk is still retrievable by heading +
    // offsets. matchCauseEffect recovers the CAUSE (defects included), consistent with the module.
    Effect.matchCauseEffect({
      onFailure: () => Effect.succeed(`[summary unavailable] ${chunk.heading}`),
      onSuccess: (text) => Effect.succeed(text),
    }),
  )

// The Effect-returning production ingest: pre-summarize every chunk with the LLM (bounded concurrency),
// then run the PURE `ingest` with a sync lookup into the precomputed summaries. Same output shape as
// `ingest`; the only difference is the summarizer is a real model call resolved before the sync pass.
export const ingestEffect = (input: {
  sourceName: string
  text: string
  config: ContextConfig
  summarizer: LlmSummarizerOptions
  reduce?: (summaries: readonly ChunkSummary[]) => string
  store?: DocumentStore
  scope?: string
}): Effect.Effect<IngestResult, never, LLMClientService> =>
  Effect.gen(function* () {
    const chunks = chunkByStructure(input.text, input.config.ingestChunkTokens)
    const summaries = yield* Effect.forEach(chunks, (c) => summarizeChunkEffect(c, input.summarizer), {
      concurrency: input.summarizer.concurrency ?? DEFAULT_INGEST_CONCURRENCY,
    })
    // Precomputed map keyed by chunk index; the sync `ingest` looks up here (no async at the boundary).
    const byIndex = new Map<number, string>(chunks.map((c, i) => [c.index, summaries[i]!]))
    return ingest({
      sourceName: input.sourceName,
      text: input.text,
      config: input.config,
      summarize: (c) => byIndex.get(c.index) ?? `[summary unavailable] ${c.heading}`,
      ...(input.reduce ? { reduce: input.reduce } : {}),
      ...(input.store ? { store: input.store } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
    })
  })
