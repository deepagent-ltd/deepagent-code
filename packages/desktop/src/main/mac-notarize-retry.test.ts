import { expect, test } from "bun:test"
import { createRequire } from "node:module"
import path from "node:path"

const desktop = createRequire(path.resolve(import.meta.dir, "../../package.json"))
const builder = createRequire(desktop.resolve("electron-builder"))
const library = createRequire(builder.resolve("app-builder-lib")).resolve("@electron/notarize")

// Execute the actual locked patch in a child process. Only Apple's external
// signature/submission/stapler boundary is fault-injected; retry logic is real.
for (const group of ["transient-ticket", "unavailable-ticket", "invalid-ticket", "rejected-submission"]) {
  test(`macOS notarization: ${group} never resubmits or bypasses failures`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
        const { createRequire } = require("node:module");
        const requireNotary = createRequire(${JSON.stringify(library)});
        const facts = { signatures: 0, submissions: 0, staples: 0, failed: false };
        const group = ${JSON.stringify(group)};
        const signature = requireNotary("./check-signature");
        const notary = requireNotary("./notarytool");
        const staple = requireNotary("./staple");
        signature.checkSignatures = async () => { facts.signatures++; };
        notary.isNotaryToolAvailable = async () => true;
        notary.notarizeAndWaitForNotaryTool = async () => {
          facts.submissions++;
          if (group === "rejected-submission") throw new Error("Notarization rejected");
        };
        staple.stapleApp = async () => {
          facts.staples++;
          if (group === "invalid-ticket") throw new Error("Failed to staple your application with code: 65");
          if (group === "unavailable-ticket" || facts.staples < 3)
            throw new Error("Failed to staple your application with code: 68\\nThe network connection was lost");
        };
        require(${JSON.stringify(library)}).notarize({ appPath: "/fixture/DAC.app" })
          .catch(() => { facts.failed = true; })
          .then(() => console.log(JSON.stringify(facts)));
      `,
      ],
      { env: {}, stdout: "pipe", stderr: "pipe" },
    )
    const output = (await new Response(child.stdout).json()) as {
      signatures: number
      submissions: number
      staples: number
      failed: boolean
    }
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stderr).text()).toBe("")
    expect(output.signatures).toBe(1)
    expect(output.submissions).toBe(1)
    expect(output.staples).toBe(
      group === "transient-ticket" ? 3 : group === "unavailable-ticket" ? 4 : group === "invalid-ticket" ? 1 : 0,
    )
    expect(output.failed).toBe(group !== "transient-ticket")
  }, 15000)
}
