import { describe, expect, test } from "bun:test"
import { ShellDialect } from "../../src/shell/dialect"

// D-W2 dialect compatibility matrix. Pure and cross-platform: win32 dialects are exercised by
// name so the rules are pinned everywhere, while the win32 CI runner covers real spawns.
describe("shell dialect", () => {
  test("maps shell names and paths to dialects on any host", () => {
    expect(ShellDialect.ofShellName("pwsh")).toBe("pwsh")
    expect(ShellDialect.ofShellName("pwsh.exe")).toBe("pwsh")
    expect(ShellDialect.ofShellName("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("pwsh")
    expect(ShellDialect.ofShellName("powershell")).toBe("powershell")
    expect(ShellDialect.ofShellName("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe("powershell")
    expect(ShellDialect.ofShellName("cmd")).toBe("cmd")
    expect(ShellDialect.ofShellName("C:\\Windows\\System32\\cmd.exe")).toBe("cmd")
    expect(ShellDialect.ofShellName("/bin/bash")).toBe("posix")
    expect(ShellDialect.ofShellName("C:\\Program Files\\Git\\bin\\bash.exe")).toBe("posix")
    expect(ShellDialect.ofShellName("/bin/zsh")).toBe("posix")
  })

  test("posix shells accept every script verbatim", () => {
    for (const script of [
      "FOO=bar bun run typecheck",
      "echo `date` | grep -E 'x|y' > out.txt 2>&1",
      "if [ -f x ]; then cat x; fi",
      "a && b || c; d &",
    ]) {
      expect(ShellDialect.checkPosixScript(script, "posix")).toEqual({ ok: true })
    }
  })

  describe("simple commands every win32 dialect accepts", () => {
    const cases = [
      "bun run typecheck",
      "npm test -- --watch=false",
      "python -m pytest tests -q",
      "git status | findstr /c:\"modified\"",
      "bun run build > build.log 2>&1",
      "echo \"hello world\"",
    ]
    for (const script of cases) {
      test(`${script} → pwsh/powershell/cmd`, () => {
        for (const dialect of ["pwsh", "powershell", "cmd"] as const) {
          const check = ShellDialect.checkPosixScript(script, dialect)
          expect(check.ok ? [] : check.issues).toEqual([])
        }
      })
    }
  })

  describe("pipeline family", () => {
    test("&& and || are fine on pwsh and cmd but rejected on Windows PowerShell 5.1", () => {
      const script = "bun install && bun run build"
      expect(ShellDialect.checkPosixScript(script, "pwsh")).toEqual({ ok: true })
      expect(ShellDialect.checkPosixScript(script, "cmd")).toEqual({ ok: true })
      const check = ShellDialect.checkPosixScript(script, "powershell")
      expect(check.ok).toBe(false)
      if (!check.ok) expect(check.issues.map((i) => i.rule)).toContain("pipeline")
    })

    test("background & and |& are rejected on pwsh and cmd", () => {
      for (const dialect of ["pwsh", "cmd"] as const) {
        expect(ShellDialect.checkPosixScript("sleep 5 &", dialect).ok).toBe(false)
        expect(ShellDialect.checkPosixScript("make build |& tee log", dialect).ok).toBe(false)
      }
    })

    test("; is rejected on cmd only", () => {
      expect(ShellDialect.checkPosixScript("a; b", "pwsh")).toEqual({ ok: true })
      expect(ShellDialect.checkPosixScript("a; b", "cmd").ok).toBe(false)
    })

    test("heredocs and stdin redirection fail closed", () => {
      expect(ShellDialect.checkPosixScript("cat <<EOF\nx\nEOF", "pwsh").ok).toBe(false)
      expect(ShellDialect.checkPosixScript("cmd < input.txt", "pwsh").ok).toBe(false)
      expect(ShellDialect.checkPosixScript("cmd < input.txt", "cmd")).toEqual({ ok: true })
    })

    test("control flow and POSIX builtins are rejected", () => {
      for (const script of ["if [ -f x ]; then cat x; fi", "for f in a b; do echo $f; done", "export FOO=1", "source env.sh"]) {
        const check = ShellDialect.checkPosixScript(script, "pwsh")
        expect(check.ok).toBe(false)
      }
    })
  })

  describe("env family", () => {
    test("leading inline env assignments are rejected on pwsh/cmd", () => {
      for (const dialect of ["pwsh", "powershell", "cmd"] as const) {
        const check = ShellDialect.checkPosixScript("NODE_ENV=test bun test", dialect)
        expect(check.ok).toBe(false)
        if (!check.ok) expect(check.issues.map((i) => i.rule)).toContain("env")
      }
    })

    test("quoted assignment-looking words are not env passing", () => {
      expect(ShellDialect.checkPosixScript("echo 'FOO=bar'", "pwsh")).toEqual({ ok: true })
    })
  })

  describe("quoting family", () => {
    test("$ expansion outside single quotes is rejected; single-quoted $ is literal and safe on PowerShell", () => {
      expect(ShellDialect.checkPosixScript("echo $HOME", "pwsh").ok).toBe(false)
      expect(ShellDialect.checkPosixScript("echo $(pwd)", "pwsh").ok).toBe(false)
      expect(ShellDialect.checkPosixScript("echo ${FOO:-bar}", "cmd").ok).toBe(false)
      expect(ShellDialect.checkPosixScript("echo '$HOME'", "pwsh")).toEqual({ ok: true })
    })

    test("backticks are command substitution in POSIX and escapes in PowerShell", () => {
      expect(ShellDialect.checkPosixScript("echo `date`", "pwsh").ok).toBe(false)
      expect(ShellDialect.checkPosixScript("echo `date`", "cmd").ok).toBe(false)
    })

    test("backslash escapes inside double quotes diverge", () => {
      expect(ShellDialect.checkPosixScript('echo "a\\"b"', "pwsh").ok).toBe(false)
      expect(ShellDialect.checkPosixScript('echo "a\\"b"', "cmd").ok).toBe(false)
    })

    test("cmd-only quoting traps: single quotes, %VAR%, tilde, switch-like paths", () => {
      expect(ShellDialect.checkPosixScript("grep 'a b' file", "cmd").ok).toBe(false)
      expect(ShellDialect.checkPosixScript("grep 'a b' file", "pwsh")).toEqual({ ok: true })
      expect(ShellDialect.checkPosixScript("echo 100% coverage", "cmd")).toEqual({ ok: true })
      expect(ShellDialect.checkPosixScript("echo %PATH%", "cmd").ok).toBe(false)
      expect(ShellDialect.checkPosixScript("cd ~/repo", "cmd").ok).toBe(false)
      expect(ShellDialect.checkPosixScript("ls /tmp", "cmd").ok).toBe(false)
    })

    test("PowerShell rejects POSIX absolute paths but cmd's switch rule already covers them", () => {
      expect(ShellDialect.checkPosixScript("cat /dev/null", "pwsh").ok).toBe(false)
      expect(ShellDialect.checkPosixScript("cat /dev/null", "cmd").ok).toBe(false)
    })
  })
})
