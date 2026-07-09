/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "deepagent-code",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      // Local deployment only — state lives on disk, no Cloudflare/AWS backend.
      home: "local",
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
