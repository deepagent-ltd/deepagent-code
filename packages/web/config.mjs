const stage = process.env.SST_STAGE || "dev"

export default {
  url: stage === "production" ? "https://ai.deepagent.ltd" : `https://${stage}.ai.deepagent.ltd`,
  console: stage === "production" ? "https://ai.deepagent.ltd/auth" : `https://${stage}.ai.deepagent.ltd/auth`,
  email: "contact@anoma.ly",
  socialCard: "https://social-cards.sst.dev",
  github: "https://github.com/deepagent-ltd/deepagent-code",
  discord: "https://ai.deepagent.ltd/discord",
  headerLinks: [
    { name: "app.header.home", url: "/" },
    { name: "app.header.docs", url: "/docs/" },
  ],
}
