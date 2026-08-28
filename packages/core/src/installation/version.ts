declare global {
  const DEEPAGENT_CODE_VERSION: string
  const DEEPAGENT_CODE_CHANNEL: string
  const DEEPAGENT_CODE_COMMIT: string
}

export const InstallationVersion = typeof DEEPAGENT_CODE_VERSION === "string" ? DEEPAGENT_CODE_VERSION : "local"
export const InstallationChannel = typeof DEEPAGENT_CODE_CHANNEL === "string" ? DEEPAGENT_CODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
export const InstallationCommit = typeof DEEPAGENT_CODE_COMMIT === "string" ? DEEPAGENT_CODE_COMMIT : undefined
