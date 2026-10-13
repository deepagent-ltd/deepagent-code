import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

for (const mode of ["remove", "metadata"])
  test(mode === "remove"
    ? "explicit MCP configuration DELETE uses original close and JSONC transaction, retaining unknown clients"
    : "missing observed MCP display metadata omits only that server without RPC or command list failure", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-mcp-delete-http-")))
  await Promise.all(["home", "tmp", "config", "data", "cache", "state", "project"].map((name) =>
    fs.mkdir(path.join(root, name), { mode: 0o700 })))
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture/mcp-config-delete-http.ts"), root, mode], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: process.env.HOME,
      TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"),
      XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
      DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"), DEEPAGENT_CODE_HOME: path.join(root, "data"),
      DEEPAGENT_CODE_DB: path.join(root, "authority.sqlite"),
      DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
      DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1", DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS: "1",
      DEEPAGENT_CODE_DISABLE_AUTOUPDATE: "1", DEEPAGENT_CODE_SERVER_PASSWORD: "owned-mcp-config-delete-password",
      DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "1", DEEPAGENT_IM_AGENT_RESPONDER: "off", NO_COLOR: "1",
    },
    stdout: "pipe", stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000)
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    await fs.writeFile(path.join(root, "child-private.log"), stdout + stderr, { flag: "wx", mode: 0o600 })
    console.info("MCP_CONFIG_DELETE_HTTP_EVIDENCE", root)
    if (process.env.DEEPAGENT_TEST_MCP_CONFIG_DELETE_EVIDENCE)
      await fs.writeFile(`${process.env.DEEPAGENT_TEST_MCP_CONFIG_DELETE_EVIDENCE}.${mode}.json`, JSON.stringify({ root, status, childPID: child.pid }) + "\n", { flag: "wx", mode: 0o600 })
    expect(status).toBe(0)
    const result = await Bun.file(path.join(root, "result-safe.json")).json()
    if (mode === "metadata") {
      expect(result).toMatchObject({ mode, connectedOriginalClient: true, missingObservationPromptsAndResourcesEmpty: true,
        ordinaryCommandListHTTP200: true, readonlyRpcDelta: 0, promptLists: 0, resourceLists: 0, tools: 0, modelCalls: 0 })
      return
    }
    expect(result).toMatchObject({
      actualRoot: true, actualNodeHttp: true, originalSDK: true, explicitASTDelete: true,
      commentAndSiblingPreserved: true, settingsAndAuthBytesPreserved: true, originalPartialPatchPreserved: true,
      exactCompletedRetry: true, coldRead: true, unknownCloseRetainedOriginalClientAndConfig: true,
      unknownToolsAndReadDenied: true, explicitRetryUsedSameOriginalClient: true,
      readonlySourcesRefused: ["project", "managed", "remote"],
      survivingRemoteDefinitionReportedChanged: true, tools: 0, resourceReads: 0, modelCalls: 0,
      physicalProcessRetirementClaimed: false,
    })
    expect(result.failures.map((item: { status: number }) => item.status)).toEqual([401, 401, 409, 409, 409, 409, 409])
    expect(stdout).not.toContain("owned-mcp-config-delete-password")
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
  }
}, 70_000)
