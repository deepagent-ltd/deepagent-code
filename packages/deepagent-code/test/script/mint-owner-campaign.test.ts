import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { V2ProviderTurn } from "@deepagent-code/core/session/runner/v2-provider-turn"

test("--dev mint prints the complete source-run owner environment", () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-dev-mint-"))
  try {
    const db = join(dir, "owner.db")
    const campaign = "dev-campaign"
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        join(import.meta.dir, "../../script/mint-owner-campaign.ts"),
        "--dev",
        "--build-identity",
        "local",
        "--campaign",
        campaign,
        "--db",
        db,
      ],
      cwd: join(import.meta.dir, "../.."),
      env: { ...process.env, DEEPAGENT_CODE_OWNER_SIGNING_KEY: "" },
    })
    expect(result.exitCode).toBe(0)
    const output = JSON.parse(result.stdout.toString()) as { public_key_pem: string; campaign_id: string }
    const stderr = result.stderr.toString()
    expect(output.campaign_id).toBe(campaign)
    expect(stderr).toContain(`export DEEPAGENT_CODE_V2_OWNER_CAMPAIGN='${campaign}'`)
    expect(stderr).toContain(
      `export DEEPAGENT_CODE_V2_BUILD_IDENTITY='${JSON.stringify(V2ProviderTurn.buildIdentityFromVersion("local"))}'`,
    )
    expect(stderr).toContain(`export DEEPAGENT_CODE_V2_OWNER_AUTHORIZATION_PUBLIC_KEY='${output.public_key_pem}'`)
    expect(stderr).toContain(`export DEEPAGENT_CODE_DB='${db}'`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
