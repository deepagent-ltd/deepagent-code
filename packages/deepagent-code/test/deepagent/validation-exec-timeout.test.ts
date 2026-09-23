import { describe, expect, test } from "bun:test"
import { runValidationCommands, validationInvocation, type ShellProbe } from "../../src/deepagent/validation-exec"

// V3.2 P2-5 regression guard: a validation command that never exits must NOT hang the runner.
// The timeout sentinel must kill the process and resolve to a failed ValidationResult within
// roughly the timeout window.
describe("V3.2 validation-exec timeout", () => {
  test("a non-exiting command resolves to a failed result near the timeout", async () => {
    const started = Date.now()
    const results = await runValidationCommands(["sleep 30"], process.cwd(), 300)
    const elapsed = Date.now() - started
    expect(results).toHaveLength(1)
    expect(results[0]!.passed).toBe(false)
    expect(results[0]!.kind).toBe("timeout")
    // resolved promptly (well before the 30s sleep), not hung
    expect(elapsed).toBeLessThan(5000)
  })

  test("a fast successful command still passes", async () => {
    const results = await runValidationCommands(["true"], process.cwd(), 5000)
    expect(results[0]!.passed).toBe(true)
  })

  test("structured argv commands do not require a shell", () => {
    expect(
      validationInvocation(
        {
          id: "test:argv",
          source: "user",
          transport: "argv",
          executable: process.execPath,
          args: ["-e", "process.exit(0)"],
          display: "bun -e pass",
        },
        process.cwd(),
      ),
    ).toEqual({ argv: [process.execPath, "-e", "process.exit(0)"] })
  })

  test("classifies a missing executable as one typed bootstrap failure", async () => {
    const executable = `missing-validation-executable-${Date.now()}`
    const results = await runValidationCommands(
      [
        {
          id: "test:missing",
          source: "user",
          transport: "argv",
          executable,
          args: [],
          display: executable,
        },
      ],
      process.cwd(),
      5000,
    )

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      passed: false,
      kind: "shell_bootstrap_failed",
      exit_code: -1,
      command: executable,
    })
    expect(results[0]!.output).toContain(`validation process bootstrap failed (${executable})`)
  })

  test("keeps a command's deliberate exit 127 distinct from runner bootstrap failure", async () => {
    const results = await runValidationCommands(["exit 127"], process.cwd(), 5000)
    expect(results[0]).toMatchObject({ passed: false, kind: "command_exit", exit_code: 127 })
  })

  // D-W2 win32 shell selection is pinned on any host by injecting the platform and shell probes;
  // validationInvocation is pure selection logic and never spawns.
  describe("win32 posix-script shell selection (D-W2)", () => {
    const win32 = { platform: "win32" as const, release: "10.0.26100", env: {} }
    const probe = (over: Partial<ShellProbe>): ShellProbe => ({
      gitbash: () => undefined,
      win: () => [],
      acceptable: () => "/bin/sh",
      ...over,
    })

    test("Git Bash runs POSIX scripts verbatim", () => {
      const invocation = validationInvocation("bun test", "C:\\repo", {
        ...win32,
        probe: probe({ gitbash: () => "C:\\Program Files\\Git\\bin\\bash.exe" }),
      })
      expect(invocation).toEqual({
        argv: expect.arrayContaining(["C:\\Program Files\\Git\\bin\\bash.exe"]),
      })
      expect("argv" in invocation && invocation.argv[0]).toBe("C:\\Program Files\\Git\\bin\\bash.exe")
    })

    test("a posix shell inside the win() chain accepts the script verbatim", () => {
      const invocation = validationInvocation("bun test", "C:\\repo", {
        ...win32,
        probe: probe({ win: () => ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Windows\\System32\\cmd.exe"] }),
      })
      expect("argv" in invocation && invocation.argv[0]).toBe("C:\\Program Files\\Git\\bin\\bash.exe")
    })

    test("pwsh runs a dialect-compatible script", () => {
      const invocation = validationInvocation("bun test", "C:\\repo", {
        ...win32,
        probe: probe({ win: () => ["C:\\Program Files\\PowerShell\\7\\pwsh.exe"] }),
      })
      expect("argv" in invocation && invocation.argv[0]).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
    })

    test("Windows PowerShell rejects && so the chain falls through to cmd", () => {
      const invocation = validationInvocation("bun run build && bun test", "C:\\repo", {
        ...win32,
        probe: probe({
          win: () => ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "C:\\Windows\\System32\\cmd.exe"],
        }),
      })
      expect("argv" in invocation && invocation.argv[0]).toBe("C:\\Windows\\System32\\cmd.exe")
    })

    test("a script no available shell can express fails closed as unsupported_dialect", () => {
      const invocation = validationInvocation("grep 'foo bar' -r .", "C:\\repo", {
        ...win32,
        probe: probe({ win: () => ["C:\\Windows\\System32\\cmd.exe"] }),
      })
      expect(invocation).toMatchObject({ kind: "unsupported_dialect" })
      expect("detail" in invocation && invocation.detail).toContain("Install Git Bash")
    })

    test("an explicitly configured shell still has to express the script's dialect", () => {
      const rejected = validationInvocation("echo $HOME", "C:\\repo", {
        ...win32,
        shell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      })
      expect(rejected).toMatchObject({ kind: "unsupported_dialect" })

      const accepted = validationInvocation("echo $HOME", "C:\\repo", { ...win32, shell: "C:\\Program Files\\Git\\bin\\bash.exe" })
      expect("argv" in accepted && accepted.argv[0]).toBe("C:\\Program Files\\Git\\bin\\bash.exe")
    })
  })

  test("WSL1 is rejected while WSL2 uses the normal Linux runner", async () => {
    const wsl1 = await runValidationCommands(["exit 0"], process.cwd(), 5000, {
      platform: "linux",
      release: "4.4.0-19041-Microsoft",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
    })
    expect(wsl1[0]).toMatchObject({ passed: false, kind: "unsupported_platform" })
    expect(wsl1[0]!.output).toContain("WSL1")

    const wsl2 = await runValidationCommands(["exit 0"], process.cwd(), 5000, {
      platform: "linux",
      release: "6.6.87.2-microsoft-standard-WSL2",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
    })
    expect(wsl2[0]).toMatchObject({ passed: true, kind: "command_exit", exit_code: 0 })
  })
})
