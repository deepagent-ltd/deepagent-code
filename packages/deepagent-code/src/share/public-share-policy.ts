// Public links remain disabled by default. A configured host or legacy share URL alone must never
// enable uploads; the explicit opt-in is only for tests and future rollout.
export const publicSharingEnabled = () =>
  process.env.DEEPAGENT_CODE_ENABLE_PUBLIC_SHARING === "1" &&
  process.env.DEEPAGENT_CODE_DISABLE_SHARE !== "1" &&
  process.env.DEEPAGENT_CODE_DISABLE_SHARE !== "true"
