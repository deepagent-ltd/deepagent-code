export const domain = (() => {
  if ($app.stage === "production") return "deepagent-code.ai"
  if ($app.stage === "dev") return "dev.deepagent-code.ai"
  return `${$app.stage}.dev.deepagent-code.ai`
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
