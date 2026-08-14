import { existsSync, writeFileSync } from "node:fs"
import { DocumentConflictError, DocumentStore } from "../../src/deepagent/document-store"

const [root, id, body, ready, start] = Bun.argv.slice(2)
if (!root || !id || !body || !ready || !start) throw new Error("document-store-writer: missing argument")

const store = new DocumentStore(root)
writeFileSync(ready, "ready")
while (!existsSync(start)) await Bun.sleep(1)

try {
  const doc = store.update(id, body)
  console.log(JSON.stringify({ outcome: "committed", version: doc.version, hash: doc.hash }))
} catch (error) {
  if (!(error instanceof DocumentConflictError)) throw error
  console.log(JSON.stringify({ outcome: "conflict", version: error.version }))
  process.exitCode = 17
}
