import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DocumentStore, type CreateDocInput } from "@deepagent-code/core/deepagent/document-store"

// A fresh on-disk DocumentStore in a temp dir. Callers rmSync the returned root in afterEach.
export const freshStore = (): { store: DocumentStore; root: string } => {
  const root = mkdtempSync(path.join(tmpdir(), "deepagent-wiki-"))
  return { store: new DocumentStore(root), root }
}

const modelProv = { source: "model" as const, run_ref: "run:t1" }

// A knowledge doc (editable, carries confidence).
export const knowledgeInput = (over: Partial<CreateDocInput> = {}): CreateDocInput => ({
  type: "knowledge",
  scope: "durable",
  body: "knowledge body",
  description: "a governed fact",
  confidence: { evidence_strength: "medium", support_count: 2 },
  provenance: modelProv,
  ...over,
})

// A design doc (Document graph → read-only).
export const designInput = (over: Partial<CreateDocInput> = {}): CreateDocInput => ({
  type: "design",
  scope: "durable",
  body: "design body",
  description: "auth design",
  provenance: modelProv,
  ...over,
})

// A file-level code_symbol node (Code graph → read-only). description = file path (§A.3).
export const codeFileInput = (filePath = "src/foo.ts", over: Partial<CreateDocInput> = {}): CreateDocInput => ({
  type: "code_symbol",
  scope: "durable",
  body: `path: ${filePath}`,
  description: filePath,
  tags: ["code"],
  provenance: { source: "tool" },
  idSlug: filePath,
  extensions: { content_sha: "sha", language: "typescript" },
  ...over,
})

// A symbol child code_symbol node (identity path#symbolPath, carries range for file:line, §A.3).
export const codeSymbolInput = (
  filePath = "src/foo.ts",
  symbolPath = "Foo.bar",
  start = 9,
  over: Partial<CreateDocInput> = {},
): CreateDocInput => {
  const key = `${filePath}#${symbolPath}`
  return {
    type: "code_symbol",
    scope: "durable",
    body: `symbol: ${symbolPath}`,
    description: key,
    tags: ["code", "symbol"],
    provenance: { source: "tool" },
    idSlug: key,
    extensions: {
      kind: "method",
      symbol_path: symbolPath,
      host_path: filePath,
      range: { start, end: start + 5 },
    },
    ...over,
  }
}
