import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const command of [["run", "build:pb"], ["run", "release:es:min"]]) {
  const result = spawnSync("npm", command, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const output = path.join(root, "dist/dac-reader");
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, "index.js"), readFileSync(path.join(root, "dist/juggleim-es-min-1.9.17.js")));
writeFileSync(path.join(output, "index.d.ts"), readFileSync(path.join(root, "src/index.d.ts")));
// Private build only; final package metadata and license/banner adoption is root-owned.
writeFileSync(path.join(output, "build-manifest.json"), JSON.stringify({ privateCandidate: true,
  sourceCommit: "f69cbe450fc79fceac7ae24a54baee57f9b1a5c3", files: ["index.js", "index.d.ts"].map(name => {
    const bytes = readFileSync(path.join(output, name));
    return { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }) }, null, 2) + "\n");
