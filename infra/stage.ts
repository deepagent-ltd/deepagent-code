export const domain = (() => {
  if ($app.stage === "production") return "ai.deepagent.ltd"
  if ($app.stage === "dev") return "dev.ai.deepagent.ltd"
  return `${$app.stage}.dev.ai.deepagent.ltd`
})()

export const zoneID = "430ba34c138cfb5360826c4909f99be8"
export const awsStage = $app.stage === "production" ? "production" : "dev"
export const deployAws = $app.stage === awsStage

// Local deployment only — no Cloudflare DNS/hostname resources to provision.

export const shortDomain = (() => {
  if ($app.stage === "production") return "opncd.ai"
  if ($app.stage === "dev") return "dev.opncd.ai"
  return `${$app.stage}.dev.opncd.ai`
})()
