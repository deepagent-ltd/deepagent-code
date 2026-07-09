/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "deepagent-code",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "cloudflare",
      providers: {
        aws: {
          version: "7.30.0",
          region: "us-east-1",
          profile: process.env.GITHUB_ACTIONS
            ? undefined
            : input.stage === "production"
              ? "deepagent-code-production"
              : "deepagent-code-dev",
        },
        random: "4.19.2",
      },
    }
  },
  async run() {
    const stage = await import("./infra/stage.js")
    await import("./infra/app.js")

    return {
      AwsStage: stage.awsStage,
    }
  },
})
