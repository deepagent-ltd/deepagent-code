import { openUserGlobalStore } from "../../src/deepagent/durable-knowledge-store"
import { DeepAgentReleasedSnapshot, type Selection } from "../../src/deepagent/released-snapshot"
import { Hash } from "../../src/util/hash"

const releasedTypes = new Set(["knowledge", "strategy", "methodology", "memory", "skill"])

export function releasedUserGlobalSelection(baseDir: string): Selection {
  const store = openUserGlobalStore(baseDir).documentStore
  const documents = DeepAgentReleasedSnapshot.normalizeDocumentRefs(
    store
      .list({ status: "active" })
      .filter((document) => releasedTypes.has(document.type))
      .map((document) => store.get(document.id, document.version))
      .filter((document) => document !== null)
      .map((document) => DeepAgentReleasedSnapshot.documentRef(document, "user_global")),
  )
  return {
    snapshotId: "test-user-global-release",
    securityNamespaceId: "test-user-global-namespace",
    projectScopeKey: "test-user-global-project",
    legacyProjectId: "global",
    parentSnapshotId: null,
    generation: 1,
    membershipHash: DeepAgentReleasedSnapshot.exactRefsFingerprint(documents),
    manifestHash: Hash.sha256(`test-user-global-release:${documents.length}`),
    documents,
  }
}
