import { describe, expect, test } from "bun:test"
import { Hash } from "@deepagent-code/core/util/hash"
import path from "node:path"
import { make as makeCodeStore, CommitConflictError } from "../../src/code-intelligence/live-code-graph-store"
import { make as makeDocumentStore } from "../../src/document-intelligence/live-repo-document-store"
import { tmpdir } from "../fixture/fixture"

describe("live Location projection stores", () => {
  test("publishes full Code generations atomically and retains unchanged rows incrementally", async () => {
    await using tmp = await tmpdir()
    const store = makeCodeStore({
      filename: path.join(tmp.path, "code.sqlite"),
      indexSpaceId: "index-one",
      indexIncarnation: 1,
      canonicalRoot: tmp.path,
      adapterSetVersion: "ts-js-v1",
    })
    try {
      const first = store.fullCommit({
        indexIncarnation: 1,
        fencingToken: 1,
        expectedGeneration: 0,
        indexedAt: 10,
        build: {
          files: [file("src/a.ts", "export function alpha() {}"), file("src/b.ts", "export function beta() {}")],
          externalEntities: [],
          edges: [],
          aliases: [],
        },
      })
      expect(first).toMatchObject({ projectionKind: "code", indexIncarnation: 1, generation: 1 })
      expect(store.search({ query: "alpha", limit: 10 }).hits).toHaveLength(2)
      expect(store.search({ query: "beta", limit: 10 }).hits).toHaveLength(2)

      expect(() =>
        store.fullCommit({
          indexIncarnation: 1,
          fencingToken: 1,
          expectedGeneration: 1,
          indexedAt: 20,
          build: {
            files: [file("src/broken.ts", "broken")],
            externalEntities: [],
            edges: [{ fromEntityId: "missing", toEntityId: "also-missing", relation: "calls", evidence: "invalid" }],
            aliases: [],
          },
        }),
      ).toThrow()
      expect(store.snapshot()).toEqual(first)
      expect(store.search({ query: "alpha", limit: 10 }).hits).toHaveLength(2)

      const second = store.incrementalCommit({
        indexIncarnation: 1,
        fencingToken: 2,
        expectedGeneration: 1,
        indexedAt: 30,
        files: [file("src/a.ts", "export function gamma() {}")],
        deletedPaths: [],
      })
      expect(second.generation).toBe(2)
      expect(store.search({ query: "alpha", limit: 10 }).hits).toEqual([])
      expect(store.search({ query: "gamma", limit: 10 }).hits).toHaveLength(2)
      expect(store.search({ query: "beta", limit: 10 }).hits).toHaveLength(2)
      expect(() =>
        store.incrementalCommit({
          indexIncarnation: 1,
          fencingToken: 1,
          expectedGeneration: 1,
          indexedAt: 40,
          files: [],
          deletedPaths: [],
        }),
      ).toThrow(CommitConflictError)

      store.incrementalCommit({
        indexIncarnation: 1,
        fencingToken: 2,
        expectedGeneration: 2,
        indexedAt: 40,
        files: [],
        deletedPaths: ["src/b.ts"],
      })
      expect(store.search({ query: "beta", limit: 10 }).hits).toEqual([])
    } finally {
      store.close()
    }
  })

  test("isolates Code and Repo Documents failures, generations, and Location files", async () => {
    await using tmp = await tmpdir()
    const code = makeCodeStore({
      filename: path.join(tmp.path, "code.sqlite"),
      indexSpaceId: "index-one",
      indexIncarnation: 1,
      canonicalRoot: tmp.path,
      adapterSetVersion: "ts-js-v1",
    })
    const documents = makeDocumentStore({
      filename: path.join(tmp.path, "documents.sqlite"),
      indexSpaceId: "index-one",
      indexIncarnation: 1,
      adapterSetVersion: "markdown-v1",
    })
    const other = makeCodeStore({
      filename: path.join(tmp.path, "other-code.sqlite"),
      indexSpaceId: "index-two",
      indexIncarnation: 1,
      canonicalRoot: path.join(tmp.path, "other"),
      adapterSetVersion: "ts-js-v1",
    })
    try {
      code.fullCommit({
        indexIncarnation: 1,
        fencingToken: 1,
        expectedGeneration: 0,
        indexedAt: 10,
        build: { files: [file("src/shared.ts", "location one marker")], externalEntities: [], edges: [], aliases: [] },
      })
      other.fullCommit({
        indexIncarnation: 1,
        fencingToken: 1,
        expectedGeneration: 0,
        indexedAt: 10,
        build: { files: [file("src/shared.ts", "location two marker")], externalEntities: [], edges: [], aliases: [] },
      })
      const documentRevision = documents.fullCommit({
        indexIncarnation: 1,
        fencingToken: 3,
        expectedGeneration: 0,
        indexedAt: 11,
        documents: [document("README.md", "Architecture", "architecture-anchor", "federated context architecture")],
      })
      expect(documentRevision).toMatchObject({ projectionKind: "repo_documents", generation: 1 })
      expect(code.snapshot()).toMatchObject({ projectionKind: "code", generation: 1 })
      expect(code.search({ query: "one", limit: 10 }).hits).toHaveLength(1)
      expect(code.search({ query: "two", limit: 10 }).hits).toEqual([])
      expect(other.search({ query: "two", limit: 10 }).hits).toHaveLength(1)
      expect(documents.search({ query: "architecture", limit: 10 }).hits[0]?.document.anchor).toBe(
        "architecture-anchor",
      )

      expect(() =>
        documents.incrementalCommit({
          indexIncarnation: 1,
          fencingToken: 3,
          expectedGeneration: 1,
          indexedAt: 12,
          documents: [
            document("README.md", "Duplicate", "architecture-anchor", "duplicate anchor"),
            document("README.md", "Duplicate", "architecture-anchor", "duplicate anchor"),
          ],
          deletedPaths: [],
        }),
      ).toThrow()
      expect(documents.snapshot()).toEqual(documentRevision)
      expect(code.search({ query: "marker", limit: 10 }).hits).toHaveLength(1)
    } finally {
      code.close()
      documents.close()
      other.close()
    }
  })
})

function file(filePath: string, content: string) {
  const fileId = `file:${filePath}`
  const symbolName = content.match(/function\s+(\w+)/)?.[1]
  return {
    entity: {
      entityId: fileId,
      entityKind: "file" as const,
      stableKey: `file:${filePath}`,
      displayName: filePath,
      language: "typescript",
      filePath,
      identityStability: "durable" as const,
    },
    file: {
      entityId: fileId,
      path: filePath,
      language: "typescript",
      contentSha: Hash.sha256(content),
      semanticLevel: "semantic" as const,
      searchableText: content,
    },
    symbols: symbolName
      ? [
          {
            entity: {
              entityId: `symbol:${filePath}:${symbolName}`,
              entityKind: "symbol" as const,
              stableKey: `ts-v1:${filePath}:${symbolName}`,
              displayName: symbolName,
              language: "typescript",
              filePath,
              identityStability: "durable" as const,
            },
            symbol: {
              entityId: `symbol:${filePath}:${symbolName}`,
              owningEntityId: fileId,
              symbolPath: symbolName,
              kind: "function",
              startLine: 1,
              endLine: 1,
              signature: `function ${symbolName}()`,
            },
          },
        ]
      : [],
    edges: symbolName
      ? [
          {
            fromEntityId: fileId,
            toEntityId: `symbol:${filePath}:${symbolName}`,
            relation: "contains" as const,
            evidence: "parser",
          },
        ]
      : [],
  }
}

function document(filePath: string, headingPath: string, anchor: string, text: string) {
  return {
    documentId: `document:${filePath}:${anchor}`,
    path: filePath,
    contentSha: Hash.sha256(text),
    headingPath,
    anchor,
    startLine: 1,
    endLine: 2,
    searchableText: text,
  }
}
