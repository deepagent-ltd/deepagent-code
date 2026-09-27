// Public links are deferred to 2.0.3. A configured host or legacy share URL alone must never
// enable uploads in a 2.0.2 installation; the explicit opt-in is only for tests and future rollout.
export const publicSharingEnabled = () =>
  process.env.DEEPAGENT_CODE_ENABLE_PUBLIC_SHARING === "1" &&
  process.env.DEEPAGENT_CODE_DISABLE_SHARE !== "1" &&
  process.env.DEEPAGENT_CODE_DISABLE_SHARE !== "true"
