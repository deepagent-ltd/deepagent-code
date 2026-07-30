import { chmod, mkdir, readlink, realpath, symlink } from "node:fs/promises"
import path from "node:path"

export type ToolSandbox = {
  shell: string
  verifier: string
  evidence: {
    platform: string
    profileHash: string
    allowedWrite: boolean
    hostReadDenied: boolean
    systemHostReadDenied: boolean
    hostWriteDenied: boolean
    networkDenied: boolean
    symlinkReadDenied: boolean
    symlinkWriteDenied: boolean
    verifierExecutable: boolean
    verifierWriteDenied: boolean
    environmentKeys: string[]
  }
}

export async function prepareToolSandbox(input: {
  workspace: string
  testRoot: string
  verifierScript?: string
  additionalWorkspaceRoots?: string[]
}): Promise<ToolSandbox> {
  if (process.platform !== "darwin") {
    throw new Error(`No qualified live LLM tool sandbox is implemented for ${process.platform}`)
  }
  if (!(await Bun.file("/usr/bin/sandbox-exec").exists())) {
    throw new Error("macOS live LLM Bash suites require /usr/bin/sandbox-exec")
  }

  const workspace = await realpath(input.workspace)
  const workspaceRoots = [
    workspace,
    ...(await Promise.all((input.additionalWorkspaceRoots ?? []).map((root) => realpath(root)))),
  ]
  const testRoot = await realpath(input.testRoot)
  const harness = path.join(workspace, ".live-llm-harness")
  const sandboxHome = path.join(harness, "home")
  const sandboxTmp = path.join(harness, "tmp")
  const oracle = path.join(harness, "oracle")
  const profile = path.join(harness, "tool.sb")
  const shell = path.join(harness, "sandbox-shell")
  const verifier = path.join(oracle, "verify")
  const hostCanary = path.join(testRoot, "host-canary")
  const allowed = path.join(workspace, "sandbox-allowed")
  const escape = path.join(workspace, "sandbox-escape")
  const verifierLink = path.join(workspace, "verify")
  const canary = `host-${crypto.randomUUID()}`
  const verifierMarker = `verify-${crypto.randomUUID()}`

  await Promise.all([
    mkdir(sandboxHome, { recursive: true }),
    mkdir(sandboxTmp, { recursive: true }),
    mkdir(oracle, { recursive: true }),
  ])
  await Bun.write(hostCanary, `${canary}\n`)
  await Bun.write(verifier, `#!/bin/sh\nprintf '%s\\n' ${quote(verifierMarker)}\n`)
  await chmod(verifier, 0o555)
  await Promise.all([symlink(hostCanary, escape), symlink(verifier, verifierLink)])
  const policy = macOSPolicy({ workspaceRoots, sandboxHome, sandboxTmp, oracle })
  await Bun.write(profile, policy)
  await Bun.write(
    shell,
    [
      "#!/bin/sh",
      `exec /usr/bin/env -i HOME=${quote(sandboxHome)} TMPDIR=${quote(`${sandboxTmp}/`)} PATH=/usr/bin:/bin LANG=C.UTF-8 ` +
        `/usr/bin/sandbox-exec -f ${quote(profile)} /bin/sh "$@"`,
      "",
    ].join("\n"),
  )
  await chmod(shell, 0o555)

  const allowedWrite = await command(shell, `printf allowed > ${quote(allowed)}`, workspace)
  const hostRead = await command(shell, `cat ${quote(hostCanary)} >/dev/null`, workspace)
  const hostWrite = await command(shell, `printf changed > ${quote(hostCanary)}`, workspace)
  const symlinkRead = await command(shell, `cat ${quote(escape)} >/dev/null`, workspace)
  const symlinkWrite = await command(shell, `printf changed > ${quote(escape)}`, workspace)
  const verifierRun = await command(shell, `${quote(verifierLink)} >/dev/null`, workspace)
  const verifierWrite = await command(shell, `printf changed > ${quote(verifierLink)}`, workspace)
  const systemHostRead = await command(shell, "cat /etc/hosts >/dev/null", workspace)
  const environmentIsolated = await command(
    shell,
    `[ "$HOME" = ${quote(sandboxHome)} ] && [ "$TMPDIR" = ${quote(`${sandboxTmp}/`)} ] && ` +
      '[ "$PATH" = "/usr/bin:/bin" ] && [ "$LANG" = "C.UTF-8" ] && [ -z "${SSH_AUTH_SOCK+x}" ]',
    workspace,
  )
  const environmentProcess = Bun.spawn([shell, "-c", "/usr/bin/env"], {
    cwd: workspace,
    stdout: "pipe",
    stderr: "ignore",
  })
  const [environmentText, environmentExitCode] = await Promise.all([
    new Response(environmentProcess.stdout).text(),
    environmentProcess.exited,
  ])
  const environmentKeys = environmentText
    .split("\n")
    .flatMap((line) => {
      const separator = line.indexOf("=")
      return separator > 0 ? [line.slice(0, separator)] : []
    })
    .toSorted()
  const expectedEnvironmentKeys = ["HOME", "LANG", "PATH", "PWD", "SHLVL", "TMPDIR", "_"]
  const server = Bun.serve({ port: 0, fetch: () => new Response("reachable") })
  const network = await command(
    shell,
    `/usr/bin/curl --silent --show-error --max-time 1 http://127.0.0.1:${server.port}/`,
    workspace,
  )
  server.stop(true)

  if (!allowedWrite || (await Bun.file(allowed).text()) !== "allowed") {
    throw new Error("Sandbox conformance failed: workspace write was not allowed")
  }
  if (hostRead || systemHostRead || (await Bun.file(hostCanary).text()) !== `${canary}\n`) {
    throw new Error("Sandbox conformance failed: host canary read/write boundary")
  }
  if (hostWrite || symlinkRead || symlinkWrite) {
    throw new Error("Sandbox conformance failed: host or symlink escape was allowed")
  }
  if (!verifierRun || verifierWrite || (await Bun.file(verifier).text()).includes("changed")) {
    throw new Error("Sandbox conformance failed: verifier execution/write boundary")
  }
  if (network) throw new Error("Sandbox conformance failed: loopback network was reachable")
  if ((await readlink(escape)) !== hostCanary) throw new Error("Sandbox conformance fixture symlink changed unexpectedly")
  if (
    !environmentIsolated ||
    environmentExitCode !== 0 ||
    environmentKeys.join("\0") !== expectedEnvironmentKeys.join("\0")
  ) {
    throw new Error(`Sandbox conformance failed: environment keys were ${environmentKeys.join(", ")}`)
  }
  if (input.verifierScript) {
    await chmod(verifier, 0o755)
    await Bun.write(verifier, input.verifierScript)
    await chmod(verifier, 0o555)
  }

  return {
    shell,
    verifier: "./verify",
    evidence: {
      platform: `darwin-${process.arch}`,
      profileHash: Bun.hash(policy).toString(16),
      allowedWrite: true,
      hostReadDenied: true,
      systemHostReadDenied: true,
      hostWriteDenied: true,
      networkDenied: true,
      symlinkReadDenied: true,
      symlinkWriteDenied: true,
      verifierExecutable: true,
      verifierWriteDenied: true,
      environmentKeys,
    },
  }
}

function macOSPolicy(input: {
  workspaceRoots: string[]
  sandboxHome: string
  sandboxTmp: string
  oracle: string
}) {
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read-metadata)",
    '(allow file-read* (literal "/"))',
    '(allow file-read* file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/urandom") (literal "/dev/random"))',
    '(allow file-read-data file-write-data file-test-existence (subpath "/dev/fd"))',
    '(allow file-read* file-map-executable (subpath "/System") (subpath "/bin") (subpath "/sbin"))',
    '(allow file-read* (subpath "/usr/bin") (subpath "/usr/lib") (subpath "/usr/libexec") (subpath "/usr/share"))',
    '(allow file-map-executable (subpath "/usr/bin") (subpath "/usr/lib") (subpath "/usr/libexec"))',
    '(allow file-read* file-map-executable (subpath "/Applications/Xcode.app/Contents/Developer") (subpath "/Library/Developer"))',
    '(allow file-read* file-map-executable (subpath "/Library/Apple") (subpath "/Library/Preferences/Logging"))',
    '(allow file-read* (literal "/private/etc/localtime") (subpath "/private/var/db/timezone"))',
    '(allow file-read* (literal "/private/var/db/DarwinDirectory/local/recordStore.data"))',
    '(allow file-read* (subpath "/private/var/select"))',
    ...input.workspaceRoots.map(
      (workspace) => `(allow file-read* file-map-executable (subpath ${scheme(workspace)}))`,
    ),
    `(allow file-read* file-write* (subpath ${scheme(input.sandboxHome)}) (subpath ${scheme(input.sandboxTmp)}))`,
    ...input.workspaceRoots.map((workspace) => `(allow file-write* (subpath ${scheme(workspace)}))`),
    `(deny file-write* (subpath ${scheme(input.oracle)}))`,
    "(deny network*)",
    "",
  ].join("\n")
}

function scheme(value: string) {
  return JSON.stringify(value)
}

function quote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

async function command(shell: string, command: string, cwd: string) {
  const process = Bun.spawn([shell, "-c", command], { cwd, stdout: "ignore", stderr: "ignore" })
  return (await process.exited) === 0
}
