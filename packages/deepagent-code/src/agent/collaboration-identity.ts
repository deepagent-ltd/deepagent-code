import type { Git } from "@/git"

export const DEFAULT_WORKER_IDENTITY = {
  name: "coauthor-deepagent",
  email: "coauthor@deepagent.ltd",
} as const satisfies Git.CommitIdentity
