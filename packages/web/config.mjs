const stage = process.env.SST_STAGE || "dev"

export default {
  url: stage === "production" ? "https://deepagent-code.ai" : `https://${stage}.deepagent-code.ai`,
  console: stage === "production" ? "https://deepagent-code.ai/auth" : `https://${stage}.deepagent-code.ai/auth`,
  email: "contact@anoma.ly",
  socialCard: "https://social-cards.sst.dev",
  github: "https://github.com/lessweb/deepagent-code",
  discord: "https://deepagent-code.ai/discord",
  headerLinks: [
    { name: "app.header.home", url: "/" },
    { name: "app.header.docs", url: "/docs/" },
  ],
}
